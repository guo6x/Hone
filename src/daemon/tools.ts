/**
 * L1 Gateway tools — scheduling and dispatch only.
 * Gateway NEVER touches files or runs shell commands directly.
 */
import { randomUUID } from 'crypto'
import type { Tool } from '../Tool.js'
import { getMemoryTool } from '../memory/auto-memory.js'
import { getSkillCreateTool } from '../skills/skill_create.js'
import type { PersistedSchedule } from './scheduler.js'
import { saveSchedules } from './scheduler.js'
import type { BrowserAgent } from './browser/types.js'

/** 校验 cron 表达式：5 段格式，每段合法字符。返回 true 表示有效。 */
function validateCron(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  // 每段的合法字符：分时日月周
  // 分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-7)
  const patterns = [
    /^([0-9*,/\-]+)$/, // minute
    /^([0-9*,/\-]+)$/, // hour
    /^([0-9*,/\-]+)$/, // day
    /^([0-9*,/\-]+)$/, // month
    /^([0-9*,/\-]+)$/, // weekday
  ]
  return parts.every((p, i) => patterns[i].test(p))
}

/** 校验 URL 协议：仅允许 http/https（防止 javascript:/file: 等协议注入）。 */
function validateUrlProtocol(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export interface ScheduleEntry {
  id: string
  text: string // natural language description
  trigger:
    | { type: 'cron'; cron: string }
    | { type: 'interval'; ms: number }
    | { type: 'one-time'; at: number } // unix ms
  task: string // what to do when triggered
  delivery: 'notify' | 'execute' | 'both'
  enabled: boolean
  createdAt: number
  lastTriggeredAt?: number
  lastStatus?: 'ok' | 'fail'
}

export interface GatewayContext {
  schedules: Map<string, ScheduleEntry>
  pendingPairings: Map<string, { clientId: string; code: string; resolve: (approved: boolean) => void }>
  dispatchTask(task: string): Promise<TaskRunResult>
  sendNotification(msg: string): void
  persistSchedules(): void
  browserAgent: BrowserAgent | null
}

export interface TaskRunResult {
  taskId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'denied'
  result: string
  cwd?: string
}

export function getGatewayTools(ctx: GatewayContext): Tool[] {
  return [
    {
      name: 'schedule_task',
      description: 'Create a scheduled task. Supports natural language time expressions and cron syntax.',
      input_schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Natural language schedule description, e.g. "每天早上9点检查我的GitHub PR"',
          },
          task: {
            type: 'string',
            description: 'What should Hone do when triggered?',
          },
          trigger: {
            type: 'string',
            description: 'Cron expression (e.g. "0 9 * * *") or natural time parsed by AI',
          },
          delivery: {
            type: 'string',
            enum: ['notify', 'execute', 'both'],
            description: 'How to deliver results: notify only, execute silently, or both',
          },
        },
        required: ['text', 'task', 'trigger'],
      },
      isEnabled: () => true,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        if (!validateCron(input.trigger)) {
          return { content: [{ type: 'text', text: `无效的 cron 表达式: "${input.trigger}"。请使用 5 段标准格式，如 "0 9 * * *"。` }] }
        }
        const id = `sched_${randomUUID()}`
        const entry: ScheduleEntry = {
          id,
          text: input.text,
          trigger: { type: 'cron', cron: input.trigger },
          task: input.task,
          delivery: input.delivery || 'both',
          enabled: true,
          createdAt: Date.now(),
        }
        ctx.schedules.set(id, entry)
        ctx.persistSchedules()
        return {
          content: [{ type: 'text', text: `日程已创建: ${input.text} (${id})` }],
        }
      },
    },
    {
      name: 'list_schedules',
      description: 'List all active scheduled tasks',
      input_schema: {
        type: 'object',
        properties: {},
      },
      isEnabled: () => true,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async () => {
        const schedules = Array.from(ctx.schedules.values())
        if (schedules.length === 0) {
          return { content: [{ type: 'text', text: '暂无日程。' }] }
        }
        const lines = schedules.map(
          s =>
            `- ${s.id}: ${s.text} | 触发: ${s.trigger.type === 'cron' ? s.trigger.cron : s.trigger.type} | ${s.enabled ? '✅' : '⏸️'} | 上次: ${s.lastTriggeredAt ? new Date(s.lastTriggeredAt).toISOString() : '从未'}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      },
    },
    {
      name: 'delete_schedule',
      description: 'Delete a scheduled task',
      input_schema: {
        type: 'object',
        properties: {
          scheduleId: { type: 'string', description: 'The schedule ID to delete' },
        },
        required: ['scheduleId'],
      },
      isEnabled: () => true,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        const deleted = ctx.schedules.delete(input.scheduleId)
        if (deleted) ctx.persistSchedules()
        return {
          content: [
            { type: 'text', text: deleted ? `日程已删除: ${input.scheduleId}` : `未找到日程: ${input.scheduleId}` },
          ],
        }
      },
    },
    {
      name: 'dispatch_task',
      description: 'Dispatch a task to a CLI instance for execution. Use this whenever the user asks about current status, progress, results, or wants to check/inspect something. Do not just say you will check — actually call this tool.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description for the CLI to execute' },
        },
        required: ['task'],
      },
      isEnabled: () => true,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        const result = await ctx.dispatchTask(input.task)
        return { content: [{ type: 'text', text: result.result }] }
      },
    },
    {
      name: 'approve_pairing',
      description: 'Approve or deny a device pairing request',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string' },
          approved: { type: 'boolean' },
        },
        required: ['clientId', 'approved'],
      },
      isEnabled: () => true,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        const pending = ctx.pendingPairings.get(input.clientId)
        if (pending) {
          pending.resolve(input.approved)
          ctx.pendingPairings.delete(input.clientId)
          return {
            content: [{ type: 'text', text: input.approved ? `已批准设备 ${input.clientId}` : `已拒绝设备 ${input.clientId}` }],
          }
        }
        return { content: [{ type: 'text', text: `未找到待审批的设备: ${input.clientId}` }] }
      },
    },
    getMemoryTool(),
    getSkillCreateTool(),
    {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL. Opens the page in a persistent browser profile.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to' },
          profile: { type: 'string', description: 'Browser profile name (defaults to "default")' },
        },
        required: ['url'],
      },
      isEnabled: () => ctx.browserAgent !== null,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        if (!ctx.browserAgent) return { content: [{ type: 'text', text: '浏览器代理未启用。请设置 HONE_BROWSER_ENABLED=true' }] }
        if (!validateUrlProtocol(input.url)) {
          return { content: [{ type: 'text', text: `无效的 URL 或不支持的协议: "${input.url}"。仅支持 http/https。` }] }
        }
        const state = await ctx.browserAgent.navigate(input.profile || 'default', input.url)
        return { content: [{ type: 'text', text: `已导航到: ${state.title} (${state.url})` }] }
      },
    },
    {
      name: 'browser_action',
      description: 'Execute a web automation task in the browser using natural language, e.g. "搜索AI新闻", "发一条微博: 今天天气真好"',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Natural language description of the web task' },
          profile: { type: 'string', description: 'Browser profile name (defaults to "default")' },
          startUrl: { type: 'string', description: 'Optional starting URL' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk level (default: "low")' },
        },
        required: ['task'],
      },
      isEnabled: () => ctx.browserAgent !== null,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        if (!ctx.browserAgent) return { content: [{ type: 'text', text: '浏览器代理未启用。请设置 HONE_BROWSER_ENABLED=true' }] }
        // startUrl 必须是 http/https，防止 javascript:/file:/ 等危险协议被 LLM 注入
        if (input.startUrl && !validateUrlProtocol(input.startUrl)) {
          return { content: [{ type: 'text', text: `无效的 startUrl: "${input.startUrl}"。只允许 http/https 协议。` }] }
        }
        const result = await ctx.browserAgent.executeTask({
          id: `browser_${Date.now()}`,
          profileName: input.profile || 'default',
          task: input.task,
          startUrl: input.startUrl,
          riskLevel: input.riskLevel || 'low',
        })
        if (result.status === 'success') {
          return { content: [{ type: 'text', text: `浏览器任务完成: ${result.finalUrl || ''} (${result.steps.length} 步, ${(result.durationMs / 1000).toFixed(1)}s)` }] }
        }
        return { content: [{ type: 'text', text: `浏览器任务失败: ${result.error || result.status} (${result.steps.length} 步)` }] }
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current browser page',
      input_schema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile name (defaults to "default")' },
        },
      },
      isEnabled: () => ctx.browserAgent !== null,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        if (!ctx.browserAgent) return { content: [{ type: 'text', text: '浏览器代理未启用。' }] }
        const base64 = await ctx.browserAgent.screenshot(input.profile || 'default')
        return {
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: '当前页面截图' },
          ],
        }
      },
    },
    {
      name: 'browser_extract',
      description: 'Extract structured text content from the current browser page',
      input_schema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Browser profile name (defaults to "default")' },
          selector: { type: 'string', description: 'CSS selector to extract from (defaults to body text)' },
        },
      },
      isEnabled: () => ctx.browserAgent !== null,
      checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      execute: async (input: any) => {
        if (!ctx.browserAgent) return { content: [{ type: 'text', text: '浏览器代理未启用。' }] }
        const text = await ctx.browserAgent.extract(input.profile || 'default', input.selector || 'body')
        return { content: [{ type: 'text', text: text.slice(0, 4000) }] }
      },
    },
  ]
}
