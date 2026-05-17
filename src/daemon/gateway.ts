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
        ts: new Date().toISOString(),
      })

      try {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)

        const nodePath = process.execPath
        const cliScript = process.argv[1]

        const { stdout, stderr } = await execFileAsync(nodePath, [cliScript, '-p', task])
        return stdout || stderr || '执行完毕'
      } catch (err: any) {
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
  sendJSON(state.ws!, msg)
}

function broadcastBuddyEvent(state: GatewayState, event: string, text?: string, data?: any): void {
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
    const resp = await provider.createMessage({
      model: process.env.HONE_MODEL || 'deepseek-v4-pro',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
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
    try {
      let finalResult: string

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
        ts: new Date().toISOString(),
      })
      entry.lastStatus = 'ok'
    } catch (err) {
      entry.lastStatus = 'fail'
      log(config, `Schedule failed: ${err}`)
    }
  })

  // Run pattern learner every 6 hours (first run after 5 min)
  const PATTERN_CHECK_MS = 6 * 3600_000
  const runPatternCheck = () => {
    try {
      const suggestions = getPatternSuggestions()
      if (suggestions.length > 0) {
        log(config, `Pattern learner found ${suggestions.length} suggestions`)
        broadcastBuddyEvent(state, 'suggestion', suggestions[0].text, suggestions[0])
        for (const s of suggestions) {
          broadcast(state, {
            type: 'schedule_suggestion',
            id: s.id,
            text: s.text,
            pattern: s.pattern.type,
            confidence: s.pattern.confidence,
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
      // Auto-approve in God Mode, otherwise pending
      const autoApprove = !!process.env.HONE_GOD_MODE
      if (autoApprove) {
        sendJSON(state.ws!, {
          type: 'pairing_response',
          clientId: msg.clientId,
          approved: true,
        })
        log(config, `Auto-approved pairing: ${msg.clientId}`)
      } else {
        // Store for manual approval
        log(config, `Pairing request from ${msg.clientId}, code: ${msg.pairingCode}`)
        console.error(`[Gateway] ⚠️ 新设备配对请求: ${msg.clientId} | 码: ${msg.pairingCode}`)
        console.error(`[Gateway] 输入 hone gateway approve ${msg.clientId} 批准`)
      }
      break
    }

    case 'message': {
      const text = msg.payload?.text
      if (!text) break

      const replyClientId = msg.clientId || ''
      log(config, `Received message from ${msg.from || 'client'}: ${text.slice(0, 100)}`)

      try {
        broadcastBuddyEvent(state, 'thinking', '正在思考意图...')
        const intent = await gatewayLLM(text)

        switch (intent.action) {
          case 'reply': {
            broadcastBuddyEvent(state, 'idle')
            sendJSON(state.ws!, {
              type: 'message',
              target: 'client',
              clientId: replyClientId,
              payload: { text: intent.reply || '已收到' },
              ts: new Date().toISOString(),
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
            break
          }
          case 'schedule': {
            broadcastBuddyEvent(state, 'success', '日程已创建')
            sendJSON(state.ws!, {
              type: 'message',
              target: 'client',
              clientId: replyClientId,
              payload: { text: intent.reply || '日程已创建' },
              ts: new Date().toISOString(),
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
            }).catch(err => {
              broadcastBuddyEvent(state, 'error', `执行错误: ${err.message}`)
              sendJSON(state.ws!, {
                type: 'browser_task_result',
                status: 'failed',
                error: err.message || String(err),
                ts: new Date().toISOString(),
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
