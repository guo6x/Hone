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
  pendingPairings: Map<string, { clientId: string; code: string; resolve: (approved: boolean) => void }>
  reconnectAttempts: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  schedulerState: ReturnType<typeof createScheduler> | null
  patternTimer: ReturnType<typeof setInterval> | null
  running: boolean
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

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function createGatewayContext(state: GatewayState): GatewayContext {
  return {
    schedules: state.schedules,
    pendingPairings: state.pendingPairings,
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
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)
        
        const nodePath = process.execPath
        const cliScript = process.argv[1]
        const safeTask = task.replace(/"/g, '\\"')
        
        const { stdout, stderr } = await execAsync(`"${nodePath}" "${cliScript}" -p "${safeTask}"`)
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

export async function startGateway(config: GatewayConfig): Promise<GatewayState> {
  const state: GatewayState = {
    config,
    ws: null,
    connected: false,
    schedules: loadSchedules(),
    clients: new Map(),
    pendingPairings: new Map(),
    reconnectAttempts: 0,
    heartbeatTimer: null,
    schedulerState: null,
    patternTimer: null,
    running: true,
  }

  const gatewayCtx = createGatewayContext(state)
  const tools = getGatewayTools(gatewayCtx)

  // Start the scheduler
  state.schedulerState = createScheduler(state.schedules, gatewayCtx, async (entry: ScheduleEntry) => {
    log(config, `Schedule triggered: ${entry.text}`)
    try {
      const intent = await gatewayLLM(`执行日程任务: ${entry.task}`)
      let finalResult = intent.reply || '已执行'
      
      if (intent.action === 'dispatch') {
        finalResult = await gatewayCtx.dispatchTask(intent.task || entry.task)
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
        const intent = await gatewayLLM(text)

        switch (intent.action) {
          case 'reply': {
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
            sendJSON(state.ws!, {
              type: 'task_started',
              task: intent.task,
              ts: new Date().toISOString(),
            })

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
            sendJSON(state.ws!, {
              type: 'message',
              target: 'client',
              clientId: replyClientId,
              payload: { text: intent.reply || '日程已创建' },
              ts: new Date().toISOString(),
            })
            break
          }
        }
      } catch (err) {
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

    case 'schedule_created':
    case 'task_dispatched':
    case 'notification': {
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
  if (state.ws) {
    state.ws.close()
  }
  console.error(`[Gateway] Hone Gateway 已停止`)
}
