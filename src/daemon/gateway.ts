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
import { randomUUID, timingSafeEqual } from 'crypto'
import * as os from 'os'
import { existsSync, statSync } from 'fs'
import { getProvider, type ProviderResponse } from '../services/providers/index.js'
import type { ScheduleEntry, GatewayContext, TaskRunResult } from './tools.js'
import { getGatewayTools } from './tools.js'
import { createScheduler, stopScheduler, loadSchedules, saveSchedules } from './scheduler.js'
import { gatewayLLM, buildProviderTools, type ProviderTool } from './llm.js'
import { getPatternSuggestions, type ActivityLogEntry } from './pattern-learner.js'
import { createBrowserAgent, type ConfirmCallback, type StepCallback } from './browser/agent.js'
import type { BrowserAgent } from './browser/types.js'
import { recordMessage, startRun, finishRun, markScheduleAgentCreated, listAgentSchedules, getScheduleRuns, getAgentScheduleInfo, getRecentMessages, listTrackedItems, recordObservation, upsertTrackedItem, closeDb, recordUsage, getUsageStats } from './storage.js'
import { tryStockIntent } from './intent/stock-intent.js'
import { fetchStockQuotes } from './datasources/stock-cn.js'
import { tryAutoExecute, listBrokerAdapters } from './brokers/adapter.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { writeFile as fsWriteFile, mkdir as fsMkdir, readFile as fsReadFile } from 'fs/promises'
import { join as pathJoin } from 'path'

const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 10
const MAX_GATEWAY_MESSAGE_BYTES = 64 * 1024
const LOCAL_HANDSHAKE_TIMEOUT_MS = 5_000

export interface GatewayConfig {
  relayUrl: string
  machineName: string
  machineId: string
  repo?: string
  branch?: string
  authToken?: string
  localAuthToken?: string
  pairingId?: string
  pairingCode?: string
  workspaceDir?: string
  verbose?: boolean
}

export interface GatewayState {
  config: GatewayConfig
  ws: WebSocket | null
  connected: boolean
  schedules: Map<string, ScheduleEntry>
  clients: Map<string, ClientInfo>
  pendingConfirmations: Map<string, {
    description: string
    clientId?: string
    resolve: (approved: boolean) => void
  }>
  pendingPairings: Map<string, { clientId: string; code: string; resolve: (approved: boolean) => void }>
  reconnectAttempts: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  schedulerState: ReturnType<typeof createScheduler> | null
  patternTimer: ReturnType<typeof setInterval> | null
  patternInitTimer: ReturnType<typeof setTimeout> | null
  memoryConsolidateTimer: ReturnType<typeof setInterval> | null
  pairingPollTimer: ReturnType<typeof setInterval> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  running: boolean
  browserAgent: BrowserAgent | null
  /** Local WebSocket clients (same-machine desktop app) that bypass the relay. */
  localClients: Set<WebSocket>
  /** Local WebSocket server (127.0.0.1:port). Closed on stopGateway to release the port. */
  localServer: { close: (cb?: () => void) => void } | null
  /** Active confirmation/pairing timeout timers — cleared on stopGateway to prevent leaks. */
  confirmationTimers: Set<ReturnType<typeof setTimeout>>
  taskQueue: TaskJob[]
  runningTasks: Map<string, RunningTask>
  runningTaskCount: number
  /** Originating device for an in-flight browser task, used for scoped prompts/events. */
  browserTaskOwners: Map<string, string | undefined>
  /** In-flight image uploads from mobile clients, keyed by imageId. */
  imageChunks: Map<string, { chunks: (string | null)[]; received: number; total: number }>
}

interface ClientInfo {
  id: string
  connectedAt: number
  lastSeen: number
}

interface TaskOrigin {
  clientId?: string
  requireConfirmation?: boolean
}

interface TaskJob {
  taskId: string
  task: string
  cwd: string
  clientId?: string
  resolve: (result: TaskRunResult) => void
}

interface RunningTask {
  job: TaskJob
  child: import('child_process').ChildProcess
  cancelled: boolean
  timedOut: boolean
}

/** Provider tools built once at gateway startup; shared with message handler. */
let gatewayProviderTools: ProviderTool[] | undefined

function log(config: GatewayConfig, msg: string): void {
  if (config.verbose) {
    console.error(`[Gateway] ${msg}`)
  }
}

function hasMatchingToken(expected: string | undefined, supplied: unknown): boolean {
  if (!expected || typeof supplied !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAllowedLocalOrigin(origin: string | undefined): boolean {
  // Native Tauri, local Vite development, and non-browser native clients are
  // all permitted. A normal website origin is rejected before it can attempt
  // to use a local capability token.
  if (!origin) return true
  return /^tauri:\/\//i.test(origin)
    || /^http:\/\/(tauri\.localhost|localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
}

// Audit logging: write activity events to ~/.hone/logs/YYYY-MM-DD.json
async function logActivity(type: ActivityLogEntry['type'], detail: string, extra?: { project?: string; duration?: number }): Promise<void> {
  try {
    const home = os.homedir()
    const logDir = pathJoin(home, '.hone', 'logs')
    await fsMkdir(logDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    const logFile = pathJoin(logDir, `${today}.json`)

    let entries: ActivityLogEntry[] = []
    try {
      entries = JSON.parse(await fsReadFile(logFile, 'utf-8'))
    } catch {}

    entries.push({ ts: Date.now(), type, detail, ...extra })
    // 上限 500 条/天，防止日志文件无限增长
    if (entries.length > 500) entries = entries.slice(-500)
    await fsWriteFile(logFile, JSON.stringify(entries))
  } catch {}
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

async function createRelayWebSocket(url: string): Promise<WebSocket> {
  if (typeof Bun !== 'undefined') {
    return new globalThis.WebSocket(url, {
      proxy: getWebSocketProxyUrl(url),
      tls: getWebSocketTLSOptions() || undefined,
    } as unknown as string[])
  }

  const { default: WS } = await import('ws')
  return new WS(url, {
    agent: getWebSocketProxyAgent(url),
    ...getWebSocketTLSOptions(),
  }) as unknown as WebSocket
}

function createGatewayContext(state: GatewayState, origin: TaskOrigin = {}): GatewayContext {
  return {
    schedules: state.schedules,
    pendingPairings: state.pendingPairings,
    browserAgent: state.browserAgent,
    persistSchedules: () => saveSchedules(state.schedules),
    dispatchTask: (task: string) => enqueueGatewayTask(state, task, origin),
    sendNotification: (msg: string) => {
      broadcast(state, {
        type: 'notification',
        message: msg,
        ts: new Date().toISOString(),
      })
    },
  }
}

function sendToClient(state: GatewayState, clientId: string | undefined, message: Record<string, unknown>): void {
  if (!clientId) {
    broadcast(state, message)
    return
  }
  const targeted = { ...message, target: 'client', clientId }
  if (state.ws && state.ws.readyState === 1) { // 1 = OPEN
    sendJSON(state.ws, targeted)
  }
}

/** Reply to the device that issued a request. Relay v3 rejects unaddressed
 * gateway messages, which also prevents one device from receiving another
 * device's private data. */
function replyToMessage(state: GatewayState, msg: any, message: Record<string, unknown>): void {
  const clientId = typeof msg?.clientId === 'string' ? msg.clientId : undefined
  sendToClient(state, clientId, message)
}

function broadcast(state: GatewayState, msg: Record<string, unknown>): void {
  const relayMessage = msg.target ? msg : { ...msg, target: 'all', broadcast: true }
  if (state.ws && state.ws.readyState === 1) {
    sendJSON(state.ws, relayMessage)
  }
  for (const localClient of state.localClients) {
    if (localClient.readyState === 1) sendJSON(localClient, msg)
  }
}

function emitTask(state: GatewayState, clientId: string | undefined, message: Record<string, unknown>): void {
  if (clientId) sendToClient(state, clientId, message)
  else broadcast(state, message)
}

function resolveTaskWorkspace(state: GatewayState): string {
  const workspace = state.config.workspaceDir?.trim()
  if (!workspace) throw new Error('No workspace selected. Choose a project directory before running a task.')
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not available: ${workspace}`)
  }
  return workspace
}

async function enqueueGatewayTask(state: GatewayState, task: string, origin: TaskOrigin): Promise<TaskRunResult> {
  const normalized = task.trim()
  const taskId = randomUUID()
  if (!normalized) {
    return { taskId, status: 'failed', result: 'Task is empty.' }
  }
  if (normalized.length > 4_000) {
    return { taskId, status: 'failed', result: 'Task is too large (maximum 4000 characters).' }
  }

  let cwd: string
  try {
    cwd = resolveTaskWorkspace(state)
  } catch (error) {
    const result = error instanceof Error ? error.message : String(error)
    emitTask(state, origin.clientId, { type: 'task_complete', taskId, status: 'failed', result, ts: new Date().toISOString() })
    return { taskId, status: 'failed', result }
  }

  emitTask(state, origin.clientId, {
    type: 'task_dispatched',
    taskId,
    task: normalized,
    machineId: state.config.machineId,
    machineName: state.config.machineName,
    cwd,
    ts: new Date().toISOString(),
  })

  // Remote device requests always require a human decision. For local desktop
  // requests, retain an additional guard for clearly destructive instructions.
  if (origin.requireConfirmation || isHighRiskCommand(normalized)) {
    const confirmed = await requestUserConfirmation(
      state,
      `dispatch_${taskId}`,
      `Confirm task execution in ${cwd}:\n${normalized.slice(0, 500)}`,
      origin.clientId,
    )
    if (!confirmed) {
      const result = 'Execution was denied or confirmation expired.'
      emitTask(state, origin.clientId, { type: 'task_complete', taskId, status: 'denied', result, ts: new Date().toISOString() })
      return { taskId, status: 'denied', result, cwd }
    }
  }

  return new Promise(resolve => {
    state.taskQueue.push({ taskId, task: normalized, cwd, clientId: origin.clientId, resolve })
    pumpTaskQueue(state)
  })
}

const MAX_CONCURRENT_TASKS = 3
const TASK_TIMEOUT_MS = 5 * 60_000
const MAX_TASK_OUTPUT_BYTES = 1_000_000

function pumpTaskQueue(state: GatewayState): void {
  while (state.runningTaskCount < MAX_CONCURRENT_TASKS && state.taskQueue.length > 0) {
    const job = state.taskQueue.shift()
    if (!job) return
    state.runningTaskCount++
    void executeTaskJob(state, job).then(result => {
      job.resolve(result)
    }).finally(() => {
      state.runningTaskCount--
      pumpTaskQueue(state)
    })
  }
}

async function executeTaskJob(state: GatewayState, job: TaskJob): Promise<TaskRunResult> {
  const startedAt = Date.now()
  emitTask(state, job.clientId, { type: 'task_started', taskId: job.taskId, task: job.task, cwd: job.cwd, ts: new Date().toISOString() })

  try {
    const { spawn } = await import('child_process')
    const cliScript = process.argv[1]
    const child = spawn(process.execPath, [cliScript, '-p', job.task], {
      cwd: job.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running: RunningTask = { job, child, cancelled: false, timedOut: false }
    state.runningTasks.set(job.taskId, running)

    return await new Promise<TaskRunResult>(resolve => {
      let settled = false
      let outputBytes = 0
      let output = ''
      const append = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
        if (settled) return
        const text = chunk.toString()
        const remaining = MAX_TASK_OUTPUT_BYTES - outputBytes
        if (remaining > 0) {
          const accepted = text.slice(0, remaining)
          output += accepted
          outputBytes += Buffer.byteLength(accepted)
        }
        emitTask(state, job.clientId, {
          type: 'task_progress',
          taskId: job.taskId,
          stream,
          text: text.slice(-2_000),
          ts: new Date().toISOString(),
        })
      }
      const finish = (status: TaskRunResult['status'], result: string) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        state.runningTasks.delete(job.taskId)
        const finalResult: TaskRunResult = { taskId: job.taskId, status, result, cwd: job.cwd }
        emitTask(state, job.clientId, {
          type: 'task_complete',
          ...finalResult,
          durationMs: Date.now() - startedAt,
          ts: new Date().toISOString(),
        })
        void logActivity('cli_session', `CLI task: ${job.task.slice(0, 100)}`, {
          project: job.cwd,
          duration: Date.now() - startedAt,
        })
        void logActivity('tool_call', `dispatch_task: ${job.task.slice(0, 100)}`, { project: job.cwd })
        resolve(finalResult)
      }
      const timeout = setTimeout(() => {
        running.timedOut = true
        child.kill('SIGTERM')
      }, TASK_TIMEOUT_MS)

      child.stdout?.on('data', chunk => append(chunk, 'stdout'))
      child.stderr?.on('data', chunk => append(chunk, 'stderr'))
      child.once('error', error => finish('failed', `Task process failed to start: ${error.message}`))
      child.once('close', code => {
        if (running.cancelled) finish('cancelled', output || 'Task cancelled.')
        else if (running.timedOut) finish('timed_out', output || 'Task timed out after 5 minutes.')
        else if (code === 0) finish('completed', output || 'Task completed.')
        else finish('failed', output || `Task exited with code ${code ?? -1}.`)
      })
    })
  } catch (error) {
    const result = error instanceof Error ? error.message : String(error)
    const failed: TaskRunResult = { taskId: job.taskId, status: 'failed', result, cwd: job.cwd }
    emitTask(state, job.clientId, { type: 'task_complete', ...failed, ts: new Date().toISOString() })
    return failed
  }
}

function cancelGatewayTask(state: GatewayState, taskId: string, clientId?: string): boolean {
  const queuedIndex = state.taskQueue.findIndex(job => job.taskId === taskId && (!job.clientId || job.clientId === clientId))
  if (queuedIndex >= 0) {
    const [job] = state.taskQueue.splice(queuedIndex, 1)
    const result: TaskRunResult = { taskId, status: 'cancelled', result: 'Task cancelled before execution.', cwd: job.cwd }
    emitTask(state, job.clientId, { type: 'task_complete', ...result, ts: new Date().toISOString() })
    job.resolve(result)
    return true
  }
  const running = state.runningTasks.get(taskId)
  if (!running || (running.job.clientId && running.job.clientId !== clientId)) return false
  running.cancelled = true
  running.child.kill('SIGTERM')
  emitTask(state, running.job.clientId, { type: 'task_cancelling', taskId, ts: new Date().toISOString() })
  return true
}

/** Request confirmation from the originating device, then fail closed on timeout. */
async function requestUserConfirmation(
  state: GatewayState,
  confirmId: string,
  description: string,
  clientId?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    state.pendingConfirmations.set(confirmId, { description, clientId, resolve })
    emitTask(state, clientId, {
      type: 'confirmation_required',
      confirmId,
      description,
      ts: new Date().toISOString(),
    })
    // 120 秒超时自动拒绝；定时器追踪到 state 以便 stopGateway 清理
    const timer = setTimeout(() => {
      state.confirmationTimers.delete(timer)
      if (state.pendingConfirmations.has(confirmId)) {
        state.pendingConfirmations.delete(confirmId)
        resolve(false)
      }
    }, 120_000)
    state.confirmationTimers.add(timer)
  })
}

/** 高风险命令关键词检测——命中则需用户确认后才执行。 */
const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i, /\bdel\s+\/[sqf]/i, /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i, /\bmkfs\./i, /\bdd\s+if=/i,
  /\bgit\s+push\s+.*--force/i, /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+reset\s+--hard/i, /\bgit\s+clean\s+-fd/i,
  /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bhalt\b/i,
  /\b:\(\)\s*\{.*\};:/i, // fork bomb
  /\bcurl\s+.*\|\s*(bash|sh)\b/i, /\bwget\s+.*\|\s*(bash|sh)\b/i,
  /\bchmod\s+777\s+\//i,
  /\bkill\s+-9\s+1\b/i, /\bkillall\b/i,
]

function isHighRiskCommand(task: string): boolean {
  return HIGH_RISK_PATTERNS.some(p => p.test(task))
}

function broadcastBuddyEvent(state: GatewayState, event: string, text?: string, data?: any): void {
  if (!state.ws && state.localClients.size === 0) return;
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
    patternInitTimer: null,
    memoryConsolidateTimer: null,
    pairingPollTimer: null,
    reconnectTimer: null,
    running: true,
    browserAgent: null, // set below after callbacks are created
    localClients: new Set(),
    localServer: null,
    confirmationTimers: new Set(),
    taskQueue: [],
    runningTasks: new Map(),
    runningTaskCount: 0,
    browserTaskOwners: new Map(),
    imageChunks: new Map(),
  }

  // Initialize browser agent (null if HONE_BROWSER_ENABLED !== 'true')
  const onConfirm: ConfirmCallback = async (taskId, description) => {
    return new Promise((resolve) => {
      const clientId = state.browserTaskOwners.get(taskId)
      state.pendingConfirmations.set(taskId, { description, clientId, resolve })
      emitTask(state, clientId, {
        type: 'browser_confirm_required',
        taskId,
        description,
        ts: new Date().toISOString(),
      })
      const timer = setTimeout(() => {
        state.confirmationTimers.delete(timer)
        if (state.pendingConfirmations.has(taskId)) {
          state.pendingConfirmations.delete(taskId)
          resolve(false)
        }
      }, 60_000)
      state.confirmationTimers.add(timer)
    })
  }
  const onStep: StepCallback = (taskId, step) => {
    // Do not forward screenshots by default: they can be large and can contain
    // sensitive page data. Clients receive action progress instead.
    emitTask(state, state.browserTaskOwners.get(taskId), {
      type: 'browser_task_progress',
      taskId,
      step: {
        stepNumber: step.stepNumber,
        action: step.action,
        timestamp: step.timestamp,
        durationMs: step.durationMs,
      },
      ts: new Date().toISOString(),
    })
  }
  const llmCall: import('./browser/agent.js').LLMCallback = async (prompt) => {
    const provider = getProvider()
    // Browser agent uses low temperature for deterministic JSON output regardless
    // of user-configured HONE_TEMPERATURE — but respects HONE_MAX_TOKENS upper bound.
    const envMax = Number(process.env.HONE_MAX_TOKENS)
    const resp = await provider.createMessage({
      model: process.env.HONE_MODEL || 'deepseek-chat',
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
  const providerTools = buildProviderTools(tools)
  gatewayProviderTools = providerTools

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

              // If broker_authorized + adapter available, request user confirmation before auto-execute.
              // Financial transactions must never execute without explicit user approval.
              let autoExecResult: any = null
              if (signal === 'sell' && hasPos && p?.broker_authorized && p?.broker) {
                // Request user confirmation for real-money trade
                const confirmKey = `stock_sell_${item.id}_${Date.now()}`
                const confirmed = await requestUserConfirmation(state, confirmKey,
                  `确认卖出 ${item.display_name || item.identifier}？\n` +
                  `当前价: ${q.current} (${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%)\n` +
                  `持仓: ${p.shares} 股 @ ${p.avg_cost} (浮${pnlPct! >= 0 ? '盈' : '亏'} ${pnlPct!.toFixed(2)}%)\n` +
                  `触发原因: ${pnlPct! <= -8 ? '止损' : '止盈'}信号`)
                if (confirmed) {
                  autoExecResult = await tryAutoExecute(String(p.broker), {
                    symbol: item.identifier,
                    side: 'sell',
                    quantity: Number(p.shares),
                    reason: `用户确认后执行止损/止盈: ${assessment}`,
                  })
                  if (autoExecResult?.ok) {
                    const { recordRecommendation, closeTrackedItem } = await import('./storage.js')
                    recordRecommendation({
                      item_id: item.id,
                      recommendation: `用户确认后卖出 ${p.shares} 股 @ ${autoExecResult.filled_price || q.current}`,
                      reasoning: assessment,
                    })
                    closeTrackedItem(item.id, `Adapter ${p.broker} 用户确认后执行: ${autoExecResult.order_id}`)
                  }
                } else {
                  broadcastBuddyEvent(state, 'suggestion', `已跳过自动卖出（用户未确认）。${item.display_name || item.identifier} 请手动决定是否操作。`)
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
        void logActivity('web_task', `${result.status}: ${webTask.slice(0, 80)}`)
        finalResult = result.status === 'success'
          ? `浏览器任务完成: ${result.finalUrl || ''} (${result.steps.length} 步)`
          : `浏览器任务失败: ${result.error || result.status}`
      } else if (entry.task.startsWith('web:') && !state.browserAgent) {
        finalResult = '浏览器代理未启用，无法执行网页任务'
      } else {
        const intent = await gatewayLLM(`执行日程任务: ${entry.task}`, providerTools)
        finalResult = intent.reply || '已执行'

        if (intent.action === 'dispatch') {
          const dispatched = await gatewayCtx.dispatchTask(intent.task || entry.task)
          finalResult = dispatched.result
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
  state.patternInitTimer = setTimeout(() => {
    state.patternInitTimer = null
    if (!state.running) return
    runPatternCheck()
    state.patternTimer = setInterval(runPatternCheck, PATTERN_CHECK_MS)
  }, 5 * 60_000)

  // 记忆整理：每 24 小时运行一次，合并相似记忆、清理过期记忆
  try {
    const { autoConsolidate } = await import('../memory/consolidation.js')
    state.memoryConsolidateTimer = setInterval(async () => {
      if (!state.running) return
      try {
        autoConsolidate()
        log(config, 'Memory consolidation completed')
      } catch (err) {
        log(config, `Memory consolidation error: ${err}`)
      }
    }, 24 * 60 * 60_000) // 24 hours
  } catch (err) {
    log(config, `Memory consolidation init error: ${err}`)
  }

  log(config, `Gateway starting, relay: ${config.relayUrl}`)
  console.error(`[Gateway] Hone 启动中...`)
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
      const home = process.env.HOME || process.env.USERPROFILE || '.'
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
      state.pairingPollTimer = setInterval(tick, PAIRING_POLL_MS)
    } catch (err) {
      log(config, `Pairing poll init error: ${err}`)
    }
  }
  void startPairingPoll()

  await connectToRelay(state, tools)

  // ── Local WebSocket server ──────────────────────────────────────────────
  // Lets the trusted desktop app connect directly when the relay is
  // unavailable. Binding to loopback is not enough: browsers can still try to
  // reach localhost, so every connection must complete a capability handshake
  // before it can submit a gateway message.
  const localPort = parseInt(process.env.HONE_GATEWAY_PORT || '18789', 10)
  const localAuthToken = config.localAuthToken
  try {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({
      port: localPort,
      host: '127.0.0.1',
      maxPayload: MAX_GATEWAY_MESSAGE_BYTES,
    })
    state.localServer = wss
    console.error(`[Gateway] 本地 WS 服务监听 127.0.0.1:${localPort}`)
    wss.on('connection', (ws: WebSocket, request: { headers?: Record<string, string | string[] | undefined> }) => {
      const originValue = request.headers?.origin
      const origin = Array.isArray(originValue) ? originValue[0] : originValue
      if (!isAllowedLocalOrigin(origin)) {
        ws.close(4003, 'Untrusted local origin')
        return
      }

      let authenticated = false
      let desktopClientId = ''
      const handshakeTimer = setTimeout(() => {
        if (!authenticated) ws.close(4003, 'Local authentication timed out')
      }, LOCAL_HANDSHAKE_TIMEOUT_MS)

      ws.on('message', async (data: Buffer) => {
        try {
          if (data.length > MAX_GATEWAY_MESSAGE_BYTES) {
            ws.close(4009, 'Message too large')
            return
          }
          const msg = JSON.parse(data.toString())
          if (!authenticated) {
            if (
              msg?.type !== 'register'
              || msg?.role !== 'desktop'
              || !hasMatchingToken(localAuthToken, msg?.token)
            ) {
              ws.close(4003, 'Local authentication failed')
              return
            }
            authenticated = true
            desktopClientId = typeof msg.clientId === 'string' && msg.clientId
              ? msg.clientId
              : `desktop_${randomUUID()}`
            clearTimeout(handshakeTimer)
            state.localClients.add(ws)
            sendJSON(ws, {
              type: 'registered',
              clientId: desktopClientId,
              machineId: config.machineId,
              machineName: config.machineName,
              local: true,
            })
            console.error('[Gateway] 已认证本地桌面客户端')
            return
          }
          // 为每条消息创建独立的 state 视图（ws 指向当前本地客户端），
          // 避免 async 交错时 state.ws 被其他消息篡改导致回复发错 socket。
          // 浅拷贝共享 Maps/Sets（schedules、clients 等），仅 ws 不同。
          const msgState: GatewayState = { ...state, ws }
          msg.from = 'desktop'
          msg.clientId = desktopClientId
          await handleMessage(msgState, msg, tools)
        } catch (err) {
          log(config, `本地消息解析错误: ${err}`)
        }
      })
      ws.on('close', () => {
        clearTimeout(handshakeTimer)
        state.localClients.delete(ws)
        if (authenticated) console.error('[Gateway] 本地桌面客户端已断开')
      })
      ws.on('error', () => { /* swallow */ })
    })
    wss.on('error', (err: Error) => {
      console.error(`[Gateway] 本地 WS 服务错误: ${err.message}`)
      // EADDRINUSE 说明端口被占用（通常是孤儿 Gateway 进程），直接退出让桌面端重启
      if (err.message.includes('EADDRINUSE')) {
        console.error('[Gateway] 端口被占用，退出进程以便桌面端重启')
        process.exit(1)
      }
    })
  } catch (err) {
    console.error(`[Gateway] 本地 WS 服务启动失败: ${err}`)
  }

  return state
}

async function connectToRelay(state: GatewayState, tools: any[]): Promise<void> {
  if (!state.running) return
  const { config } = state

  // 安全警告：连接公网 relay 但未配置 authToken 时提示（任何人可注册）
  const isPublicRelay = config.relayUrl && !/localhost|127\.0\.0\.1/i.test(config.relayUrl)
  if (isPublicRelay && !config.authToken) {
    console.error('[Gateway] ⚠ 警告：连接公网 relay 但未配置 authToken，任何人可注册！请设置 HONE_AUTH_TOKEN 环境变量。')
  }

  log(config, `Connecting to relay: ${config.relayUrl}`)

  try {
    const ws = await createRelayWebSocket(config.relayUrl)
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
        pairingId: config.pairingId || '',
        pairingCode: config.pairingCode || '',
        protocolVersion: 3,
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
        state.reconnectTimer = setTimeout(() => connectToRelay(state, tools), delay)
      } else if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        // Don't exit the daemon just because the relay is unreachable.
        // The relay might be temporarily down, the user's network might be
        // behind a proxy that blocks wss://, etc. Keep the daemon alive and
        // keep retrying at a slow cadence (every 30s) so it can recover
        // automatically when connectivity returns. Exiting here made the
        // whole gateway unusable whenever the relay had a bad day.
        console.error(`[Gateway] ⚠ Relay unreachable after ${MAX_RECONNECT_ATTEMPTS} attempts — daemon stays alive, will keep retrying every 30s`)
        state.reconnectAttempts = 0 // reset so the slow-retry loop below keeps working
        state.reconnectTimer = setTimeout(() => connectToRelay(state, tools), 30_000)
      }
    }

    ws.onerror = () => {
      log(config, 'WebSocket error (will retry on close)')
    }
  } catch (err) {
    log(config, `Connection failed: ${err}`)
    if (state.running) {
      state.reconnectAttempts++
      // After the fast-retry budget is exhausted, fall back to a slow 30s
      // cadence instead of giving up (see the matching note in onclose).
      const delay = state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
        ? RECONNECT_DELAY_MS * Math.min(state.reconnectAttempts, 5)
        : 30_000
      if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        state.reconnectAttempts = 0 // reset for the next slow-retry cycle
      }
      state.reconnectTimer = setTimeout(() => connectToRelay(state, tools), delay)
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
      // 路径遍历防护：clientId 仅允许字母、数字、下划线、短横线
      const clientId = String(msg.clientId || '')
      if (!/^[a-zA-Z0-9_-]+$/.test(clientId)) {
        log(config, `Rejected pairing request with invalid clientId: ${clientId}`)
        break
      }
      // A request with the active pairing challenge has already proven
      // possession of the one-time QR code at the Relay. Treat scanning that
      // code as the user's approval so the normal mobile onboarding flow does
      // not require a hidden CLI command. Other requests still use the
      // explicit approval path unless God Mode is enabled.
      const godMode = String(process.env.HONE_GOD_MODE || '').toLowerCase()
      const qrChallengeApproved = typeof msg.pairingId === 'string'
        && msg.pairingId === config.pairingId
      const autoApprove = qrChallengeApproved || godMode === '1' || godMode === 'true' || godMode === 'yes'
      if (autoApprove) {
        sendJSON(state.ws!, {
          type: 'pairing_response',
          clientId: clientId,
          approved: true,
        })
        log(config, `Approved pairing: ${clientId} (${qrChallengeApproved ? 'QR challenge' : 'God Mode'})`)
      } else {
        log(config, `Pairing request from ${clientId}, code: ${msg.pairingCode}`)
        console.error(`[Gateway] ⚠️ 新设备配对请求: ${clientId} | 码: ${msg.pairingCode}`)
        console.error(`[Gateway] 输入 hone gateway approve ${clientId} 批准`)
        // Persist a pending marker so /gateway pairings can list it
        try {
          const { writeFile, mkdir } = await import('fs/promises')
          const { join } = await import('path')
          const dataDir = process.env.HONE_DATA_DIR || join(os.homedir(), '.hone')
          const pairDir = join(dataDir, 'pairings')
          await mkdir(pairDir, { recursive: true })
          await writeFile(
            join(pairDir, `${clientId}.pending.json`),
            JSON.stringify({
              clientId: clientId,
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
        const intent = await gatewayLLM(text, gatewayProviderTools)

        // 记录 token 用量并检查预算
        if (intent.usage) {
          try {
            const { budgetExceeded } = recordUsage({
              inputTokens: intent.usage.inputTokens || 0,
              outputTokens: intent.usage.outputTokens || 0,
            })
            if (budgetExceeded) {
              broadcast(state, {
                type: 'budget_warning',
                usage: getUsageStats(),
                ts: new Date().toISOString(),
              })
            }
          } catch (e) { log(config, `recordUsage error: ${e}`) }
        }

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
            // 如果 LLM 调用了 memory_save 等工具，执行它
            let toolResultText = ''
            if (intent.toolCall) {
              const tool = tools.find(t => t.name === intent.toolCall!.name)
              if (tool) {
                try {
                  const toolResult = await tool.execute(intent.toolCall.input)
                  log(config, `Tool executed: ${intent.toolCall.name}`)
                  // 提取工具返回的文本内容
                  if (toolResult?.content?.length) {
                    toolResultText = toolResult.content
                      .filter((c: any) => c.type === 'text')
                      .map((c: any) => c.text)
                      .join('\n')
                  }
                } catch (e) {
                  log(config, `Tool execution failed: ${e}`)
                  toolResultText = `工具执行失败: ${e}`
                }
              }
            }
            broadcastBuddyEvent(state, 'idle')
            // 如果 LLM 没有给出回复文案，但工具执行有结果，用工具结果作为回复
            let reply = intent.reply || '已收到'
            if (!intent.reply && toolResultText) {
              reply = toolResultText
            }
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
            // Relay clients always require a confirmation before execution.
            // The queued executor emits the targeted lifecycle events, so do
            // not emit a second task_complete from this message handler.
            const gatewayCtx = createGatewayContext(state, {
              clientId: replyClientId || undefined,
              requireConfirmation: msg.from === 'client',
            })
            const result = await gatewayCtx.dispatchTask(intent.task || text)
            recordMessage({
              ts: Date.now(),
              direction: 'out',
              text: result.result,
              result_text: result.result,
              client_id: replyClientId || undefined,
            })
            break
          }
          case 'schedule': {
            // 如果 LLM 返回了结构化日程数据，真正创建日程
            if (intent.scheduleData) {
              const sd = intent.scheduleData
              const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              const scheduleEntry: ScheduleEntry = {
                id,
                text: sd.text,
                trigger: { type: 'cron', cron: sd.trigger },
                task: sd.task,
                delivery: (sd.delivery as any) || 'both',
                enabled: true,
                createdAt: Date.now(),
              }
              state.schedules.set(id, scheduleEntry)
              saveSchedules(state.schedules)
              broadcastBuddyEvent(state, 'success', `日程已创建: ${sd.text}`)
              const reply = intent.reply || `日程已创建: ${sd.text} (触发: ${sd.trigger})`
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
            } else {
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
            }
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
            const browserTask = intent.task || text
            const browserTaskId = `browser_${randomUUID()}`
            state.browserTaskOwners.set(browserTaskId, replyClientId || undefined)
            sendToClient(state, replyClientId || undefined, {
              type: 'browser_task_started',
              taskId: browserTaskId,
              task: browserTask,
              ts: new Date().toISOString(),
            })

            // Execute browser task (non-blocking — result sent via relay)
            broadcastBuddyEvent(state, 'working', `网页任务: ${browserTask}`)
            state.browserAgent.executeTask({
              id: browserTaskId,
              profileName: 'default',
              task: browserTask,
              // Remote browser actions are confirmed per click/type. A local
              // desktop request retains the normal browser task flow.
              riskLevel: msg.from === 'client' ? 'high' : 'low',
            }).then(result => {
              void logActivity('web_task', `${result.status}: ${browserTask.slice(0, 80)}`)
              if (result.status === 'success') broadcastBuddyEvent(state, 'success', '网页任务完成')
              else if (result.status === 'failed') broadcastBuddyEvent(state, 'error', `网页任务失败: ${result.error}`)
              else broadcastBuddyEvent(state, 'idle')

              sendToClient(state, replyClientId || undefined, {
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
              sendToClient(state, replyClientId || undefined, {
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
            }).finally(() => {
              state.browserTaskOwners.delete(browserTaskId)
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

    case 'task_cancel': {
      const taskId = typeof msg.taskId === 'string' ? msg.taskId : ''
      const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined
      const cancelled = taskId ? cancelGatewayTask(state, taskId, clientId) : false
      sendToClient(state, clientId, {
        type: cancelled ? 'task_cancelled' : 'error',
        taskId,
        message: cancelled ? 'Cancellation requested.' : 'Task was not found or cannot be cancelled.',
        ts: new Date().toISOString(),
      })
      break
    }

    case 'schedule_create': {
      // Mobile client wants to create a schedule
      const payload = msg.payload || {}
      // 校验 cron 表达式（如果使用 cron 触发器）
      if (payload.trigger === 'cron' && payload.cron) {
        const cronParts = String(payload.cron).trim().split(/\s+/)
        if (cronParts.length !== 5 || !cronParts.every(p => /^[0-9*,/\-]+$/.test(p))) {
          replyToMessage(state, msg, {
            type: 'error',
            message: `无效的 cron 表达式: "${payload.cron}"。请使用 5 段标准格式。`,
            ts: new Date().toISOString(),
          })
          break
        }
      }
      const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const entry: import('./tools.js').ScheduleEntry = {
        id,
        text: String(payload.text || 'Untitled').slice(0, 500),
        trigger: payload.trigger === 'cron' && payload.cron
          ? { type: 'cron', cron: payload.cron }
          : { type: 'interval', ms: 3600_000 },
        task: String(payload.task || payload.text || '').slice(0, 2000),
        delivery: 'both',
        enabled: true,
        createdAt: Date.now(),
      }
      state.schedules.set(id, entry)
      saveSchedules(state.schedules)
      replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
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
      // URL 协议校验：仅允许 http/https
      if (startUrl) {
        try {
          const parsed = new URL(startUrl)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            replyToMessage(state, msg, {
              type: 'browser_login_done',
              profile, status: 'error',
              error: `不支持的 URL 协议: ${parsed.protocol}，仅允许 http/https`,
              ts: new Date().toISOString(),
            })
            break
          }
        } catch {
          replyToMessage(state, msg, {
            type: 'browser_login_done',
            profile, status: 'error',
            error: `无效的 URL: ${startUrl}`,
            ts: new Date().toISOString(),
          })
          break
        }
      }
      if (!state.browserAgent) {
        replyToMessage(state, msg, {
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
        replyToMessage(state, msg, {
          type: 'browser_login_started',
          profile, url: startUrl,
          ts: new Date().toISOString(),
        })
        // Async — don't block other messages
        runner.openProfileForLogin(cfg, profile, startUrl)
          .then(() => {
            broadcastBuddyEvent(state, 'success', `${profile} 登录会话已保存`)
            replyToMessage(state, msg, {
              type: 'browser_login_done',
              profile, status: 'ok',
              ts: new Date().toISOString(),
            })
          })
          .catch(err => {
            broadcastBuddyEvent(state, 'error', `登录失败: ${err.message || err}`)
            replyToMessage(state, msg, {
              type: 'browser_login_done',
              profile, status: 'error',
              error: String(err.message || err),
              ts: new Date().toISOString(),
            })
          })
      } catch (err) {
        replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
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
      replyToMessage(state, msg, {
        type: 'tracked_items_changed',
        items: [],
        removedId: itemId,
        ts: new Date().toISOString(),
      })
      break
    }

    case 'browser_profiles_list': {
      if (!state.browserAgent) {
        replyToMessage(state, msg, { type: 'browser_profiles_response', profiles: [], ts: new Date().toISOString() })
        break
      }
      try {
        const runner = await import('./browser/playwright-runner.js')
        const cfg = (state.browserAgent as any).config
        const profiles = await runner.listProfiles(cfg)
        replyToMessage(state, msg, {
          type: 'browser_profiles_response',
          profiles,
          ts: new Date().toISOString(),
        })
      } catch (err) {
        replyToMessage(state, msg, {
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
      const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined
      if (pending && (!pending.clientId || pending.clientId === clientId)) {
        state.pendingConfirmations.delete(msg.taskId)
        pending.resolve(!!msg.approved)
        log(config, `Browser confirm: ${msg.taskId} approved=${msg.approved}`)
      }
      break
    }

    case 'confirmation_response': {
      // User confirmed/denied a dispatch/stock-sell confirmation request
      const pending = state.pendingConfirmations.get(msg.confirmId)
      const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined
      if (pending && (!pending.clientId || pending.clientId === clientId)) {
        state.pendingConfirmations.delete(msg.confirmId)
        pending.resolve(!!msg.approved)
        log(config, `Confirmation response: ${msg.confirmId} approved=${msg.approved}`)
      }
      break
    }

    case 'schedule_created':
    case 'task_dispatched':
    case 'notification':
    case 'browser_task_started':
    case 'browser_task_result':
    case 'budget_warning': {
      // Internal messages, already handled
      break
    }

    case 'image_chunk': {
      const { imageId, index, total, data } = msg.payload || msg
      if (!imageId || typeof index !== 'number' || typeof total !== 'number' || typeof data !== 'string') break

      let chunkData = state.imageChunks.get(imageId)
      if (!chunkData) {
        chunkData = { chunks: new Array(total).fill(null), received: 0, total }
        state.imageChunks.set(imageId, chunkData)
      }
      if (index < 0 || index >= total || chunkData.chunks[index]) break

      chunkData.chunks[index] = data
      chunkData.received++
      break
    }

    case 'image_complete': {
      const imageId = typeof msg.imageId === 'string' ? msg.imageId : (msg.payload?.imageId)
      if (!imageId) break

      const chunkData = state.imageChunks.get(imageId)
      if (!chunkData || chunkData.received !== chunkData.total) {
        replyToMessage(state, msg, {
          type: 'image_received',
          status: 'failed',
          error: '图片分片不完整或已过期',
          ts: new Date().toISOString(),
        })
        break
      }

      try {
        const base64 = chunkData.chunks.join('')
        const buffer = Buffer.from(base64, 'base64')
        const tmpDir = pathJoin(os.tmpdir(), 'hone')
        await fsMkdir(tmpDir, { recursive: true })
        const filename = `received_${imageId}.jpg`
        const filePath = pathJoin(tmpDir, filename)
        await fsWriteFile(filePath, buffer)
        state.imageChunks.delete(imageId)

        replyToMessage(state, msg, {
          type: 'image_received',
          path: filePath,
          ts: new Date().toISOString(),
        })
        log(config, `Image received and saved: ${filePath}`)
      } catch (err) {
        replyToMessage(state, msg, {
          type: 'image_received',
          status: 'failed',
          error: String(err),
          ts: new Date().toISOString(),
        })
      }
      break
    }

    case 'usage_query': {
      replyToMessage(state, msg, {
        type: 'usage_stats',
        stats: getUsageStats(),
        ts: new Date().toISOString(),
      })
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
  if (state.patternInitTimer) {
    clearTimeout(state.patternInitTimer)
    state.patternInitTimer = null
  }
  if (state.memoryConsolidateTimer) {
    clearInterval(state.memoryConsolidateTimer)
  }
  if (state.pairingPollTimer) {
    clearInterval(state.pairingPollTimer)
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }
  if (state.schedulerState) {
    stopScheduler(state.schedulerState)
  }
  if (state.browserAgent) {
    await state.browserAgent.shutdown()
  }
  // 清理所有待确认的 Promise（避免永悬）和超时定时器（避免泄漏）
  for (const timer of state.confirmationTimers) {
    clearTimeout(timer)
  }
  state.confirmationTimers.clear()
  for (const [, conf] of state.pendingConfirmations) {
    conf.resolve(false)
  }
  state.pendingConfirmations.clear()
  for (const [, pairing] of state.pendingPairings) {
    pairing.resolve(false)
  }
  state.pendingPairings.clear()
  // 关闭所有本地客户端连接
  for (const lc of state.localClients) {
    try { lc.close() } catch {}
  }
  state.localClients.clear()
  // 关闭本地 WebSocketServer，释放端口（否则重启后 18789 仍被占用）
  if (state.localServer) {
    try { state.localServer.close() } catch {}
    state.localServer = null
  }
  if (state.ws) {
    state.ws.close()
  }
  // Close the SQLite database to checkpoint WAL and release file handles.
  closeDb()
  console.error(`[Gateway] Hone 已停止`)
}
