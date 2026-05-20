/**
 * L1 Gateway LLM — 轻量级意图分类和任务分发。
 * 使用 DeepSeek provider，最小 token 消耗（不生成代码）。
 */
import { getProvider, type ProviderResponse } from '../services/providers/index.js'
import {
  getRecentMessages, listPrefs, listTrackedItems, getLatestObservation,
  getRecommendationStats, type TrackedItem,
} from './storage.js'

// 已中文化 — 见上方

const GATEWAY_SYSTEM_PROMPT_BASE = `你是一个 AI 调度助手 (Hone Gateway)。
你的职责是理解用户意图，然后决定如何响应。你永远不直接操作文件或执行命令。

你可以:
- 回答简单问题
- 创建/管理日程 (schedule_task)
- 分派任务给 CLI 执行 (dispatch_task)
- 总结 CLI 执行结果
- 批准设备配对请求 (approve_pairing)

当用户要求做代码相关的操作时（读文件、写代码、运行命令等），你必须使用 dispatch_task 分派给 CLI。

回复用中文，简洁直接。`

/** Number of past message turns to include as conversation history. */
const MEMORY_RECENT_TURNS = 12

/** Format a single tracked item with its latest observation for the system prompt. */
function formatTrackedItem(item: TrackedItem): string {
  const lines: string[] = []
  const head = `[${item.kind}] ${item.display_name || item.identifier} (${item.identifier})`
  lines.push(head)
  if (item.user_position && Object.keys(item.user_position).length > 0) {
    // For stocks: "持仓 1000 股 @1500.00"
    if (item.kind === 'stock') {
      const p = item.user_position as any
      if (p.shares && p.avg_cost) {
        lines.push(`  用户持仓: ${p.shares} 股 @ ${p.avg_cost}（${p.broker_authorized ? '已授权自动交易' : '需手动操作'}）`)
      } else {
        lines.push(`  用户状态: 仅关注，未持仓`)
      }
    } else {
      lines.push(`  状态: ${JSON.stringify(item.user_position)}`)
    }
  } else {
    lines.push(`  用户状态: 仅关注`)
  }
  const obs = getLatestObservation(item.id)
  if (obs) {
    const age = Math.floor((Date.now() - obs.ts) / 60000)
    const data = obs.data as any
    if (item.kind === 'stock' && data.current) {
      lines.push(`  最新行情 (${age}m 前): ${data.current} (${data.change_pct >= 0 ? '+' : ''}${data.change_pct?.toFixed(2)}%)`)
    } else if (obs.agent_assessment) {
      lines.push(`  ${age}m 前: ${obs.agent_assessment.slice(0, 100)}`)
    }
    if (obs.signal && obs.signal !== 'none') {
      lines.push(`  ⚠ 上次信号: ${obs.signal}`)
    }
  }
  const stats = getRecommendationStats(item.id)
  if (stats.reviewed > 0) {
    lines.push(`  历史推荐准确率: ${stats.good}/${stats.reviewed} (共 ${stats.total} 次建议)`)
  }
  return lines.join('\n')
}

/** Build a system prompt enriched with active commitments and preferences.
 *
 * Order matters: tracked items go FIRST so the LLM can't forget what the user
 * has bought/applied for/committed to. This is the antidote to "I bought XYZ
 * based on your call, now you've forgotten" — the worst sin of AI products.
 */
function buildSystemPrompt(): string {
  let trackedBlock = ''
  let prefsBlock = ''

  try {
    const active = listTrackedItems({ status: 'committed' })
      .concat(listTrackedItems({ status: 'watching' }))
    if (active.length > 0) {
      const lines = active.map(formatTrackedItem).join('\n\n')
      trackedBlock = `\n\n=== 当前活跃的追踪项（user 在你建议基础上做出的承诺）===\n${lines}\n=== END ===\n\n你必须记得这些。如果你之前建议了什么，user 采取了行动，那个 commitment 一直存在直到 user 明确告诉你结束。永远不要忘记 user 在你建议基础上做的事。`
    }
  } catch {}

  try {
    const prefs = listPrefs()
    const keys = Object.keys(prefs)
    if (keys.length > 0) {
      const lines = keys
        .map(k => `- ${k}: ${typeof prefs[k] === 'string' ? prefs[k] : JSON.stringify(prefs[k])}`)
        .join('\n')
      prefsBlock = `\n\n用户的长期偏好（已观察到/被告知的）:\n${lines}`
    }
  } catch {}

  return trackedBlock + GATEWAY_SYSTEM_PROMPT_BASE + prefsBlock
}

/** Pull recent conversation turns and format as OpenAI/DeepSeek messages array. */
function buildHistory(): { role: 'user' | 'assistant'; content: string }[] {
  try {
    const recent = getRecentMessages(MEMORY_RECENT_TURNS * 2) // both directions
    return recent
      .filter(m => m.direction === 'in' || m.direction === 'out')
      .map(m => ({
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      }))
  } catch {
    return []
  }
}

export interface GatewayLLMResponse {
  action: 'reply' | 'dispatch' | 'schedule' | 'browser'
  reply?: string
  task?: string
}

export async function gatewayLLM(userMessage: string): Promise<GatewayLLMResponse> {
  const provider = getProvider()

  try {
    // Honor user-configured temperature, but cap intent classification at 0.5
    // so JSON-style classifier prompts stay deterministic enough.
    const envTemp = Number(process.env.HONE_TEMPERATURE)
    const temperature = Number.isFinite(envTemp) && envTemp >= 0
      ? Math.min(envTemp, 0.5)
      : 0.3
    const envMax = Number(process.env.HONE_MAX_TOKENS)
    const maxTokens = Number.isFinite(envMax) && envMax > 0
      ? Math.min(envMax, 1024)
      : 512

    const history = buildHistory()
    const messages = [
      ...history,
      { role: 'user' as const, content: userMessage },
    ]

    const response = await provider.createMessage({
      model: process.env.HONE_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      messages,
      system: buildSystemPrompt(),
      maxTokens,
      temperature,
    })

    const text = extractText(response)

    // Simple intent parsing — fall back to dispatching code-related tasks
    if (
      text.includes('dispatch_task') ||
      /代码|文件|命令|修复|编译|测试|部署|git|运行|读|写|改/.test(userMessage)
    ) {
      return { action: 'dispatch', task: userMessage }
    }

    if (
      text.includes('schedule_task') ||
      /日程|定时|每天|每周|提醒|安排/.test(userMessage)
    ) {
      return { action: 'schedule', reply: text }
    }

    if (
      text.includes('browser_action') || text.includes('browser_navigate') ||
      /网页|浏览器|浏览|打开链接|发帖|发微博|发推|表单|自动填写|登录网站|post.*tweet|web.*task|navigate.*url|fill.*form/i.test(userMessage)
    ) {
      return { action: 'browser', task: userMessage }
    }

    return { action: 'reply', reply: text }
  } catch (error) {
    // Fallback: if LLM call fails, treat as reply with error
    return { action: 'reply', reply: `调度器暂时不可用: ${error}` }
  }
}

function extractText(response: any): string {
  if (response.content) {
    if (typeof response.content === 'string') return response.content
    if (Array.isArray(response.content)) {
      return response.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
    }
  }
  return JSON.stringify(response)
}
