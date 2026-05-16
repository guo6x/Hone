/**
 * Pattern Learner — analyzes Hone interaction logs to detect user behavior
 * patterns and suggest automated schedules.
 *
 * Inspired by Apple Intelligence's on-device Personal Context Engine:
 * - All analysis is local, data never leaves the machine
 * - Patterns are detected from ~/.hone/logs/
 * - After 2 weeks of data, suggestions are surfaced
 *
 * Detects patterns like:
 * - First CLI interaction of the day (work start time)
 * - Test-running frequency and timing
 * - Deployment patterns
 * - Frequently used project directories
 * - Common task types and their timing
 */

import * as fs from 'fs'
import * as path from 'path'

// ── Types ──

export interface ActivityLogEntry {
  ts: number
  type: 'cli_session' | 'gateway_event' | 'schedule_trigger' | 'tool_call'
  detail: string
  project?: string
  duration?: number
}

export interface DetectedPattern {
  type: string
  description: string
  confidence: number // 0..1
  evidence: string[] // sample log entries supporting this pattern
  suggestedSchedule?: {
    text: string
    task: string
    cron: string
  }
}

// ── Log paths ──

function getLogDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  return path.join(home, '.hone', 'logs')
}

// ── Parse activity log files ──

export function loadActivityLogs(days: number = 21): ActivityLogEntry[] {
  const entries: ActivityLogEntry[] = []
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) return entries

  // Activity logs stored as JSON files per day: YYYY-MM-DD.json
  const now = Date.now()
  const cutoff = now - days * 24 * 3600_000

  try {
    for (const file of fs.readdirSync(logDir)) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(logDir, file)

      // Check file modification time
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) continue

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        const logs = Array.isArray(data) ? data : data.logs || []
        for (const log of logs) {
          if (log.ts >= cutoff) {
            entries.push(log as ActivityLogEntry)
          }
        }
      } catch {
        // skip corrupted files
      }
    }
  } catch { /* ignore */ }

  return entries.sort((a, b) => a.ts - b.ts)
}

// ── Pattern detection ──

/**
 * Count occurrences by hour of day
 */
function hourHistogram(entries: ActivityLogEntry[], type: string): Map<number, number> {
  const hist = new Map<number, number>()
  for (const e of entries) {
    if (e.type !== type) continue
    const hour = new Date(e.ts).getHours()
    hist.set(hour, (hist.get(hour) || 0) + 1)
  }
  return hist
}

/**
 * Count occurrences by day of week
 */
function weekdayHistogram(entries: ActivityLogEntry[], type: string): Map<number, number> {
  const hist = new Map<number, number>()
  for (const e of entries) {
    if (e.type !== type) continue
    const day = new Date(e.ts).getDay()
    hist.set(day, (hist.get(day) || 0) + 1)
  }
  return hist
}

/**
 * Find the most common value in a histogram
 */
function peakHour(hist: Map<number, number>): { hour: number; count: number } {
  let bestHour = 0
  let bestCount = 0
  for (const [h, c] of hist) {
    if (c > bestCount) {
      bestCount = c
      bestHour = h
    }
  }
  return { hour: bestHour, count: bestCount }
}

// ── Main detection pipeline ──

export function detectPatterns(logs?: ActivityLogEntry[]): DetectedPattern[] {
  const entries = logs || loadActivityLogs(21)
  const patterns: DetectedPattern[] = []

  if (entries.length < 5) {
    // Not enough data yet
    return patterns
  }

  const now = Date.now()
  const oldestTs = entries[0]?.ts || now
  const dataAgeDays = (now - oldestTs) / 86400000

  // Pattern 1: Work start time (first CLI session of the day)
  const cliStarts: { day: string; hour: number; ts: number }[] = []
  const seenDays = new Set<string>()

  for (const e of entries) {
    if (e.type !== 'cli_session') continue
    const d = new Date(e.ts)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (!seenDays.has(dayKey)) {
      seenDays.add(dayKey)
      cliStarts.push({ day: dayKey, hour: d.getHours(), ts: e.ts })
    }
  }

  if (cliStarts.length >= 5) {
    const hist = hourHistogram(
      cliStarts.map(e => ({ ts: e.ts, type: 'cli_session', detail: '' })),
      'cli_session'
    )
    const peak = peakHour(hist)
    if (peak.count >= 3) {
      const confidence = Math.min(0.9, peak.count / cliStarts.length + dataAgeDays / 30)
      patterns.push({
        type: 'work_start_time',
        description: `用户通常在 ${peak.hour}:00 开始工作`,
        confidence,
        evidence: cliStarts.slice(0, 5).map(e => `  ${e.day} — ${e.hour}:00`),
        suggestedSchedule: {
          text: `每天早上 ${peak.hour - 1}:45 检查今日任务`,
          task: '检查待办事项并总结',
          cron: `45 ${Math.max(0, peak.hour - 1)} * * *`,
        },
      })
    }
  }

  // Pattern 2: Deployment patterns (detect "deploy" or "deployment" tool calls)
  const deployActions = entries.filter(e =>
    e.type === 'tool_call' &&
    /\b(deploy|release|publish|push to production)\b/i.test(e.detail)
  )

  if (deployActions.length >= 3) {
    const dayHist = weekdayHistogram(deployActions, 'tool_call')
    const peak = peakHour(dayHist)
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']
    patterns.push({
      type: 'deployment_day',
      description: `用户经常在周${weekdayNames[peak.hour]}进行部署`,
      confidence: Math.min(0.7, deployActions.length / 5 + dataAgeDays / 30),
      evidence: deployActions.slice(0, 3).map(e =>
        `  ${new Date(e.ts).toISOString()} — ${e.detail.slice(0, 80)}`
      ),
      suggestedSchedule: {
        text: `每${weekdayNames[peak.hour] === '日' || weekdayNames[peak.hour] === '六' ? '个工作日' : '周' + weekdayNames[peak.hour]}部署提醒`,
        task: '检查部署状态并通知',
        cron: `0 10 * * ${peak.hour}`,
      },
    })
  }

  // Pattern 3: Common projects (detect frequently used directories)
  const projects = new Map<string, number>()
  for (const e of entries) {
    if (e.project) {
      projects.set(e.project, (projects.get(e.project) || 0) + 1)
    }
  }

  const topProjects = Array.from(projects.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  if (topProjects.length > 0 && topProjects[0][1] >= 5) {
    patterns.push({
      type: 'frequent_projects',
      description: `常用项目: ${topProjects.map(p => path.basename(p[0])).join(', ')}`,
      confidence: 0.8,
      evidence: topProjects.map(p => `  ${p[0]} (${p[1]} 次)`),
    })
  }

  return patterns
}

// ── Suggestions for Gateway to present ──

export interface PatternSuggestion {
  id: string
  text: string
  pattern: DetectedPattern
  createdAt: number
}

export function getPatternSuggestions(): PatternSuggestion[] {
  const patterns = detectPatterns()
  const suggestions: PatternSuggestion[] = []

  for (const pattern of patterns) {
    if (pattern.confidence < 0.4) continue
    if (!pattern.suggestedSchedule) continue

    suggestions.push({
      id: `ps_${Date.now()}_${pattern.type}`,
      text: `Hone 注意到 ${pattern.description}。${pattern.suggestedSchedule.text}？`,
      pattern,
      createdAt: Date.now(),
    })
  }

  return suggestions
}
