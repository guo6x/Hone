/**
 * Hone Gateway Daemon — L1 24/7 process.
 *
 * Responsibilities:
 * - Maintain WebSocket connection to Cloudflare Relay
 * - Handle incoming client messages (intent classification → reply/dispatch/schedule)
 * - Manage scheduled tasks (cron-based triggers)
 * - Device pairing approval flow
 *
 * Architecture: Gateway is brain, CLI is muscle. Gateway never touches files.
 */
import { randomUUID } from 'crypto'
import { getProvider, type ProviderResponse } from '../services/providers/index.js'
import type { ScheduleEntry, GatewayContext } from './tools.js'
import { getGatewayTools } from './tools.js'
import { createScheduler, stopScheduler, loadSchedules, saveSchedules } from './scheduler.js'
import { gatewayLLM } from './llm.js'
import { getPatternSuggestions, type ActivityLogEntry } from './pattern-learner.js'
import { createBrowserAgent, type ConfirmCallback, type StepCallback } from './browser/agent.js'
import type { BrowserAgent } from './browser/types.js'
import { recordMessage, startRun, finishRun, markScheduleAgentCreated, listAgentSchedules, getScheduleRuns, getAgentScheduleInfo, getRecentMessages, listTrackedItems, recordObservation, upsertTrackedItem } from './storage.js'
import { tryStockIntent } from './intent/stock-intent.js'
import { fetchStockQuotes } from './datasources/stock-cn.js'
import { tryAutoExecute, listBrokerAdapters } from './brokers/adapter.js'

const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 10

export interface GatewayConfig {
  relayUrl: string
  machineName: string
  machineId: string
  repo?: string
  branch?: string
  authToken?: string
  verbose?: boolean
}

export interface GatewayState {
  config: GatewayConfig
  ws: WebSocket | null
  connected: boolean
  schedules: Map<string, ScheduleEntry>
  clients: Map<string, ClientInfo>
  pendingConfirmations: Map<string, { description: string; resolve: (approved: boolean) => void }>
  pendingPairings: Map<string, { clientId: string; code: string; resolve: (approved: boolean) => void }>
  reconnectAttempts: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  schedulerState: ReturnType<typeof createScheduler> | null
  patternTimer: ReturnType<typeof setInterval> | null
  running: boolean
  browserAgent: BrowserAgent | null
}

interface ClientInfo {
  id: string
  connectedAt: number
  lastSeen: number
}

function log(config: GatewayConfig, msg: string): void {
  if (config.verbose) {
    console.error(`[Gateway] ${msg}`)
  }
}

// Audit logging: write web_task events to ~/.hone/logs/YYYY-MM-DD.json
async function logActivity(type: ActivityLogEntry['type'], detail: string): Promise<void> {
  try {
    const { writeFile, mkdir, readFile } = await import('fs/promises')
    const { join } = await import('path')
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const logDir = join(home, '.hone', 'logs')
    await mkdir(logDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    const logFile = join(logDir, `${today}.json`)

    let entries: ActivityLogEntry[] = []
    try {
      entries = JSON.parse(await readFile(logFile, 'utf-8'))
    } catch {}

    entries.push({ ts: Date.now(), type, detail })
    await writeFile(logFile, JSON.stringify(entries))
  } catch {}
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function createGatewayContext(state: GatewayState): GatewayContext {
  return {
    schedules: state.schedules,
    pendingPairings: state.pendingPairings,
    browserAgent: state.browserAgent,
    persistSchedules: () => saveSchedules(state.schedules),
    dispatchTask: async (task: string) => {
      // Dispatch to CLI: send a message via relay that triggers local CLI execution
      // For now, we signal via a message that any connected CLI would pick up
      const taskId = `task_${Date.now()}`
      log(state.config, `Dispatching task: ${task}`)

      // In the future, this would spawn a CLI process or signal a running CLI
      // For MVP, we return the task for manual handling via connected clients
      broadcast(state, {
        type: 'task_dispatched',
        taskId,
        task,
        machineId: state.config.machineId,
        machineName: state.config.machineName,
        ts: new Date().toISOString(),
      })

      try {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)

        const nodePath = process.execPath
        const cliScript = process.argv[1]
        // cwd is the hone project root (parent of dist/cli.js)
        const cwd = cliScript.replace(/[/\\][^/\\]+[/\\][^/\\]+$/, '')

        const { stdout, stderr } = await execFileAsync(nodePath, [cliScript, '-p', task], {
          timeout: 5 * 60 * 1000, // 5-minute timeout to prevent permanent hang
          cwd,
        })
        return stdout || stderr || '执行完毕'
      } catch (err: any) {
        if (err.killed && err.signal === 'SIGTERM') {
          return `CLI 任务超时 (5分钟)`
        }
        return `CLI 任务执行失败: ${err.message || err}`
      }
    },
    sendNotification: (msg: string) => {
      broadcast(state, {
        type: 'notification',
        message: msg,
        ts: new Date().toISOString(),
      })
    },
  }
}

function broadcast(state: GatewayState, msg: unknown): void {
  if (state.ws && state.ws.readyState === 1) { // 1 = OPEN
    sendJSON(state.ws, msg)
  }
}

function broadcastBuddyEvent(state: GatewayState, event: string, text?: string, data?: any): void {
  if (!state.ws) return;
  broadcast(state, {
    type: 'buddy_event',
    event,
    payload: { text, data },
    ts: new Date().toISOString(),
  })
}

export async function startGateway(config: GatewayConfig): Promise<GatewayState> {
  const state: GatewayState = {
    config,
    ws: null,
    connected: false,
    schedules: loadSchedules(),
    clients: new Map(),
    pendingConfirmations: new Map(),
    pendingPairings: new Map(),
    reconnectAttempts: 0,
    heartbeatTimer: null,
    schedulerState: null,
    patternTimer: null,
    running: true,
    browserAgent: null, // set below after callbacks are created
  }

  // Initialize browser agent (null if HONE_BROWSER_ENABLED !== 'true')
  const onConfirm: ConfirmCallback = async (taskId, description) => {
    return new Promise((resolve) => {
      state.pendingConfirmations.set(taskId, { description, resolve })
      broadcast(state, {
        type: 'browser_confirm_required',
        taskId,
        description,
        ts: new Date().toISOString(),
      })
      setTimeout(() => {
        if (state.pendingConfirmations.has(taskId)) {
          state.pendingConfirmations.delete(taskId)
          resolve(false)
        }
      }, 60_000)
    })
  }
  const onStep: StepCallback = (_taskId, step) => {
    // Steps are broadcast via the relay
  }
  const llmCall: import('./browser/agent.js').LLMCallback = async (prompt) => {
    const provider = getProvider()
    // Browser agent uses low temperature for deterministic JSON output regardless
    // of user-configured HONE_TEMPERATURE — but respects HONE_MAX_TOKENS upper bound.
    const envMax = Number(process.env.HONE_MAX_TOKENS)
    const resp = await provider.createMessage({
      model: process.env.HONE_MODEL || 'deepseek-v4-pro',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: Number.isFinite(envMax) && envMax > 0 ? Math.min(envMax, 512) : 512,
      temperature: 0.1,
    })
    const content = resp.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    return JSON.stringify(content)
  }
  const browserAgent = createBrowserAgent(onConfirm, onStep, llmCall)
  state.browserAgent = browserAgent

  if (browserAgent) {
    console.error(`[Gateway] 浏览器代理已启用 (GUI model: ${process.env.HONE_GUI_MODEL_URL || 'DOM 降级模式'})`)
  }

  const gatewayCtx = createGatewayContext(state)
  const tools = getGatewayTools(gatewayCtx)

  // Start the scheduler
  state.schedulerState = createScheduler(state.schedules, gatewayCtx, async (entry: ScheduleEntry) => {
    log(config, `Schedule triggered: ${entry.text}`)
    const runId = startRun(entry.id)
    try {
      let finalResult: string

      // Stock monitor task: pull quote, analyze, record observation, raise signal if notable
      if (entry.task.startsWith('stock_monitor:')) {
        const itemId = entry.task.slice('stock_monitor:'.length)
        const items = listTrackedItems({ kind: 'stock' })
        const item = items.find(i => i.id === itemId)
        if (!item) {
          finalResult = `tracked item 已被移除: ${itemId}`
        } else {
          const quotes = await fetchStockQuotes([item.identifier]).catch(() => [])
          const q = quotes[0]
          if (!q) {
            finalResult = `${item.identifier} 暂无行情数据`
          } else {
            const p = item.user_position as any
            const hasPos = !!(p?.shares && p?.avg_cost)
            const pnlPct = hasPos ? ((q.current - p.avg_cost) / p.avg_cost) * 100 : null
            // Simple signal heuristic: ±3% intraday or ±5% from cost (if position)
            let signal: 'none' | 'buy' | 'sell' | 'alert' = 'none'
            if (Math.abs(q.change_pct) >= 5) signal = 'alert'
            if (hasPos && pnlPct !== null) {
              if (pnlPct <= -8) signal = 'sell'   // stop-loss territory
              else if (pnlPct >= 15) signal = 'sell' // take-profit
            }
            const assessment = hasPos
              ? `${q.name} ${q.current} (${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%) · 持仓浮${pnlPct! >= 0 ? '盈' : '亏'} ${pnlPct!.toFixed(2)}%`
              : `${q.name} ${q.current} (${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%)`
            recordObservation({
              item_id: item.id,
              data: { ...q, pnl_pct: pnlPct },
              agent_assessment: assessment,
              signal,
            })
            finalResult = assessment
            if (signal !== 'none') {
              broadcastBuddyEvent(state, 'suggestion', `⚠ ${item.display_name || item.identifier}: ${signal === 'sell' ? '止损/止盈信号' : signal === 'alert' ? '异动' : '关注'} (${q.change_pct.toFixed(2)}%)`)

              // If broker_authorized + adapter available, try auto-execute.
              // Otherwise broadcast for the user to act manually.
              let autoExecResult: any = null
              if (signal === 'sell' && hasPos && p?.broker_authorized && p?.broker) {
                autoExecResult = await tryAutoExecute(String(p.broker), {
                  symbol: item.identifier,
                  side: 'sell',
                  quantity: Number(p.shares),
                  reason: `自动止损/止盈触发: ${assessment}`,
                })
                if (autoExecResult?.ok) {
                  const { recordRecommendation, closeTrackedItem } = await import('./storage.js')
                  recordRecommendation({
                    item_id: item.id,
                    recommendation: `自动卖出 ${p.shares} 股 @ ${autoExecResult.filled_price || q.current}`,
                    reasoning: assessment,
                  })
                  closeTrackedItem(item.id, `Adapter ${p.broker} 自动执行: ${autoExecResult.order_id}`)
                }
              }

              broadcast(state, {
                type: 'tracked_item_signal',
                itemId: item.id,
                identifier: item.identifier,
                displayName: item.display_name,
                signal,
                quote: q,
                pnlPct,
                autoExecuted: !!autoExecResult?.ok,
                autoExecResult,
                ts: new Date().toISOString(),
              })
            }
          }
        }
        broadcast(state, {
          type: 'schedule_triggered',
          scheduleId: entry.id,
          text: entry.text,
          task: entry.task,
          result: finalResult,
          machineId: config.machineId,
          machineName: config.machineName,
          ts: new Date().toISOString(),
        })
        entry.lastStatus = 'ok'
        finishRun(runId, 'ok', finalResult)
        return
      }

      // Route web: prefixed tasks to browser agent
      if (entry.task.startsWith('web:') && state.browserAgent) {
        const webTask = entry.task.slice(4).trim()
        const result = await state.browserAgent.executeTask({
          id: `web_${entry.id}`,
          profileName: 'default',
          task: webTask,
          riskLevel: 'low',
        })
        logActivity('web_task', `${result.status}: ${webTask.slice(0, 80)}`)
        finalResult = result.status === 'success'
          ? `浏览器任务完成: ${result.finalUrl || ''} (${result.steps.length} 步)`
          : `浏览器任务失败: ${result.error || result.status}`
      } else if (entry.task.startsWith('web:') && !state.browserAgent) {
        finalResult = '浏览器代理未启用，无法执行网页任务'
      } else {
        const intent = await gatewayLLM(`执行日程任务: ${entry.task}`)
        finalResult = intent.reply || '已执行'

        if (intent.action === 'dispatch') {
          finalResult = await gatewayCtx.dispatchTask(intent.task || entry.task)
        } else if (intent.action === 'browser' && state.browserAgent) {
          const result = await state.browserAgent.executeTask({
            id: `browser_${entry.id}`,
            profileName: 'default',
            task: intent.task || entry.task,
            riskLevel: 'low',
          })
          finalResult = result.status === 'success'
            ? `浏览器任务完成: ${result.finalUrl || ''}`
            : `浏览器任务失败: ${result.error || result.status}`
        }
      }

      broadcast(state, {
        type: 'schedule_triggered',
        scheduleId: entry.id,
        text: entry.text,
        task: entry.task,
        result: finalResult,
        machineId: config.machineId,
        machineName: config.machineName,
        ts: new Date().toISOString(),
      })
      entry.lastStatus = 'ok'
      finishRun(runId, 'ok', finalResult)
    } catch (err) {
      entry.lastStatus = 'fail'
      log(config, `Schedule failed: ${err}`)
      finishRun(runId, 'fail', undefined, String(err))
    }
  })

  // Run pattern learner every 6 hours (first run after 5 min).
  // Three confidence tiers control how proactive the agent is:
  //   ≥ 0.85  → auto-create + enabled  (agent acts on its own; user can disable)
  //   0.6–0.85 → auto-create + disabled (agent proposes; user must enable)
  //   < 0.6   → suggestion only         (no schedule created; user must accept)
  // Dedup by pattern type so we don't recreate the same one each tick.
  const PATTERN_CHECK_MS = 6 * 3600_000
  const AUTO_CREATE_THRESHOLD = 0.85
  const PROPOSE_THRESHOLD = 0.6
  const runPatternCheck = () => {
    try {
      const suggestions = getPatternSuggestions()
      if (suggestions.length === 0) return
      log(config, `Pattern learner found ${suggestions.length} suggestions`)

      const existing = listAgentSchedules()
      const seenPatterns = new Set(
        existing.filter(a => !a.user_corrected).map(a => a.source_pattern),
      )

      for (const s of suggestions) {
        const pat = s.pattern
        if (seenPatterns.has(pat.type)) {
          // Already created an agent schedule for this pattern; skip to avoid spam
          continue
        }

        if (pat.confidence >= AUTO_CREATE_THRESHOLD && pat.suggestedSchedule) {
          const id = `agent_${Date.now()}_${pat.type}`
          const entry: ScheduleEntry = {
            id,
            text: pat.suggestedSchedule.text,
            trigger: { type: 'cron', cron: pat.suggestedSchedule.cron },
            task: pat.suggestedSchedule.task,
            delivery: 'both',
            enabled: true,
            createdAt: Date.now(),
          }
          state.schedules.set(id, entry)
          saveSchedules(state.schedules)
          markScheduleAgentCreated(id, pat.confidence, pat.type)
          broadcastBuddyEvent(state, 'success', `已自动创建日程: ${pat.suggestedSchedule.text}`)
          broadcast(state, {
            type: 'schedule_auto_created',
            scheduleId: id,
            text: pat.suggestedSchedule.text,
            task: pat.suggestedSchedule.task,
            cron: pat.suggestedSchedule.cron,
            pattern: pat.type,
            confidence: pat.confidence,
            ts: new Date().toISOString(),
          })
        } else if (pat.confidence >= PROPOSE_THRESHOLD && pat.suggestedSchedule) {
          const id = `agent_${Date.now()}_${pat.type}`
          const entry: ScheduleEntry = {
            id,
            text: pat.suggestedSchedule.text,
            trigger: { type: 'cron', cron: pat.suggestedSchedule.cron },
            task: pat.suggestedSchedule.task,
            delivery: 'both',
            enabled: false, // disabled — waiting for user approval
            createdAt: Date.now(),
          }
          state.schedules.set(id, entry)
          saveSchedules(state.schedules)
          markScheduleAgentCreated(id, pat.confidence, pat.type)
          broadcast(state, {
            type: 'schedule_proposed',
            scheduleId: id,
            text: pat.suggestedSchedule.text,
            task: pat.suggestedSchedule.task,
            cron: pat.suggestedSchedule.cron,
            pattern: pat.type,
            confidence: pat.confidence,
            ts: new Date().toISOString(),
          })
        } else {
          // Low confidence: just a suggestion (original behavior)
          broadcastBuddyEvent(state, 'suggestion', s.text, s)
          broadcast(state, {
            type: 'schedule_suggestion',
            id: s.id,
            text: s.text,
            pattern: pat.type,
            confidence: pat.confidence,
            ts: new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      log(config, `Pattern learner error: ${err}`)
    }
  }
  setTimeout(() => {
    runPatternCheck()
    state.patternTimer = setInterval(runPatternCheck, PATTERN_CHECK_MS)
  }, 5 * 60_000)

  log(config, `Gateway starting, relay: ${config.relayUrl}`)
  console.error(`[Gateway] Hone Gateway 启动中...`)
  console.error(`[Gateway] 机器: ${config.machineName}`)
  console.error(`[Gateway] 中继: ${config.relayUrl}`)
  console.error(`[Gateway] 已加载 ${state.schedules.size} 条日程`)

  // Poll for pairing decision files written by /gateway approve|deny.
  // Cross-process file-based signaling so the CLI command can affect the
  // long-running daemon. Decisions live at ~/.hone/pairings/<id>.decision.json.
  const PAIRING_POLL_MS = 3000
  const startPairingPoll = async () => {
    try {
      const { readdir, readFile, unlink, mkdir } = await import('fs/promises')
      const { join } = await import('path')
      const home = process.env.HOME || process.env.USERPROFILE || '~'
      const dataDir = process.env.HONE_DATA_DIR || join(home, '.hone')
      const pairDir = join(dataDir, 'pairings')
      await mkdir(pairDir, { recursive: true })

      const tick = async () => {
        if (!state.running || !state.connected || !state.ws) return
        try {
          const files = await readdir(pairDir)
          for (const f of files) {
            if (!f.endsWith('.decision.json')) continue
            const fp = join(pairDir, f)
            try {
              const data = JSON.parse(await readFile(fp, 'utf-8'))
              if (data && data.clientId) {
                sendJSON(state.ws!, {
                  type: 'pairing_response',
                  clientId: data.clientId,
                  approved: !!data.approved,
                })
                log(
                  config,
                  `Pairing decision processed: ${data.clientId} approved=${!!data.approved}`,
                )
                await unlink(fp).catch(() => {})
                await unlink(join(pairDir, `${data.clientId}.pending.json`)).catch(() => {})
              }
            } catch (err) {
              log(config, `Pairing decision parse error: ${err}`)
            }
          }
        } catch {}
      }

      // Reuse patternTimer? No — use its own; piggyback on state for cleanup.
      ;(state as any).pairingPollTimer = setInterval(tick, PAIRING_POLL_MS)
    } catch (err) {
      log(config, `Pairing poll init error: ${err}`)
    }
  }
  void startPairingPoll()

  await connectToRelay(state, tools)

  return state
}

async function connectToRelay(state: GatewayState, tools: any[]): Promise<void> {
  if (!state.running) return
  const { config } = state

  log(config, `Connecting to relay: ${config.relayUrl}`)

  try {
    const ws = new WebSocket(config.relayUrl)
    state.ws = ws

    ws.onopen = () => {
      state.connected = true
      state.reconnectAttempts = 0
      log(config, 'Connected to relay')

      // Register as gateway
      sendJSON(ws, {
        type: 'register',
        role: 'gateway',
        machineId: config.machineId,
        machineName: config.machineName,
        repo: config.repo || '',
        branch: config.branch || '',
        token: config.authToken || '',
      })

      // Start heartbeat
      state.heartbeatTimer = setInterval(() => {
        sendJSON(ws, {
          type: 'heartbeat',
          gatewayId: config.machineId,
          ts: new Date().toISOString(),
        })
      }, HEARTBEAT_INTERVAL_MS)

      console.error(`[Gateway] ✅ 已连接到中继`)
    }

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string)
        await handleMessage(state, msg, tools)
      } catch (err) {
        log(config, `Message parse error: ${err}`)
      }
    }

    ws.onclose = (event: CloseEvent) => {
      state.connected = false
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer)
        state.heartbeatTimer = null
      }
      log(config, `Disconnected: ${event.code} ${event.reason}`)

      if (state.running && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        state.reconnectAttempts++
        const delay = RECONNECT_DELAY_MS * Math.min(state.reconnectAttempts, 5)
        log(config, `Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})`)
        setTimeout(() => connectToRelay(state, tools), delay)
      } else if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[Gateway] ❌ 重连次数超限，已停止`)
      }
    }

    ws.onerror = () => {
      log(config, 'WebSocket error (will retry on close)')
    }
  } catch (err) {
    log(config, `Connection failed: ${err}`)
    if (state.running && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++
      const delay = RECONNECT_DELAY_MS * Math.min(state.reconnectAttempts, 5)
      setTimeout(() => connectToRelay(state, tools), delay)
    }
  }
}

async function handleMessage(
  state: GatewayState,
  msg: any,
  tools: any[],
): Promise<void> {
  const { config } = state

  switch (msg.type) {
    case 'registered': {
      log(config, `Registered with gatewayId: ${msg.gatewayId}`)
      break
    }

    case 'pairing_request': {
      // Auto-approve in God Mode, otherwise wait for /gateway approve via file decision
      const autoApprove = !!process.env.HONE_GOD_MODE
      if (autoApprove) {
        sendJSON(state.ws!, {
          type: 'pairing_response',
          clientId: msg.clientId,
          approved: true,
        })
        log(config, `Auto-approved pairing: ${msg.clientId}`)
      } else {
        log(config, `Pairing request from ${msg.clientId}, code: ${msg.pairingCode}`)
        console.error(`[Gateway] ⚠️ 新设备配对请求: ${msg.clientId} | 码: ${msg.pairingCode}`)
        console.error(`[Gateway] 输入 hone gateway approve ${msg.clientId} 批准`)
        // Persist a pending marker so /gateway pairings can list it
        try {
          const { writeFile, mkdir } = await import('fs/promises')
          const { join } = await import('path')
          const home = process.env.HOME || process.env.USERPROFILE || '~'
          const dataDir = process.env.HONE_DATA_DIR || join(home, '.hone')
          const pairDir = join(dataDir, 'pairings')
          await mkdir(pairDir, { recursive: true })
          await writeFile(
            join(pairDir, `${msg.clientId}.pending.json`),
            JSON.stringify({
              clientId: msg.clientId,
              pairingCode: msg.pairingCode,
              ts: new Date().toISOString(),
            }),
          )
        } catch (err) {
          log(config, `Failed to write pending pairing: ${err}`)
        }
      }
      break
    }

    case 'message': {
      const text = msg.payload?.text
      if (!text) break

      const replyClientId = msg.clientId || ''
      log(config, `Received message from ${msg.from || 'client'}: ${text.slice(0, 100)}`)

      // Stock intent fast-path: handle "盯着 / 买了 / 卖了 / 行情 / 持仓"
      // deterministically before LLM. No tokens wasted, no misinterpretation.
      try {
        const stockResult = await tryStockIntent(text)
        if (stockResult) {
          recordMessage({
            ts: Date.now(), direction: 'in', text,
            intent_action: 'stock', client_id: replyClientId || undefined,
          })
          sendJSON(state.ws!, {
            type: 'message',
            target: 'client',
            clientId: replyClientId,
            payload: { text: stockResult.reply },
            ts: new Date().toISOString(),
          })
          recordMessage({
            ts: Date.now(), direction: 'out', text: stockResult.reply,
            client_id: replyClientId || undefined,
          })
          // Auto-create monitor schedule for newly-tracked items
          for (const item of stockResult.needs_monitor || []) {
            if (item.monitor_schedule_id) continue
            const schedId = `mon_stock_${item.identifier}_${Date.now()}`
            // Every 30 min, weekdays 9-15 — covers A-share trading + close
            state.schedules.set(schedId, {
              id: schedId,
              text: `监控股票 ${item.display_name || item.identifier}`,
              trigger: { type: 'cron', cron: '*/30 9-15 * * 1-5' },
              task: `stock_monitor:${item.id}`,
              delivery: 'both',
              enabled: true,
              createdAt: Date.now(),
            })
            saveSchedules(state.schedules)
            upsertTrackedItem({
              kind: item.kind, identifier: item.identifier,
              monitor_schedule_id: schedId,
            })
          }
          broadcast(state, {
            type: 'tracked_items_changed',
            items: stockResult.items_changed || [],
            ts: new Date().toISOString(),
          })
          break
        }
      } catch (err) {
        log(config, `Stock intent handler error: ${err}`)
      }

      try {
        broadcastBuddyEvent(state, 'thinking', '正在思考意图...')
        const intent = await gatewayLLM(text)

        // Persist the incoming message with its classified intent for memory & history.
        recordMessage({
          ts: Date.now(),
          direction: 'in',
          text,
          intent_action: intent.action,
          intent_task: intent.task,
          client_id: replyClientId || undefined,
        })

        switch (intent.action) {
          case 'reply': {
            broadcastBuddyEvent(state, 'idle')
            const reply = intent.reply || '已收到'
            sendJSON(state.ws!, {
              type: 'message',
              target: 'client',
              clientId: replyClientId,
              payload: { text: reply },
              ts: new Date().toISOString(),
            })
            recordMessage({
              ts: Date.now(), direction: 'out', text: reply, client_id: replyClientId || undefined,
            })
            break
          }
          case 'dispatch': {
            // Buddy event handled inside gatewayCtx.dispatchTask
            const gatewayCtx = createGatewayContext(state)
            const result = await gatewayCtx.dispatchTask(intent.task || text)

            sendJSON(state.ws!, {
              type: 'task_complete',
              result,
              ts: new Date().toISOString(),
            })
            recordMessage({
              ts: Date.now(),
              direction: 'out',
              text: typeof result === 'string' ? result : JSON.stringify(result),
              result_text: typeof result === 'string' ? result : JSON.stringify(result),
              client_id: replyClientId || undefined,
            })
            break
          }
          case 'schedule': {
            broadcastBuddyEvent(state, 'success', '日程已创建')
            const reply = intent.reply || '日程已创建'
            sendJSON(state.ws!, {
              type: 'message',
              target: 'client',
              clientId: replyClientId,
              payload: { text: reply },
              ts: new Date().toISOString(),
            })
            recordMessage({
              ts: Date.now(), direction: 'out', text: reply, client_id: replyClientId || undefined,
            })
            break
          }
          case 'browser': {
            if (!state.browserAgent) {
              broadcastBuddyEvent(state, 'error', '浏览器代理未启用')
              sendJSON(state.ws!, {
                type: 'message',
                target: 'client',
                clientId: replyClientId,
                payload: { text: '浏览器代理未启用。请在设置中启用 HONE_BROWSER_ENABLED=true' },
                ts: new Date().toISOString(),
              })
              break
            }
            // Buddy event handled inside executeTask (or similar)
            sendJSON(state.ws!, {
              type: 'browser_task_started',
              task: intent.task || text,
              ts: new Date().toISOString(),
            })

            // Execute browser task (non-blocking — result sent via relay)
            const browserTask = intent.task || text
            broadcastBuddyEvent(state, 'working', `网页任务: ${browserTask}`)
            state.browserAgent.executeTask({
              id: `browser_${Date.now()}`,
              profileName: 'default',
              task: browserTask,
              riskLevel: 'low',
            }).then(result => {
              logActivity('web_task', `${result.status}: ${browserTask.slice(0, 80)}`)
              if (result.status === 'success') broadcastBuddyEvent(state, 'success', '网页任务完成')
              else if (result.status === 'failed') broadcastBuddyEvent(state, 'error', `网页任务失败: ${result.error}`)
              else broadcastBuddyEvent(state, 'idle')

              sendJSON(state.ws!, {
                type: 'browser_task_result',
                taskId: result.taskId,
                status: result.status,
                finalUrl: result.finalUrl,
                steps: result.steps.length,
                durationMs: result.durationMs,
                error: result.error,
                ts: new Date().toISOString(),
              })
              const summary = result.status === 'success'
                ? `网页任务完成${result.finalUrl ? ' · ' + result.finalUrl : ''}`
                : `网页任务${result.status}${result.error ? ': ' + result.error : ''}`
              recordMessage({
                ts: Date.now(), direction: 'out', text: summary,
                result_text: result.finalUrl || result.error,
                client_id: replyClientId || undefined,
              })
            }).catch(err => {
              broadcastBuddyEvent(state, 'error', `执行错误: ${err.message}`)
              sendJSON(state.ws!, {
                type: 'browser_task_result',
                status: 'failed',
                error: err.message || String(err),
                ts: new Date().toISOString(),
              })
              recordMessage({
                ts: Date.now(), direction: 'out',
                text: `网页任务执行错误: ${err.message || err}`,
                client_id: replyClientId || undefined,
              })
            })
            break
          }
        }
      } catch (err) {
        broadcastBuddyEvent(state, 'error', '内部错误')
        sendJSON(state.ws!, {
          type: 'message',
          target: 'client',
          clientId: replyClientId,
          payload: { text: `处理失败: ${err}` },
          ts: new Date().toISOString(),
        })
        recordMessage({
          ts: Date.now(), direction: 'out', text: `处理失败: ${err}`,
          client_id: replyClientId || undefined,
        })
      }
      break
    }

    case 'schedule_create': {
      // Mobile client wants to create a schedule
      const payload = msg.payload || {}
      const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const entry: import('./tools.js').ScheduleEntry = {
        id,
        text: payload.text || 'Untitled',
        trigger: payload.trigger === 'cron' && payload.cron
          ? { type: 'cron', cron: payload.cron }
          : { type: 'interval', ms: 3600_000 },
        task: payload.task || payload.text || '',
        delivery: 'both',
        enabled: true,
        createdAt: Date.now(),
      }
      state.schedules.set(id, entry)
      saveSchedules(state.schedules)
      sendJSON(state.ws!, {
        type: 'schedule_created',
        scheduleId: id,
        description: entry.text,
        ts: new Date().toISOString(),
      })
      log(config, `Schedule created: ${entry.text} (${id})`)
      break
    }

    case 'schedule_list': {
      // Mobile client requests schedule list
      const list = Array.from(state.schedules.values()).map(e => ({
        id: e.id,
        text: e.text,
        on: e.enabled,
        trigger: e.trigger,
      }))
      sendJSON(state.ws!, {
        type: 'schedule_list',
        schedules: list,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'schedule_enable': {
      const s = state.schedules.get(msg.scheduleId)
      if (s) { s.enabled = true; saveSchedules(state.schedules) }
      break
    }

    case 'schedule_disable': {
      const s = state.schedules.get(msg.scheduleId)
      if (s) { s.enabled = false; saveSchedules(state.schedules) }
      break
    }

    case 'schedule_delete': {
      const deleted = state.schedules.delete(msg.scheduleId)
      if (deleted) saveSchedules(state.schedules)
      break
    }

    case 'schedule_runs_request': {
      const scheduleId = String(msg.scheduleId || '')
      const limit = Number(msg.limit) || 50
      if (!scheduleId) break
      const runs = getScheduleRuns(scheduleId, limit)
      const agentInfo = getAgentScheduleInfo(scheduleId)
      sendJSON(state.ws!, {
        type: 'schedule_runs_response',
        scheduleId,
        runs,
        agentInfo,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'browser_open_login': {
      // User wants to manually log into a site with the agent's browser profile.
      // Open non-headless, wait for them to close, then session is persisted.
      const profile = String(msg.profile || 'default')
      const startUrl = msg.url ? String(msg.url) : undefined
      if (!state.browserAgent) {
        sendJSON(state.ws!, {
          type: 'browser_login_done',
          profile, status: 'error',
          error: '浏览器代理未启用 (HONE_BROWSER_ENABLED=true)',
          ts: new Date().toISOString(),
        })
        break
      }
      try {
        const runner = await import('./browser/playwright-runner.js')
        const cfg = (state.browserAgent as any).config
        broadcastBuddyEvent(state, 'working', `打开浏览器登录 ${profile}…`)
        sendJSON(state.ws!, {
          type: 'browser_login_started',
          profile, url: startUrl,
          ts: new Date().toISOString(),
        })
        // Async — don't block other messages
        runner.openProfileForLogin(cfg, profile, startUrl)
          .then(() => {
            broadcastBuddyEvent(state, 'success', `${profile} 登录会话已保存`)
            sendJSON(state.ws!, {
              type: 'browser_login_done',
              profile, status: 'ok',
              ts: new Date().toISOString(),
            })
          })
          .catch(err => {
            broadcastBuddyEvent(state, 'error', `登录失败: ${err.message || err}`)
            sendJSON(state.ws!, {
              type: 'browser_login_done',
              profile, status: 'error',
              error: String(err.message || err),
              ts: new Date().toISOString(),
            })
          })
      } catch (err) {
        sendJSON(state.ws!, {
          type: 'browser_login_done',
          profile, status: 'error',
          error: String(err),
          ts: new Date().toISOString(),
        })
      }
      break
    }

    case 'messages_list_request': {
      const limit = Math.max(1, Math.min(500, Number(msg.limit) || 100))
      const messages = getRecentMessages(limit)
      sendJSON(state.ws!, {
        type: 'messages_list_response',
        messages,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'tracked_items_list_request': {
      const { getObservations, getRecommendations, getRecommendationStats } = await import('./storage.js')
      const items = listTrackedItems()
      // Include latest observation and stats per item
      const enriched = items.map(item => ({
        ...item,
        latest_observation: (getObservations(item.id, 1)[0]) || null,
        stats: getRecommendationStats(item.id),
      }))
      sendJSON(state.ws!, {
        type: 'tracked_items_list_response',
        items: enriched,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'tracked_item_detail_request': {
      const { getObservations, getRecommendations, getTrackedItem } = await import('./storage.js')
      const itemId = String(msg.itemId || '')
      const item = getTrackedItem(itemId)
      const observations = item ? getObservations(itemId, 100) : []
      const recommendations = item ? getRecommendations(itemId, 50) : []
      sendJSON(state.ws!, {
        type: 'tracked_item_detail_response',
        itemId,
        item,
        observations,
        recommendations,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'tracked_item_remove': {
      const { removeTrackedItem, getTrackedItem } = await import('./storage.js')
      const itemId = String(msg.itemId || '')
      const item = getTrackedItem(itemId)
      if (item?.monitor_schedule_id) {
        state.schedules.delete(item.monitor_schedule_id)
        saveSchedules(state.schedules)
      }
      removeTrackedItem(itemId)
      sendJSON(state.ws!, {
        type: 'tracked_items_changed',
        items: [],
        removedId: itemId,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'browser_profiles_list': {
      if (!state.browserAgent) {
        sendJSON(state.ws!, { type: 'browser_profiles_response', profiles: [], ts: new Date().toISOString() })
        break
      }
      try {
        const runner = await import('./browser/playwright-runner.js')
        const cfg = (state.browserAgent as any).config
        const profiles = await runner.listProfiles(cfg)
        sendJSON(state.ws!, {
          type: 'browser_profiles_response',
          profiles,
          ts: new Date().toISOString(),
        })
      } catch (err) {
        sendJSON(state.ws!, {
          type: 'browser_profiles_response',
          profiles: [],
          error: String(err),
          ts: new Date().toISOString(),
        })
      }
      break
    }

    case 'browser_confirm': {
      // User confirmed/denied a high-risk browser action from the UI
      const pending = state.pendingConfirmations.get(msg.taskId)
      if (pending) {
        state.pendingConfirmations.delete(msg.taskId)
        pending.resolve(!!msg.approved)
        log(config, `Browser confirm: ${msg.taskId} approved=${msg.approved}`)
      }
      break
    }

    case 'schedule_created':
    case 'task_dispatched':
    case 'notification':
    case 'browser_task_started':
    case 'browser_task_result': {
      // Internal messages, already handled
      break
    }

    default: {
      log(config, `Unknown message type: ${msg.type}`)
    }
  }
}

export async function stopGateway(state: GatewayState): Promise<void> {
  state.running = false
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
  }
  if (state.patternTimer) {
    clearInterval(state.patternTimer)
  }
  const pairingTimer = (state as any).pairingPollTimer
  if (pairingTimer) {
    clearInterval(pairingTimer)
  }
  if (state.schedulerState) {
    stopScheduler(state.schedulerState)
  }
  if (state.browserAgent) {
    await state.browserAgent.shutdown()
  }
  if (state.ws) {
    state.ws.close()
  }
  console.error(`[Gateway] Hone Gateway 已停止`)
}
