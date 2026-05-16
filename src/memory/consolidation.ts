/**
 * Memory consolidation — periodically run to:
 * - Merge similar memories
 * - Mark outdated/stale entries
 * - Remove entries that are no longer relevant
 * - Suggest memory reorganization
 */

import * as fs from 'fs'
import * as path from 'path'
import { readMemories, saveMemory, type MemoryEntry } from './auto-memory.js'

interface ConsolidationResult {
  merged: number
  removed: number
  suggestions: string[]
}

/**
 * Calculate similarity between two strings using Jaccard on word sets.
 * Simple and fast, sufficient for memory dedup.
 */
function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
  )
  const setA = tokenize(a)
  const setB = tokenize(b)
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

/**
 * Merge two similar memories. Prefer the newer one's metadata and the longer content.
 */
function mergeMemories(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  const newer = a.savedAt >= b.savedAt ? a : b
  const older = a.savedAt < b.savedAt ? a : b

  const combined = [
    newer.content,
    '',
    `---`,
    `合并自: ${older.name} (${new Date(older.savedAt).toISOString()})`,
  ].join('\n')

  return {
    ...newer,
    name: newer.name,
    content: combined,
  }
}

/**
 * Run consolidation pass.
 * - Merge entries with >0.6 similarity
 * - Remove entries older than `maxAgeDays` (default 90)
 * - Return stats and suggestions
 */
export function consolidateMemory(options?: {
  similarityThreshold?: number
  maxAgeDays?: number
  dryRun?: boolean
}): ConsolidationResult {
  const threshold = options?.similarityThreshold ?? 0.6
  const maxAgeMs = (options?.maxAgeDays ?? 90) * 24 * 3600_000
  const dryRun = options?.dryRun ?? false
  const result: ConsolidationResult = { merged: 0, removed: 0, suggestions: [] }

  const memories = readMemories()
  const entries = Array.from(memories.values())

  // Detect similar entries
  const merged = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    if (merged.has(entries[i].name)) continue
    for (let j = i + 1; j < entries.length; j++) {
      if (merged.has(entries[j].name)) continue

      const sim = textSimilarity(entries[i].content, entries[j].content)
      if (sim > threshold) {
        const mergedEntry = mergeMemories(entries[i], entries[j])
        result.suggestions.push(
          `合并: "${entries[i].name}" + "${entries[j].name}" (相似度: ${(sim * 100).toFixed(0)}%)`
        )
        if (!dryRun) {
          saveMemory(mergedEntry)
          // Remove the absorbed entries
          removeMemory(entries[j].name)
          merged.add(entries[i].name)
          merged.add(entries[j].name)
        }
        result.merged++
      }
    }
  }

  // Remove stale entries
  const now = Date.now()
  for (const [, entry] of memories) {
    if (merged.has(entry.name)) continue
    if (now - entry.savedAt > maxAgeMs) {
      result.suggestions.push(`移除过期记忆: "${entry.name}" (${Math.round((now - entry.savedAt) / 86400000)}天前)`)
      if (!dryRun) {
        removeMemory(entry.name)
        result.removed++
      }
    }
  }

  return result
}

/**
 * Remove a single memory entry and update the index.
 */
export function removeMemory(name: string): boolean {
  const dir = path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.hone', 'memory')
  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').toLowerCase()
  const filepath = path.join(dir, `${safeName}.md`)

  let deleted = false
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
      deleted = true
    }
  } catch { /* ignore */ }

  // Update index
  const indexPath = path.join(dir, 'MEMORY.md')
  try {
    if (fs.existsSync(indexPath)) {
      let index = fs.readFileSync(indexPath, 'utf-8')
      const line = new RegExp(`^- \\[${escapeRegex(name)}\\]\\([^)]+\\).*$`, 'm')
      index = index.replace(line, '').replace(/\n{3,}/g, '\n\n').trim()
      fs.writeFileSync(indexPath, index + '\n', 'utf-8')
    }
  } catch { /* ignore */ }

  return deleted
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Get consolidation suggestions without making changes.
 */
export function suggestConsolidation(): string[] {
  return consolidateMemory({ dryRun: true }).suggestions
}

/**
 * Run consolidation suitable for cron/schedule trigger (auto mode).
 */
export function autoConsolidate(): void {
  const result = consolidateMemory()
  if (result.merged > 0 || result.removed > 0) {
    console.error(`[Memory] 合并 ${result.merged} 条, 移除 ${result.removed} 条过期记忆`)
    for (const s of result.suggestions) {
      console.error(`[Memory]   ${s}`)
    }
  }
}
