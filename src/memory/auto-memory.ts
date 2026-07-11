/**
 * Auto-memory system — AI autonomously decides what's worth remembering.
 *
 * Inspired by Hermes Agent's curator model:
 * - System prompt tells the AI what memory is for and how to use it
 * - A `memory_save` tool lets the AI persist important facts
 * - Memories are stored as markdown files in ~/.hone/memory/
 * - An index file (MEMORY.md) provides quick lookup
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Tool } from '../Tool.js'

// ── Types ──

export type MemoryType = 'user' | 'project' | 'feedback' | 'reference'

export interface MemoryEntry {
  name: string
  description: string
  type: MemoryType
  content: string
  savedAt: number
  source?: string // which conversation/session created it
}

// ── Paths ──

function getMemoryDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  return path.join(home, '.hone', 'memory')
}

function getIndexPath(): string {
  return path.join(getMemoryDir(), 'MEMORY.md')
}

// ── Read/Write ──

export function readMemories(): Map<string, MemoryEntry> {
  const map = new Map<string, MemoryEntry>()
  try {
    const dir = getMemoryDir()
    if (!fs.existsSync(dir)) return map

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue
      try {
        const filepath = path.join(dir, file)
        const content = fs.readFileSync(filepath, 'utf-8')
        // 用文件 mtime 作为 savedAt，使 consolidation.ts 的过期清理能正常工作
        const mtimeMs = fs.statSync(filepath).mtimeMs
        const entry = parseMemoryFile(file, content, mtimeMs)
        if (entry) map.set(entry.name, entry)
      } catch {
        // skip corrupted files
      }
    }
  } catch {
    // directory doesn't exist
  }
  return map
}

function parseMemoryFile(filename: string, content: string, mtimeMs?: number): MemoryEntry | null {
  // Parse YAML-like frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) return null

  const frontmatter = fmMatch[1]
  const body = fmMatch[2].trim()

  const name = extractField(frontmatter, 'name') || filename.replace('.md', '')
  const description = extractField(frontmatter, 'description') || ''
  const type = (extractField(frontmatter, 'type') || 'user') as MemoryType

  return {
    name,
    description,
    type,
    content: body,
    savedAt: mtimeMs || Date.now(),
  }
}

function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim() : null
}

export function saveMemory(entry: MemoryEntry): void {
  const dir = getMemoryDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  // Sanitize filename
  const safeName = entry.name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
    .toLowerCase()
  const filepath = path.join(dir, `${safeName}.md`)

  // Build frontmatter
  const content = [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    '---',
    '',
    entry.content,
  ].join('\n')

  fs.writeFileSync(filepath, content, 'utf-8')

  // Update index
  updateIndex(entry)
}

function updateIndex(entry: MemoryEntry): void {
  const indexPath = getIndexPath()
  const safeName = entry.name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
    .toLowerCase()

  const line = `- [${entry.name}](${safeName}.md) — ${entry.description.slice(0, 100)}`

  let index = ''
  try {
    if (fs.existsSync(indexPath)) {
      index = fs.readFileSync(indexPath, 'utf-8')
    }
  } catch { /* ignore */ }

  // Update existing entry or append
  const existing = new RegExp(`^- \\[${escapeRegex(entry.name)}\\]\\([^)]+\\).*$`, 'm')
  if (index.match(existing)) {
    index = index.replace(existing, line)
  } else {
    index = index.trim()
    if (index) index += '\n'
    index += line + '\n'
  }

  fs.writeFileSync(indexPath, index, 'utf-8')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── System prompt injection ──

export function getMemorySystemPrompt(): string {
  const memories = readMemories()
  const dir = getMemoryDir()

  let prompt = `\n## 自动记忆系统\n\n`
  prompt += `你拥有基于文件的持久记忆系统，位于 \`${dir}\`。`
  prompt += `你可以使用 \`memory_save\` 工具将重要信息保存到记忆中，以便未来的对话使用。\n\n`

  if (memories.size > 0) {
    prompt += `### 当前已保存的记忆 (${memories.size} 条):\n\n`
    for (const [, m] of memories) {
      prompt += `- **${m.name}** [${m.type}]: ${m.description}\n`
    }
    prompt += '\n在回答用户问题时，请参考这些记忆。如果需要最新的信息，请先验证。\n'
  }

  prompt += `\n**何时保存记忆:**\n`
  prompt += `- 当了解到用户角色、偏好、职责、知识水平等重要信息时\n`
  prompt += `- 当用户纠正你的方法或确认某种做法有效时\n`
  prompt += `- 当了解到项目背景、目标、限制等重要上下文时\n`
  prompt += `- 当学到外部系统（如 Bug 追踪、监控面板）的位置和用途时\n\n`
  prompt += `**何时不保存:**\n`
  prompt += `- 代码模式、架构信息（从代码中可推导）\n`
  prompt += `- 调试方案（修复已在代码中体现）\n`
  prompt += `- 临时任务状态\n`
  prompt += `- 已记录在 HONE.md / CLAUDE.md 中的内容\n`

  return prompt
}

// ── Tool definition ──

export function getMemoryTool(
  persist: (entry: MemoryEntry) => void = saveMemory,
): Tool {
  return {
    name: 'memory_save',
    description: '将重要信息保存到持久记忆中，供未来的对话使用。仅在信息值得跨会话保留时调用。',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '记忆的唯一名称，如 "用户角色" 或 "项目背景"',
        },
        description: {
          type: 'string',
          description: '一句话描述，用于将来决定此记忆是否相关',
        },
        type: {
          type: 'string',
          enum: ['user', 'project', 'feedback', 'reference'],
          description: '记忆类型：user=用户信息, project=项目上下文, feedback=用户反馈/偏好, reference=外部系统索引',
        },
        content: {
          type: 'string',
          description: '记忆内容。对 feedback/project 类型，包含"为什么"和"如何应用"。',
        },
      },
      required: ['name', 'description', 'type', 'content'],
    },
    isEnabled: () => true,
    checkPermissions: async () => ({ behavior: 'passthrough' as const }),
    execute: async (input: any) => {
      const entry: MemoryEntry = {
        name: input.name,
        description: input.description,
        type: input.type as MemoryType,
        content: input.content,
        savedAt: Date.now(),
      }
      persist(entry)
      return {
        content: [
          { type: 'text', text: `已保存记忆: ${entry.name} [${entry.type}]` },
        ],
      }
    },
  }
}
