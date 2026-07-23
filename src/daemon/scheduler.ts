/**
 * Enhanced scheduler with full cron support and disk persistence.
 *
 * Supports standard cron expressions:
 *   "* * * * *"   (minute hour day month weekday)
 *   "star/5 * * * *" (step values)
 *   "1-5 * * * *" (ranges)
 *   "1,3,5 * * *" (lists)
 *   "1-5,10-15/2 * * *" (combined)
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ScheduleEntry, GatewayContext } from './tools.js'

// ── Cron parser ──

const FIELD_NAMES = ['minute', 'hour', 'day', 'month', 'weekday'] as const
const FIELD_CONSTRAINTS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 6],
}

// Named values
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/**
 * Parse a single cron field into a matcher function.
 * Supports: star, star/N, N, N-M, N,M,O, N-M/step, named values
 */
function parseField(field: string, name: string): (val: number) => boolean {
  const [min, max] = FIELD_CONSTRAINTS[name]
  const parts = field.split(',')

  const matchers = parts.map(part => {
    let step = 1
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/')
      part = range
      step = parseInt(stepStr, 10)
      if (isNaN(step) || step < 1) step = 1
    }

    if (part === '*') {
      return (val: number) => (val - min) % step === 0
    }

    if (part.includes('-')) {
      let [rangeStart, rangeEnd] = part.split('-')
      let startNum = resolveName(rangeStart, name)
      let endNum = resolveName(rangeEnd, name)
      if (startNum === null || endNum === null) return () => false
      return (val: number) => val >= startNum! && val <= endNum! && (val - startNum!) % step === 0
    }

    const exactNum = resolveName(part, name)
    if (exactNum === null) return () => false

    // Only validate step for single values: step===1 means exact match, step>1 means "every Nth from this value"
    return (val: number) => val === exactNum
  })

  return (val: number) => matchers.some(m => m(val))
}

function resolveName(value: string, fieldName: string): number | null {
  const lower = value.toLowerCase()
  if (fieldName === 'month' && MONTH_NAMES[lower] !== undefined) return MONTH_NAMES[lower]
  if (fieldName === 'weekday' && WEEKDAY_NAMES[lower] !== undefined) return WEEKDAY_NAMES[lower]
  const num = parseInt(value, 10)
  if (isNaN(num)) return null
  return num
}

/**
 * Parse a cron expression into individual field matchers.
 * Returns null if the expression is invalid.
 */
function parseCron(expression: string): ((now: Date) => boolean) | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null

  try {
    const matchers = fields.map((f, i) => parseField(f, FIELD_NAMES[i]))

    return (now: Date): boolean => {
      const values = [
        now.getMinutes(),
        now.getHours(),
        now.getDate(),
        now.getMonth() + 1,
        now.getDay(),
      ]
      return values.every((v, i) => matchers[i](v))
    }
  } catch {
    return null
  }
}

/**
 * Validate a cron expression. Returns the cleaned expression or null.
 */
export function validateCron(expression: string): string | null {
  const fn = parseCron(expression)
  return fn ? expression.trim() : null
}

/**
 * Get next trigger time for a cron expression, up to `maxLookaheadMs` from now.
 */
export function nextCronTime(expression: string, maxLookaheadMs: number = 7 * 24 * 3600_000): number | null {
  const fn = parseCron(expression)
  if (!fn) return null

  const now = new Date()
  const end = now.getTime() + maxLookaheadMs
  // Check every minute
  const cursor = new Date(now)
  cursor.setSeconds(0, 0)

  for (let t = cursor.getTime() + 60_000; t < end; t += 60_000) {
    const d = new Date(t)
    if (fn(d)) return t
  }
  return null
}

// ── Schedule persistence ──

export interface PersistedSchedule {
  id: string
  text: string
  trigger: { type: string; cron?: string; ms?: number; at?: number }
  task: string
  delivery: 'notify' | 'execute' | 'both'
  enabled: boolean
  createdAt: number
  lastTriggeredAt?: number
  lastStatus?: 'ok' | 'fail'
}

function getStorePath(): string {
  // Use HONE_DATA_DIR if set (Tauri desktop manages the daemon), otherwise ~/.hone
  if (process.env.HONE_DATA_DIR) {
    const dir = process.env.HONE_DATA_DIR
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'schedules.json')
  }
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  const dir = path.join(home, '.hone')
  return path.join(dir, 'schedules.json')
}

export function loadSchedules(): Map<string, ScheduleEntry> {
  const maps = new Map<string, ScheduleEntry>()
  try {
    const data = fs.readFileSync(getStorePath(), 'utf-8')
    const entries: PersistedSchedule[] = JSON.parse(data)
    for (const e of entries) {
      const trigger = e.trigger.type === 'cron'
        ? { type: 'cron' as const, cron: e.trigger.cron || '* * * * *' }
        : e.trigger.type === 'interval'
          ? { type: 'interval' as const, ms: e.trigger.ms || 3600_000 }
          : { type: 'one-time' as const, at: e.trigger.at || Date.now() }

      maps.set(e.id, {
        id: e.id,
        text: e.text,
        trigger,
        task: e.task,
        delivery: e.delivery,
        enabled: e.enabled,
        createdAt: e.createdAt,
        lastTriggeredAt: e.lastTriggeredAt,
        lastStatus: e.lastStatus,
      })
    }
    console.error(`[Scheduler] 从磁盘加载了 ${maps.size} 条日程`)
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return maps
}

export function saveSchedules(schedules: Map<string, ScheduleEntry>): void {
  try {
    const dir = path.dirname(getStorePath())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const entries: PersistedSchedule[] = []
    for (const [, e] of schedules) {
      entries.push({
        id: e.id,
        text: e.text,
        trigger: e.trigger.type === 'cron'
          ? { type: 'cron', cron: e.trigger.cron }
          : e.trigger.type === 'interval'
            ? { type: 'interval', ms: e.trigger.ms }
            : { type: 'one-time', at: e.trigger.at },
        task: e.task,
        delivery: e.delivery,
        enabled: e.enabled,
        createdAt: e.createdAt,
        lastTriggeredAt: e.lastTriggeredAt,
        lastStatus: e.lastStatus,
      })
    }
    // 原子写入：先写临时文件再 rename，防止崩溃时 schedules.json 被截断/损坏
    const storePath = getStorePath()
    const tmp = storePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, storePath)
  } catch (err) {
    console.error(`[Scheduler] 保存日程失败: ${err}`)
  }
}

// ── Scheduler state ──

interface SchedulerState {
  schedules: Map<string, ScheduleEntry>
  timers: Map<string, ReturnType<typeof setTimeout>>
  cronCache: Map<string, (now: Date) => boolean>
  ctx: GatewayContext
  onTrigger: (entry: ScheduleEntry) => Promise<void>
  /** Last observed schedule-store modification time for desktop edits. */
  storeMtimeMs: number
}

const CHECK_INTERVAL_MS = 30_000

export function createScheduler(
  schedules: Map<string, ScheduleEntry>,
  ctx: GatewayContext,
  onTrigger: (entry: ScheduleEntry) => Promise<void>,
): SchedulerState {
  const state: SchedulerState = {
    schedules,
    timers: new Map(),
    cronCache: new Map(),
    ctx,
    onTrigger,
    storeMtimeMs: getStoreMtimeMs(),
  }

  const interval = setInterval(() => checkAll(state), CHECK_INTERVAL_MS)
  state.timers.set('__global__', interval as unknown as ReturnType<typeof setTimeout>)

  // Initial check after a short delay
  const initialTimer = setTimeout(() => checkAll(state), 2000)
  state.timers.set('__initial__', initialTimer as unknown as ReturnType<typeof setTimeout>)

  return state
}

function getStoreMtimeMs(): number {
  try {
    return fs.statSync(getStorePath()).mtimeMs
  } catch {
    return 0
  }
}

function refreshSchedulesFromStore(state: SchedulerState): void {
  const currentMtime = getStoreMtimeMs()
  if (currentMtime <= state.storeMtimeMs) return

  const stored = loadSchedules()
  // 磁盘返回空但内存非空时跳过本次 reload：避免外部编辑或半截写入导致
  // schedules.json 损坏时，loadSchedules 静默返回空 Map，refresh 清空内存，
  // 下次 saveSchedules 把空数组持久化覆盖磁盘，所有日程永久丢失。
  if (stored.size === 0 && state.schedules.size > 0) {
    console.error(
      `[Scheduler] 磁盘 schedules.json 为空但内存有 ${state.schedules.size} 条日程，跳过 reload（可能磁盘文件损坏）`,
    )
    state.storeMtimeMs = currentMtime
    return
  }
  state.schedules.clear()
  for (const [id, entry] of stored) state.schedules.set(id, entry)
  state.cronCache.clear()
  state.storeMtimeMs = currentMtime
  console.error(`[Scheduler] Reloaded ${state.schedules.size} schedules edited by desktop`)
}

function checkAll(state: SchedulerState): void {
  // The desktop UI writes the same HONE_DATA_DIR/schedules.json file. Reload
  // before evaluation so saving, pausing, or deleting a schedule takes effect
  // without a daemon restart and without a second scheduler process.
  refreshSchedulesFromStore(state)
  const now = new Date()
  for (const [, entry] of state.schedules) {
    if (!entry.enabled) continue

    let shouldTrigger = false
    // 如果是 catch-up 触发，记录匹配时间点（用于更新 lastTriggeredAt）
    let catchUpTriggeredAt: number | null = null

    if (entry.trigger.type === 'cron') {
      let matcher = state.cronCache.get(entry.trigger.cron)
      if (!matcher) {
        const fn = parseCron(entry.trigger.cron)
        if (!fn) continue // Invalid cron expression
        matcher = fn
        state.cronCache.set(entry.trigger.cron, fn)
      }
      shouldTrigger = matcher(now)
      // catch-up：回溯检查错过的触发。
      // 限制延长到 24 小时（原 60 分钟太短，笔记本睡眠一晚后会丢失所有早间任务）。
      // 仍只触发一次（不重复补做），避免大量积压任务一次性涌入。
      if (!shouldTrigger && entry.lastTriggeredAt) {
        const gapMs = now.getTime() - entry.lastTriggeredAt
        if (gapMs > 60_000) {
          const cursor = new Date(entry.lastTriggeredAt)
          cursor.setSeconds(0, 0)
          const maxBacktrack = Math.min(gapMs, 24 * 60 * 60_000)
          const endTime = cursor.getTime() + maxBacktrack
          for (let t = cursor.getTime() + 60_000; t <= now.getTime() && t <= endTime; t += 60_000) {
            if (matcher(new Date(t))) {
              shouldTrigger = true
              catchUpTriggeredAt = t
              break
            }
          }
        }
      }
      // 如果是 catch-up 触发，把 lastTriggeredAt 设为匹配点（而非 now），
      // 这样如果错过多次（如每 30 分钟的 cron 错过 2 小时），下次 tick
      // 会从匹配点继续 catch-up，逐步补做剩余的错过触发。
      // 但为了避免一次 tick 内连续触发多次，仍只触发一次。
      if (shouldTrigger && catchUpTriggeredAt !== null) {
        entry.lastTriggeredAt = catchUpTriggeredAt
      }
    } else if (entry.trigger.type === 'interval') {
      const lastTrigger = entry.lastTriggeredAt || 0
      shouldTrigger = now.getTime() - lastTrigger >= entry.trigger.ms
    } else if (entry.trigger.type === 'one-time') {
      const lastTrigger = entry.lastTriggeredAt || 0
      shouldTrigger = lastTrigger === 0 && now.getTime() >= entry.trigger.at
    }

    if (shouldTrigger) {
      // Prevent double-fire within the same minute or overlap
      const lastTrigger = entry.lastTriggeredAt || 0
      const nowMs = now.getTime()

      // CRITICAL: Robust double-fire protection
      // For cron tasks (* * * * *), we check if we've already run in this specific minute.
      if (entry.trigger.type === 'cron') {
        const lastRunDate = new Date(lastTrigger)
        if (
          lastRunDate.getMinutes() === now.getMinutes() &&
          lastRunDate.getHours() === now.getHours() &&
          lastRunDate.getDate() === now.getDate() &&
          lastRunDate.getMonth() === now.getMonth() &&
          lastRunDate.getFullYear() === now.getFullYear()
        ) {
          continue
        }
      } else {
        // For intervals/one-time, standard 60s debounce is fine
        if (nowMs - lastTrigger < 60_000) continue
      }

      // 如果是 catch-up 触发，lastTriggeredAt 已被设为匹配点（见上方 catch-up 逻辑），
      // 保留该值以便下次 tick 继续补做剩余的错过触发；
      // 否则设为 nowMs（常规触发）。
      if (!catchUpTriggeredAt) {
        entry.lastTriggeredAt = nowMs
      }
      entry.lastStatus = undefined
      void state.onTrigger(entry).then(() => {
        // Persist after each trigger
        saveSchedules(state.schedules)
      }).catch(err => {
        console.error('[Scheduler] onTrigger error:', err)
        // 即使触发失败也要持久化 lastTriggeredAt，防止进程重启后
        // catch-up 逻辑回溯检查到旧值导致重复触发
        saveSchedules(state.schedules)
      })
    }
  }
}

export function stopScheduler(state: SchedulerState): void {
  for (const [, timer] of state.timers) {
    clearTimeout(timer)
  }
  state.timers.clear()
  state.cronCache.clear()
  // Final save on shutdown
  saveSchedules(state.schedules)
}
