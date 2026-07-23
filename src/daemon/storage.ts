/**
 * Daemon-side JSON file store: messages, schedule runs, agent self-created flags, preferences.
 *
 * Originally used node:sqlite, but node:sqlite has SQLITE_IOERR_FSTAT bugs on Windows.
 * Switched to JSON file storage — simpler, no native deps, sufficient for daemon's data volume.
 * Lives at <HONE_DATA_DIR>/hone-data.json
 */
import * as path from 'path'
import * as fs from 'fs'

interface HoneData {
  messages: StoredMessage[]
  schedule_runs: ScheduleRun[]
  preferences: Record<string, { value: string; updated_at: number }>
  agent_schedules: AgentScheduleInfo[]
  tracked_items: TrackedItem[]
  tracked_item_observations: TrackedItemObservation[]
  agent_recommendations: AgentRecommendation[]
  usage_records: UsageRecord[]
  _ids: { messages: number; runs: number; obs: number; recs: number }
}

// ── Usage / cost tracking ─────────────────────────────────────────────────
export interface UsageRecord {
  /** YYYY-MM-DD */
  date: string
  inputTokens: number
  outputTokens: number
  calls: number
  /** Optional cost in CNY, computed from HONE_TOKEN_PRICE env if set */
  costCny?: number
}

/** Default daily token budget (input+output). 0 = unlimited. Override via HONE_DAILY_TOKEN_BUDGET. */
function getDailyTokenBudget(): number {
  const v = Number(process.env.HONE_DAILY_TOKEN_BUDGET)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Approximate CNY cost per 1M tokens. Override via HONE_TOKEN_PRICE_CNY_PER_MILLION.
 *  Default: DeepSeek-chat pricing ≈ ¥1/M input + ¥2/M output → blended ~¥1.5/M. */
function getTokenPricePerMillion(): { input: number; output: number } {
  const v = Number(process.env.HONE_TOKEN_PRICE_CNY_PER_MILLION)
  if (Number.isFinite(v) && v > 0) return { input: v, output: v }
  return { input: 1, output: 2 }
}

function todayStr(): string {
  // 用本地日期而非 UTC，避免 UTC+8 凌晨 0-8 点时 toISOString 返回前一天。
  // YYYY-MM-DD 格式按本地时区拼接，与用户感知的"今天"一致。
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Record a single LLM call's token usage. Returns updated daily totals (for budget checks). */
export function recordUsage(input: { inputTokens: number; outputTokens: number }): {
  today: UsageRecord
  budgetExceeded: boolean
} {
  const d = loadData()
  if (!d.usage_records) d.usage_records = []

  const today = todayStr()
  let rec = d.usage_records.find(r => r.date === today)
  if (!rec) {
    rec = { date: today, inputTokens: 0, outputTokens: 0, calls: 0 }
    d.usage_records.push(rec)
  }

  rec.inputTokens += input.inputTokens || 0
  rec.outputTokens += input.outputTokens || 0
  rec.calls += 1

  const price = getTokenPricePerMillion()
  rec.costCny = (rec.inputTokens * price.input + rec.outputTokens * price.output) / 1_000_000

  // Cap at 400 days of usage records (older aggregated away)
  if (d.usage_records.length > 400) {
    d.usage_records = d.usage_records.slice(-400)
  }

  scheduleSave()

  const budget = getDailyTokenBudget()
  const totalToday = rec.inputTokens + rec.outputTokens
  const budgetExceeded = budget > 0 && totalToday > budget

  if (budgetExceeded) {
    console.error(`[Usage] ⚠️ 今日 token 用量 ${totalToday} 已超出预算 ${budget}`)
  }

  return { today: { ...rec }, budgetExceeded }
}

export interface UsageStats {
  today: UsageRecord
  thisMonth: { inputTokens: number; outputTokens: number; calls: number; costCny: number }
  total: { inputTokens: number; outputTokens: number; calls: number; costCny: number }
  dailyBudget: number
  todayRemaining: number  // -1 if unlimited
}

export function getUsageStats(): UsageStats {
  const d = loadData()
  if (!d.usage_records) d.usage_records = []

  const today = todayStr()
  const monthPrefix = today.slice(0, 7) // YYYY-MM

  const todayRec = d.usage_records.find(r => r.date === today) || {
    date: today, inputTokens: 0, outputTokens: 0, calls: 0, costCny: 0,
  }

  let monthInput = 0, monthOutput = 0, monthCalls = 0, monthCost = 0
  let totalInput = 0, totalOutput = 0, totalCalls = 0, totalCost = 0
  for (const r of d.usage_records) {
    totalInput += r.inputTokens
    totalOutput += r.outputTokens
    totalCalls += r.calls
    totalCost += r.costCny || 0
    if (r.date.startsWith(monthPrefix)) {
      monthInput += r.inputTokens
      monthOutput += r.outputTokens
      monthCalls += r.calls
      monthCost += r.costCny || 0
    }
  }

  const budget = getDailyTokenBudget()
  const todayTotal = todayRec.inputTokens + todayRec.outputTokens
  return {
    today: todayRec,
    thisMonth: { inputTokens: monthInput, outputTokens: monthOutput, calls: monthCalls, costCny: monthCost },
    total: { inputTokens: totalInput, outputTokens: totalOutput, calls: totalCalls, costCny: totalCost },
    dailyBudget: budget,
    todayRemaining: budget > 0 ? Math.max(0, budget - todayTotal) : -1,
  }
}

let _data: HoneData | null = null
let _saveTimer: ReturnType<typeof setTimeout> | null = null

function getDataDir(): string {
  if (process.env.HONE_DATA_DIR) return process.env.HONE_DATA_DIR
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.hone')
}

function getFilePath(): string {
  return path.join(getDataDir(), 'hone-data.json')
}

function loadData(): HoneData {
  if (_data) return _data
  const dir = getDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const fp = getFilePath()
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8')
      _data = JSON.parse(raw)
      // Ensure all arrays exist
      const d = _data!
      d.messages = d.messages || []
      d.schedule_runs = d.schedule_runs || []
      d.preferences = d.preferences || {}
      d.agent_schedules = d.agent_schedules || []
      d.tracked_items = d.tracked_items || []
      d.tracked_item_observations = d.tracked_item_observations || []
      d.agent_recommendations = d.agent_recommendations || []
      d.usage_records = d.usage_records || []
      d._ids = d._ids || { messages: 0, runs: 0, obs: 0, recs: 0 }
    } else {
      _data = {
        messages: [], schedule_runs: [], preferences: {}, agent_schedules: [],
        tracked_items: [], tracked_item_observations: [], agent_recommendations: [],
        usage_records: [],
        _ids: { messages: 0, runs: 0, obs: 0, recs: 0 },
      }
    }
  } catch (e) {
    console.error('[Storage] 数据文件损坏，备份后重置:', e)
    try {
      const backupPath = fp + `.corrupt-${Date.now()}`
      fs.renameSync(fp, backupPath)
      console.error(`[Storage] 损坏文件已备份到: ${backupPath}`)
    } catch {}
    _data = {
      messages: [], schedule_runs: [], preferences: {}, agent_schedules: [],
      tracked_items: [], tracked_item_observations: [], agent_recommendations: [],
      usage_records: [],
      _ids: { messages: 0, runs: 0, obs: 0, recs: 0 },
    }
  }
  return _data
}

/** Debounced save — coalesces rapid writes into a single file write. */
function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    if (!_data) return
    try {
      // Save 前清理过旧记录，避免文件无限增长。
      // 注意：基于时间的清理比单纯 cap 更可控（防止低频使用时数据快速消失）。
      pruneOldRecords(_data)
      // 原子写入：先写临时文件再 rename，防止崩溃时数据文件被截断/损坏
      // mode 0o600：hone-data.json 含对话历史/持仓等敏感信息，限制为仅 owner 可读写
      const fp = getFilePath()
      const tmp = fp + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(_data, null, 2), { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmp, fp)
      // 文件大小监控：超过 5MB 时打印警告（数据量异常或清理逻辑失效）
      try {
        const stat = fs.statSync(fp)
        if (stat.size > 5 * 1024 * 1024) {
          console.warn(`[Storage] 数据文件较大: ${(stat.size / 1024 / 1024).toFixed(2)}MB，考虑手动清理或检查清理逻辑`)
        }
      } catch {}
    } catch (e: any) {
      console.error(`[Storage] Save failed: ${e.message}`)
    }
  }, 200)
}

/** 基于时间的清理：删除超过保留期的旧记录。
 *  - messages: 保留 30 天
 *  - schedule_runs: 保留 90 天
 *  - tracked_item_observations: 保留 90 天
 *  - agent_recommendations: 保留 180 天（用于长期 review 统计）
 *  - usage_records: 保留 180 天（半年日数据）
 *  对 tracked_items 不做时间清理（用户显式 close 才删除）。
 */
function pruneOldRecords(d: HoneData): void {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const cutoff30 = now - 30 * DAY
  const cutoff90 = now - 90 * DAY
  const cutoff180 = now - 180 * DAY

  const beforeMsg = d.messages.length
  const beforeRuns = d.schedule_runs.length
  const beforeObs = d.tracked_item_observations.length
  const beforeRecs = d.agent_recommendations.length
  const beforeUsage = d.usage_records.length

  if (d.messages.length > 0) {
    d.messages = d.messages.filter(m => m.ts >= cutoff30)
  }
  if (d.schedule_runs.length > 0) {
    d.schedule_runs = d.schedule_runs.filter(r => r.started_at >= cutoff90)
  }
  if (d.tracked_item_observations.length > 0) {
    d.tracked_item_observations = d.tracked_item_observations.filter(o => o.ts >= cutoff90)
  }
  if (d.agent_recommendations.length > 0) {
    d.agent_recommendations = d.agent_recommendations.filter(r => r.ts >= cutoff180)
  }
  if (d.usage_records.length > 0) {
    d.usage_records = d.usage_records.filter(r => {
      // usage_records 的 date 是 YYYY-MM-DD 字符串
      const ts = Date.parse(r.date)
      return Number.isFinite(ts) && ts >= cutoff180
    })
  }

  // 仅在发生清理时打印（避免日志噪音）
  const totalPruned = (beforeMsg - d.messages.length)
    + (beforeRuns - d.schedule_runs.length)
    + (beforeObs - d.tracked_item_observations.length)
    + (beforeRecs - d.agent_recommendations.length)
    + (beforeUsage - d.usage_records.length)
  if (totalPruned > 0) {
    console.log(`[Storage] 清理旧记录: messages -${beforeMsg - d.messages.length}, runs -${beforeRuns - d.schedule_runs.length}, obs -${beforeObs - d.tracked_item_observations.length}, recs -${beforeRecs - d.agent_recommendations.length}, usage -${beforeUsage - d.usage_records.length}`)
  }
}

/** Flush pending writes immediately (used on shutdown). */
export function closeDb(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer)
    _saveTimer = null
  }
  if (_data) {
    // 原子写入：先写 .tmp 再 rename，防止写入过程中崩溃导致数据库文件被截断
    try {
      const finalPath = getFilePath()
      const tmpPath = finalPath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(_data, null, 2), { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmpPath, finalPath)
    } catch {}
  }
  _data = null
}

// ── Messages ──────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number
  ts: number
  direction: 'in' | 'out' | 'system'
  text: string
  intent_action?: string
  intent_task?: string
  result_text?: string
  client_id?: string
}

export function recordMessage(m: Omit<StoredMessage, 'id'>): void {
  const d = loadData()
  d._ids.messages = (d._ids.messages || 0) + 1
  d.messages.push({ ...m, id: d._ids.messages })
  // Cap at 2000 messages
  if (d.messages.length > 2000) d.messages = d.messages.slice(-2000)
  scheduleSave()
}

export function getRecentMessages(limit: number = 20): StoredMessage[] {
  const d = loadData()
  return d.messages.slice(-limit).reverse()
}

// ── Schedule runs ─────────────────────────────────────────────────────────

export interface ScheduleRun {
  id: number
  schedule_id: string
  started_at: number
  finished_at?: number
  status?: 'ok' | 'fail'
  result?: string
  error?: string
  duration_ms?: number
}

export function startRun(scheduleId: string): number {
  const d = loadData()
  d._ids.runs = (d._ids.runs || 0) + 1
  const run: ScheduleRun = { id: d._ids.runs, schedule_id: scheduleId, started_at: Date.now() }
  d.schedule_runs.push(run)
  scheduleSave()
  return run.id
}

export function finishRun(
  runId: number,
  status: 'ok' | 'fail',
  result?: string,
  error?: string,
): void {
  const d = loadData()
  const run = d.schedule_runs.find(r => r.id === runId)
  if (run) {
    run.finished_at = Date.now()
    run.status = status
    run.result = result
    run.error = error
    run.duration_ms = run.finished_at - run.started_at
  }
  scheduleSave()
}

export function getScheduleRuns(scheduleId: string, limit: number = 50): ScheduleRun[] {
  const d = loadData()
  return d.schedule_runs
    .filter(r => r.schedule_id === scheduleId)
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, limit)
}

// ── Preferences ───────────────────────────────────────────────────────────

export function setPref(key: string, value: unknown): void {
  const d = loadData()
  d.preferences[key] = { value: JSON.stringify(value), updated_at: Date.now() }
  scheduleSave()
}

export function getPref<T = unknown>(key: string, fallback?: T): T | undefined {
  const d = loadData()
  const p = d.preferences[key]
  if (!p) return fallback
  try { return JSON.parse(p.value) as T } catch { return fallback }
}

export function listPrefs(): Record<string, unknown> {
  const d = loadData()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d.preferences)) {
    try { out[k] = JSON.parse(v.value) } catch { out[k] = v.value }
  }
  return out
}

// ── Agent-created schedule markers ────────────────────────────────────────

export function markScheduleAgentCreated(
  scheduleId: string,
  confidence: number,
  sourcePattern: string,
): void {
  const d = loadData()
  if (!d.agent_schedules.find(s => s.schedule_id === scheduleId)) {
    d.agent_schedules.push({
      schedule_id: scheduleId,
      created_at: Date.now(),
      confidence,
      source_pattern: sourcePattern,
      user_corrected: false,
    })
    scheduleSave()
  }
}

export function markScheduleCorrected(scheduleId: string): void {
  const d = loadData()
  const s = d.agent_schedules.find(s => s.schedule_id === scheduleId)
  if (s) { s.user_corrected = true; scheduleSave() }
}

export interface AgentScheduleInfo {
  schedule_id: string
  created_at: number
  confidence: number
  source_pattern?: string
  user_corrected: boolean
}

export function getAgentScheduleInfo(scheduleId: string): AgentScheduleInfo | null {
  const d = loadData()
  return d.agent_schedules.find(s => s.schedule_id === scheduleId) || null
}

export function listAgentSchedules(): AgentScheduleInfo[] {
  const d = loadData()
  return d.agent_schedules.slice().sort((a, b) => b.created_at - a.created_at)
}

// ── Tracked items (positions, watchlist, deadlines, anything) ────────────

export type TrackedItemKind = 'stock' | 'job' | 'deadline' | 'topic' | 'project' | string
export type TrackedItemStatus = 'watching' | 'committed' | 'closed' | 'archived'
export type Signal = 'none' | 'buy' | 'sell' | 'alert'

export interface TrackedItem {
  id: string
  kind: TrackedItemKind
  identifier: string
  display_name?: string
  user_position?: Record<string, unknown>
  status: TrackedItemStatus
  notes?: string
  created_at: number
  updated_at: number
  closed_at?: number
  monitor_schedule_id?: string
}

/** Create or upsert a tracked item by (kind, identifier). Returns the id. */
export function upsertTrackedItem(input: {
  kind: TrackedItemKind
  identifier: string
  display_name?: string
  user_position?: Record<string, unknown>
  status?: TrackedItemStatus
  notes?: string
  monitor_schedule_id?: string
}): string {
  const d = loadData()
  const now = Date.now()
  const existing = d.tracked_items.find(
    t => t.kind === input.kind && t.identifier === input.identifier
  )
  if (existing) {
    if (input.display_name !== undefined) existing.display_name = input.display_name
    if (input.user_position !== undefined) existing.user_position = input.user_position
    if (input.status !== undefined) existing.status = input.status
    if (input.notes !== undefined) existing.notes = input.notes
    if (input.monitor_schedule_id !== undefined) existing.monitor_schedule_id = input.monitor_schedule_id
    existing.updated_at = now
    scheduleSave()
    return existing.id
  }
  const id = `ti_${input.kind}_${input.identifier}_${now}`
  const item: TrackedItem = {
    id,
    kind: input.kind,
    identifier: input.identifier,
    display_name: input.display_name,
    user_position: input.user_position,
    status: input.status ?? 'watching',
    notes: input.notes,
    created_at: now,
    updated_at: now,
    monitor_schedule_id: input.monitor_schedule_id,
  }
  d.tracked_items.push(item)
  scheduleSave()
  return id
}

export function listTrackedItems(filter?: { kind?: TrackedItemKind; status?: TrackedItemStatus }): TrackedItem[] {
  const d = loadData()
  let items = d.tracked_items.slice()
  if (filter?.kind) items = items.filter(t => t.kind === filter.kind)
  if (filter?.status) items = items.filter(t => t.status === filter.status)
  return items.sort((a, b) => b.updated_at - a.updated_at)
}

export function getTrackedItem(id: string): TrackedItem | null {
  const d = loadData()
  return d.tracked_items.find(t => t.id === id) || null
}

export function getTrackedItemByIdentifier(kind: TrackedItemKind, identifier: string): TrackedItem | null {
  const d = loadData()
  return d.tracked_items.find(t => t.kind === kind && t.identifier === identifier) || null
}

export function closeTrackedItem(id: string, notes?: string): void {
  const d = loadData()
  const item = d.tracked_items.find(t => t.id === id)
  if (item) {
    item.status = 'closed'
    item.closed_at = Date.now()
    item.updated_at = Date.now()
    if (notes) item.notes = notes
    scheduleSave()
  }
}

export function removeTrackedItem(id: string): void {
  const d = loadData()
  d.tracked_items = d.tracked_items.filter(t => t.id !== id)
  d.tracked_item_observations = d.tracked_item_observations.filter(o => o.item_id !== id)
  d.agent_recommendations = d.agent_recommendations.filter(r => r.item_id !== id)
  scheduleSave()
}

// ── Observations ──────────────────────────────────────────────────────────

export interface TrackedItemObservation {
  id: number
  item_id: string
  ts: number
  data: Record<string, unknown>
  agent_assessment?: string
  signal?: Signal
}

export function recordObservation(input: {
  item_id: string
  data: Record<string, unknown>
  agent_assessment?: string
  signal?: Signal
}): number {
  const d = loadData()
  d._ids.obs = (d._ids.obs || 0) + 1
  const obs: TrackedItemObservation = {
    id: d._ids.obs,
    item_id: input.item_id,
    ts: Date.now(),
    data: input.data,
    agent_assessment: input.agent_assessment,
    signal: input.signal,
  }
  d.tracked_item_observations.push(obs)
  // Cap at 5000 observations
  if (d.tracked_item_observations.length > 5000) {
    d.tracked_item_observations = d.tracked_item_observations.slice(-5000)
  }
  scheduleSave()
  return obs.id
}

export function getObservations(itemId: string, limit: number = 50): TrackedItemObservation[] {
  const d = loadData()
  return d.tracked_item_observations
    .filter(o => o.item_id === itemId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

export function getLatestObservation(itemId: string): TrackedItemObservation | null {
  const obs = getObservations(itemId, 1)
  return obs[0] || null
}

// ── Agent recommendations (review corpus) ─────────────────────────────────

export type RecResponse = 'accepted' | 'rejected' | 'ignored'
export type RecOutcome = 'good' | 'bad'

export interface AgentRecommendation {
  id: number
  item_id?: string
  ts: number
  recommendation: string
  reasoning?: string
  user_response?: RecResponse
  outcome?: RecOutcome
  outcome_notes?: string
  reviewed_at?: number
}

export function recordRecommendation(input: {
  item_id?: string
  recommendation: string
  reasoning?: string
}): number {
  const d = loadData()
  d._ids.recs = (d._ids.recs || 0) + 1
  const rec: AgentRecommendation = {
    id: d._ids.recs,
    item_id: input.item_id,
    ts: Date.now(),
    recommendation: input.recommendation,
    reasoning: input.reasoning,
  }
  d.agent_recommendations.push(rec)
  scheduleSave()
  return rec.id
}

export function updateRecommendationResponse(id: number, response: RecResponse): void {
  const d = loadData()
  const rec = d.agent_recommendations.find(r => r.id === id)
  if (rec) { rec.user_response = response; scheduleSave() }
}

export function reviewRecommendation(id: number, outcome: RecOutcome, notes?: string): void {
  const d = loadData()
  const rec = d.agent_recommendations.find(r => r.id === id)
  if (rec) { rec.outcome = outcome; rec.outcome_notes = notes; rec.reviewed_at = Date.now(); scheduleSave() }
}

export function getRecommendations(itemId?: string, limit: number = 50): AgentRecommendation[] {
  const d = loadData()
  let recs = d.agent_recommendations.slice()
  if (itemId) recs = recs.filter(r => r.item_id === itemId)
  return recs.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/** Compute recent track record: how many recs reviewed, and how many were good. */
export function getRecommendationStats(itemId?: string): { total: number; reviewed: number; good: number; bad: number } {
  const d = loadData()
  let recs = d.agent_recommendations
  if (itemId) recs = recs.filter(r => r.item_id === itemId)
  return {
    total: recs.length,
    reviewed: recs.filter(r => r.outcome).length,
    good: recs.filter(r => r.outcome === 'good').length,
    bad: recs.filter(r => r.outcome === 'bad').length,
  }
}
