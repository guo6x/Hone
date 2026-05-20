/**
 * Daemon-side SQLite store: messages, schedule runs, agent self-created flags, preferences.
 *
 * Uses Node 22's built-in `node:sqlite` — no native module install needed.
 * Lives at <HONE_DATA_DIR>/hone.db (shared with desktop, which reads via Tauri IPC).
 */
import { DatabaseSync } from 'node:sqlite'
import * as path from 'path'
import * as fs from 'fs'

let _db: DatabaseSync | null = null

function getDataDir(): string {
  if (process.env.HONE_DATA_DIR) return process.env.HONE_DATA_DIR
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  return path.join(home, '.hone')
}

export function getDb(): DatabaseSync {
  if (_db) return _db
  const dir = getDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'hone.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL,          -- 'in' (user→gateway) | 'out' (gateway→user) | 'system'
      text TEXT NOT NULL,
      intent_action TEXT,                -- 'reply' | 'dispatch' | 'schedule' | 'browser'
      intent_task TEXT,
      result_text TEXT,
      client_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT,                       -- 'ok' | 'fail'
      result TEXT,
      error TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runs_sched ON schedule_runs(schedule_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_schedules (
      schedule_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      confidence REAL NOT NULL,
      source_pattern TEXT,
      user_corrected INTEGER NOT NULL DEFAULT 0   -- 1 if user has modified/disabled
    );

    -- Generic "things the user committed me to track".
    -- kind = 'stock' | 'job' | 'deadline' | 'topic' | 'project' | anything else.
    -- user_position is a free-form JSON describing the user's commitment:
    --   for stocks: { shares, avg_cost, broker?, broker_authorized? }
    --   for jobs:   { stage, company, role, contact }
    --   for deadlines: { due_at, what }
    CREATE TABLE IF NOT EXISTS tracked_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      identifier TEXT NOT NULL,
      display_name TEXT,
      user_position TEXT,                 -- JSON
      status TEXT NOT NULL,               -- 'watching' | 'committed' | 'closed' | 'archived'
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      monitor_schedule_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_kind ON tracked_items(kind, status);
    CREATE INDEX IF NOT EXISTS idx_tracked_identifier ON tracked_items(identifier);

    -- Snapshots from each periodic check (price, agent's interpretation, signal).
    CREATE TABLE IF NOT EXISTS tracked_item_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data_json TEXT NOT NULL,            -- raw observation
      agent_assessment TEXT,
      signal TEXT,                        -- 'none' | 'buy' | 'sell' | 'alert'
      FOREIGN KEY (item_id) REFERENCES tracked_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_item ON tracked_item_observations(item_id, ts DESC);

    -- Every recommendation the agent made (incl. for non-tracked things).
    -- item_id may be NULL for one-off advice. user_response/outcome filled in over time.
    CREATE TABLE IF NOT EXISTS agent_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      ts INTEGER NOT NULL,
      recommendation TEXT NOT NULL,
      reasoning TEXT,
      user_response TEXT,                 -- 'accepted' | 'rejected' | 'ignored' | NULL
      outcome TEXT,                       -- 'good' | 'bad' | NULL
      outcome_notes TEXT,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rec_item ON agent_recommendations(item_id, ts DESC);
  `)
  _db = db
  return db
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
  const db = getDb()
  db.prepare(
    `INSERT INTO messages (ts, direction, text, intent_action, intent_task, result_text, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.ts,
    m.direction,
    m.text,
    m.intent_action ?? null,
    m.intent_task ?? null,
    m.result_text ?? null,
    m.client_id ?? null,
  )
}

export function getRecentMessages(limit: number = 20): StoredMessage[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, ts, direction, text, intent_action, intent_task, result_text, client_id
     FROM messages ORDER BY ts DESC LIMIT ?`,
  ).all(limit) as any[]
  return rows.reverse().map(r => ({
    id: r.id,
    ts: r.ts,
    direction: r.direction,
    text: r.text,
    intent_action: r.intent_action ?? undefined,
    intent_task: r.intent_task ?? undefined,
    result_text: r.result_text ?? undefined,
    client_id: r.client_id ?? undefined,
  }))
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
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO schedule_runs (schedule_id, started_at) VALUES (?, ?)`,
  ).run(scheduleId, Date.now())
  return Number(info.lastInsertRowid)
}

export function finishRun(
  runId: number,
  status: 'ok' | 'fail',
  result?: string,
  error?: string,
): void {
  const db = getDb()
  const finishedAt = Date.now()
  const row = db.prepare(`SELECT started_at FROM schedule_runs WHERE id = ?`).get(runId) as any
  const durationMs = row?.started_at ? finishedAt - row.started_at : null
  db.prepare(
    `UPDATE schedule_runs SET finished_at = ?, status = ?, result = ?, error = ?, duration_ms = ?
     WHERE id = ?`,
  ).run(finishedAt, status, result ?? null, error ?? null, durationMs, runId)
}

export function getScheduleRuns(scheduleId: string, limit: number = 50): ScheduleRun[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, schedule_id, started_at, finished_at, status, result, error, duration_ms
     FROM schedule_runs WHERE schedule_id = ?
     ORDER BY started_at DESC LIMIT ?`,
  ).all(scheduleId, limit) as any[]
  return rows.map(r => ({
    id: r.id,
    schedule_id: r.schedule_id,
    started_at: r.started_at,
    finished_at: r.finished_at ?? undefined,
    status: r.status ?? undefined,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    duration_ms: r.duration_ms ?? undefined,
  }))
}

// ── Preferences ───────────────────────────────────────────────────────────

export function setPref(key: string, value: unknown): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now())
}

export function getPref<T = unknown>(key: string, fallback?: T): T | undefined {
  const db = getDb()
  const row = db.prepare(`SELECT value FROM preferences WHERE key = ?`).get(key) as any
  if (!row) return fallback
  try { return JSON.parse(row.value) as T } catch { return fallback }
}

export function listPrefs(): Record<string, unknown> {
  const db = getDb()
  const rows = db.prepare(`SELECT key, value FROM preferences`).all() as any[]
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value) } catch { out[r.key] = r.value }
  }
  return out
}

// ── Agent-created schedule markers ────────────────────────────────────────

export function markScheduleAgentCreated(
  scheduleId: string,
  confidence: number,
  sourcePattern: string,
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO agent_schedules (schedule_id, created_at, confidence, source_pattern)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(schedule_id) DO NOTHING`,
  ).run(scheduleId, Date.now(), confidence, sourcePattern)
}

export function markScheduleCorrected(scheduleId: string): void {
  const db = getDb()
  db.prepare(
    `UPDATE agent_schedules SET user_corrected = 1 WHERE schedule_id = ?`,
  ).run(scheduleId)
}

export interface AgentScheduleInfo {
  schedule_id: string
  created_at: number
  confidence: number
  source_pattern?: string
  user_corrected: boolean
}

export function getAgentScheduleInfo(scheduleId: string): AgentScheduleInfo | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT schedule_id, created_at, confidence, source_pattern, user_corrected
     FROM agent_schedules WHERE schedule_id = ?`,
  ).get(scheduleId) as any
  if (!row) return null
  return {
    schedule_id: row.schedule_id,
    created_at: row.created_at,
    confidence: row.confidence,
    source_pattern: row.source_pattern ?? undefined,
    user_corrected: !!row.user_corrected,
  }
}

export function listAgentSchedules(): AgentScheduleInfo[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT schedule_id, created_at, confidence, source_pattern, user_corrected
     FROM agent_schedules ORDER BY created_at DESC`,
  ).all() as any[]
  return rows.map(r => ({
    schedule_id: r.schedule_id,
    created_at: r.created_at,
    confidence: r.confidence,
    source_pattern: r.source_pattern ?? undefined,
    user_corrected: !!r.user_corrected,
  }))
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

function rowToItem(r: any): TrackedItem {
  let pos: Record<string, unknown> | undefined
  if (r.user_position) {
    try { pos = JSON.parse(r.user_position) } catch {}
  }
  return {
    id: r.id,
    kind: r.kind,
    identifier: r.identifier,
    display_name: r.display_name ?? undefined,
    user_position: pos,
    status: r.status,
    notes: r.notes ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at ?? undefined,
    monitor_schedule_id: r.monitor_schedule_id ?? undefined,
  }
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
  const db = getDb()
  const now = Date.now()
  const existing = db.prepare(
    `SELECT id FROM tracked_items WHERE kind = ? AND identifier = ?`,
  ).get(input.kind, input.identifier) as any
  if (existing) {
    db.prepare(
      `UPDATE tracked_items
       SET display_name = COALESCE(?, display_name),
           user_position = COALESCE(?, user_position),
           status = COALESCE(?, status),
           notes = COALESCE(?, notes),
           monitor_schedule_id = COALESCE(?, monitor_schedule_id),
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.display_name ?? null,
      input.user_position ? JSON.stringify(input.user_position) : null,
      input.status ?? null,
      input.notes ?? null,
      input.monitor_schedule_id ?? null,
      now,
      existing.id,
    )
    return existing.id
  }
  const id = `ti_${input.kind}_${input.identifier}_${now}`
  db.prepare(
    `INSERT INTO tracked_items
     (id, kind, identifier, display_name, user_position, status, notes, created_at, updated_at, monitor_schedule_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.identifier,
    input.display_name ?? null,
    input.user_position ? JSON.stringify(input.user_position) : null,
    input.status ?? 'watching',
    input.notes ?? null,
    now,
    now,
    input.monitor_schedule_id ?? null,
  )
  return id
}

export function listTrackedItems(filter?: { kind?: TrackedItemKind; status?: TrackedItemStatus }): TrackedItem[] {
  const db = getDb()
  let q = `SELECT * FROM tracked_items WHERE 1=1`
  const args: any[] = []
  if (filter?.kind) { q += ` AND kind = ?`; args.push(filter.kind) }
  if (filter?.status) { q += ` AND status = ?`; args.push(filter.status) }
  q += ` ORDER BY updated_at DESC`
  return (db.prepare(q).all(...args) as any[]).map(rowToItem)
}

export function getTrackedItem(id: string): TrackedItem | null {
  const db = getDb()
  const r = db.prepare(`SELECT * FROM tracked_items WHERE id = ?`).get(id) as any
  return r ? rowToItem(r) : null
}

export function getTrackedItemByIdentifier(kind: TrackedItemKind, identifier: string): TrackedItem | null {
  const db = getDb()
  const r = db.prepare(
    `SELECT * FROM tracked_items WHERE kind = ? AND identifier = ?`,
  ).get(kind, identifier) as any
  return r ? rowToItem(r) : null
}

export function closeTrackedItem(id: string, notes?: string): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `UPDATE tracked_items SET status = 'closed', closed_at = ?, updated_at = ?, notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(now, now, notes ?? null, id)
}

export function removeTrackedItem(id: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM tracked_item_observations WHERE item_id = ?`).run(id)
  db.prepare(`DELETE FROM agent_recommendations WHERE item_id = ?`).run(id)
  db.prepare(`DELETE FROM tracked_items WHERE id = ?`).run(id)
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
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO tracked_item_observations (item_id, ts, data_json, agent_assessment, signal)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.item_id,
    Date.now(),
    JSON.stringify(input.data),
    input.agent_assessment ?? null,
    input.signal ?? null,
  )
  return Number(info.lastInsertRowid)
}

export function getObservations(itemId: string, limit: number = 50): TrackedItemObservation[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, item_id, ts, data_json, agent_assessment, signal
     FROM tracked_item_observations WHERE item_id = ?
     ORDER BY ts DESC LIMIT ?`,
  ).all(itemId, limit) as any[]
  return rows.map(r => ({
    id: r.id,
    item_id: r.item_id,
    ts: r.ts,
    data: (() => { try { return JSON.parse(r.data_json) } catch { return {} } })(),
    agent_assessment: r.agent_assessment ?? undefined,
    signal: r.signal ?? undefined,
  }))
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
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO agent_recommendations (item_id, ts, recommendation, reasoning)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.item_id ?? null,
    Date.now(),
    input.recommendation,
    input.reasoning ?? null,
  )
  return Number(info.lastInsertRowid)
}

export function updateRecommendationResponse(id: number, response: RecResponse): void {
  const db = getDb()
  db.prepare(
    `UPDATE agent_recommendations SET user_response = ? WHERE id = ?`,
  ).run(response, id)
}

export function reviewRecommendation(id: number, outcome: RecOutcome, notes?: string): void {
  const db = getDb()
  db.prepare(
    `UPDATE agent_recommendations SET outcome = ?, outcome_notes = ?, reviewed_at = ? WHERE id = ?`,
  ).run(outcome, notes ?? null, Date.now(), id)
}

export function getRecommendations(itemId?: string, limit: number = 50): AgentRecommendation[] {
  const db = getDb()
  const sql = itemId
    ? `SELECT * FROM agent_recommendations WHERE item_id = ? ORDER BY ts DESC LIMIT ?`
    : `SELECT * FROM agent_recommendations ORDER BY ts DESC LIMIT ?`
  const args = itemId ? [itemId, limit] : [limit]
  const rows = db.prepare(sql).all(...args) as any[]
  return rows.map(r => ({
    id: r.id,
    item_id: r.item_id ?? undefined,
    ts: r.ts,
    recommendation: r.recommendation,
    reasoning: r.reasoning ?? undefined,
    user_response: r.user_response ?? undefined,
    outcome: r.outcome ?? undefined,
    outcome_notes: r.outcome_notes ?? undefined,
    reviewed_at: r.reviewed_at ?? undefined,
  }))
}

/** Compute recent track record: how many recs reviewed, and how many were good. */
export function getRecommendationStats(itemId?: string): { total: number; reviewed: number; good: number; bad: number } {
  const db = getDb()
  const sql = itemId
    ? `SELECT COUNT(*) total,
              SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) reviewed,
              SUM(CASE WHEN outcome = 'good' THEN 1 ELSE 0 END) good,
              SUM(CASE WHEN outcome = 'bad' THEN 1 ELSE 0 END) bad
       FROM agent_recommendations WHERE item_id = ?`
    : `SELECT COUNT(*) total,
              SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) reviewed,
              SUM(CASE WHEN outcome = 'good' THEN 1 ELSE 0 END) good,
              SUM(CASE WHEN outcome = 'bad' THEN 1 ELSE 0 END) bad
       FROM agent_recommendations`
  const args = itemId ? [itemId] : []
  const r = db.prepare(sql).get(...args) as any
  return {
    total: r.total || 0,
    reviewed: r.reviewed || 0,
    good: r.good || 0,
    bad: r.bad || 0,
  }
}
