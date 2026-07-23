/**
 * L1 Gateway LLM — 轻量级意图分类和任务分发。
 * 使用 DeepSeek provider，最小 token 消耗（不生成代码）。
 */
import { getProvider, type ProviderResponse, type ProviderTool } from '../services/providers/index.js'
import {
  getRecentMessages, listPrefs, listTrackedItems, getLatestObservation,
  getRecommendationStats, type TrackedItem,
} from './storage.js'
import { getMemorySystemPrompt } from '../memory/auto-memory.js'

// 已中文化 — 见上方

const GATEWAY_SYSTEM_PROMPT_BASE = `你是 Hone，用户的私人总管与最高决策辅佐。你站在架构的最顶层：Hone 负责理解意图、制定策略、调度资源；CLI 是你手下的执行层；CLI 内的子 agent 是最底层的具体工具执行者。

你的核心职责：
- 像辅佐君主的管家一样主动思考：先理解用户真实意图，再决定最合适的响应方式。
- 回答简单问题时直接、准确、有见地。
- 创建/管理日程 (schedule_task)，主动提醒。
- 分派任务给 CLI 执行 (dispatch_task)：涉及文件、代码、命令、系统操作时，你永远不亲自执行，而是制定清晰计划后交由 CLI。
- 总结 CLI 与子 agent 的执行结果，提炼关键信息给用户。
- 批准设备配对请求 (approve_pairing)。
- 持续自我进化：每次交互后复盘是否能更精准地理解用户、更高效地调度工具。

当用户要求做代码/文件/命令相关操作时，必须使用 dispatch_task 分派给 CLI，禁止直接操作。

**关键规则——不要只说空话：**
- 当用户询问当前状态、进展、结果，或使用"检查一下"、"现在怎么样"、"怎么样了"、"看看"等表达时，**你必须调用 dispatch_task 让 CLI 真正去执行检查**，而不是只回复一句"我先检查一下"。
- 如果用户没有指定具体检查项，调用 dispatch_task 时请让 CLI 检查：系统整体状态、日程任务、最近活动、以及用户可能关心的追踪项。
- CLI 返回结果后，你要把结果总结成简洁的中文回复给用户。

关于股票、基金、加密货币等投资话题：你可以基于公开信息进行分析、比较、趋势判断，并给出参考性观点。你的观点仅供用户参考，用户需自行决策，必要时可在回复末尾简短声明“仅供参考，不构成投资建议”。不要以“合规”“职责范围”等理由拒绝正常讨论。

回复用中文，简洁、得体、有主人翁意识。`

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
 *
 * 60s TTL 缓存：避免高频对话时每次请求都执行 4 次 I/O
 */

let systemPromptCache: { value: string; ts: number } | null = null
const SYSTEM_PROMPT_TTL_MS = 60_000

export function invalidateSystemPromptCache(): void {
  systemPromptCache = null
}

function buildSystemPrompt(): string {
  if (systemPromptCache && Date.now() - systemPromptCache.ts < SYSTEM_PROMPT_TTL_MS) {
    return systemPromptCache.value
  }

  let trackedBlock = ''
  let prefsBlock = ''

  try {
    const active = listTrackedItems({ status: 'committed' })
      .concat(listTrackedItems({ status: 'watching' }))
    if (active.length > 0) {
      const lines = active.map(formatTrackedItem).join('\n\n')
      trackedBlock = `\n\n=== 当前活跃的追踪项（user 在你建议基础上做出的承诺）===\n${lines}\n=== END ===\n\n你必须记得这些。如果你之前建议了什么，user 采取了行动，那个 commitment 一直存在直到 user 明确告诉你结束。永远不要忘记 user 在你建议基础上做的事。`
    }
  } catch (e) { console.error('[LLM] buildSystemPrompt:', e) }

  try {
    const prefs = listPrefs()
    const keys = Object.keys(prefs)
    if (keys.length > 0) {
      const lines = keys
        .map(k => `- ${k}: ${typeof prefs[k] === 'string' ? prefs[k] : JSON.stringify(prefs[k])}`)
        .join('\n')
      prefsBlock = `\n\n用户的长期偏好（已观察到/被告知的）:\n${lines}`
    }
  } catch (e) { console.error('[LLM] buildSystemPrompt:', e) }

  let memoryBlock = ''
  try {
    memoryBlock = getMemorySystemPrompt()
  } catch (e) { console.error('[LLM] getMemorySystemPrompt:', e) }

  const result = trackedBlock + GATEWAY_SYSTEM_PROMPT_BASE + prefsBlock + memoryBlock
  systemPromptCache = { value: result, ts: Date.now() }
  return result
}

/** Pull recent conversation turns and format as OpenAI/DeepSeek messages array. */
function buildHistory(): { role: 'user' | 'assistant'; content: string }[] {
  try {
    // getRecentMessages 返回最新在前（storage.ts 内部 .reverse()），需要再反转一次恢复时间顺序
    const recent = getRecentMessages(MEMORY_RECENT_TURNS * 2) // both directions
    return recent.slice().reverse() // 恢复为时间顺序：最旧 → 最新
      .filter(m => m.direction === 'in' || m.direction === 'out')
      .map(m => ({
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      }))
  } catch (e) {
    console.error('[LLM] buildHistory:', e)
    return []
  }
}

export interface GatewayLLMResponse {
  action: 'reply' | 'dispatch' | 'schedule' | 'browser'
  reply?: string
  task?: string
  scheduleData?: { text: string; task: string; trigger: string; delivery?: string }
  toolCall?: { name: string; input: any }
  usage?: { inputTokens: number; outputTokens: number }
}

/** 将 Gateway 工具定义转换为 Provider 工具格式。 */
export function buildProviderTools(tools: any[]): ProviderTool[] {
  return tools
    .filter(t => t.isEnabled ? t.isEnabled() : true)
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
}

export async function gatewayLLM(userMessage: string, providerTools?: ProviderTool[]): Promise<GatewayLLMResponse> {
  const provider = getProvider()

  try {
    const envTemp = Number(process.env.HONE_TEMPERATURE)
    const temperature = Number.isFinite(envTemp) && envTemp >= 0
      ? Math.min(envTemp, 0.5)
      : 0.3
    // 工具调用需要足够的空间生成 tool_use JSON。
    // 旧值 512 太小，DeepSeek 经常在生成 tool_use 块之前就达到长度上限，
    // 导致 LLM 只返回 "我先检查一下" 这类半截文本，根本没有 tool_use 块。
    // 推理模型（deepseek-v4-pro / o1）需要更大空间：reasoning_content 和 content 共享
    // max_tokens，2048 常被推理消耗完导致 content 为空。默认 4096，上限 8192。
    const envMax = Number(process.env.HONE_MAX_TOKENS)
    const maxTokens = Number.isFinite(envMax) && envMax > 0
      ? Math.min(envMax, 8192)
      : 4096

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
      tools: providerTools,
      toolChoice: providerTools ? 'auto' : undefined,
    })

    const text = extractText(response)
    const usage = response.usage || undefined

    // 优先检查 tool_use 响应（真正的 function calling）
    const toolCalls = extractToolCalls(response)
    if (toolCalls.length > 0) {
      const tc = toolCalls[0]
      if (tc.name === 'dispatch_task') {
        return { action: 'dispatch', task: tc.input.task || userMessage, usage }
      }
      if (tc.name === 'schedule_task') {
        return {
          action: 'schedule',
          reply: text,
          scheduleData: {
            text: tc.input.text || '',
            task: tc.input.task || '',
            trigger: tc.input.trigger || '0 9 * * *',
            delivery: tc.input.delivery || 'both',
          },
          usage,
        }
      }
      if (tc.name === 'browser_action') {
        return { action: 'browser', task: tc.input.task || userMessage, usage }
      }
      if (tc.name === 'browser_navigate') {
        return { action: 'browser', task: tc.input.url ? `导航到 ${tc.input.url}` : userMessage, usage }
      }
      if (tc.name === 'memory_save') {
        return { action: 'reply', reply: text || '已保存到记忆。', toolCall: tc, usage }
      }
      // 其他 tool call 直接返回，让 gateway 处理
      return { action: 'reply', reply: text, toolCall: tc, usage }
    }

    // 降级：仅在 LLM 回复文本中明确包含工具名时才路由（function calling 失败的兜底）。
    // 不再用中文关键词猜测——"读/写/改/测试/每天/浏览"等日常用词会误触发 dispatch/schedule/browser。
    if (text.includes('dispatch_task')) {
      return { action: 'dispatch', task: userMessage, usage }
    }

    if (text.includes('schedule_task') || text.includes('schedule_create')) {
      return { action: 'schedule', reply: text, usage }
    }

    if (text.includes('browser_action') || text.includes('browser_navigate')) {
      return { action: 'browser', task: userMessage, usage }
    }

    return { action: 'reply', reply: text, usage }
  } catch (error) {
    console.error('[LLM] gatewayLLM error:', error)
    return { action: 'reply', reply: '调度器暂时不可用，请稍后重试' }
  }
}

/** 从 provider 响应中提取 tool calls。 */
function extractToolCalls(response: any): { name: string; input: any }[] {
  const content = response.content
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c.type === 'tool_use')
    .map((c: any) => ({ name: c.name, input: c.input || {} }))
}

function extractText(response: any): string {
  if (response.content) {
    if (typeof response.content === 'string') return response.content
    if (Array.isArray(response.content)) {
      // 优先提取 text 内容
      const textParts = response.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
      const text = textParts.join('\n')
      if (text.trim()) return text

      // 推理模型（deepseek-v4-pro、o1 等）的 content 可能为空，
      // reasoning_content 全部消耗了 max_tokens。fallback 到 thinking，
      // 截断到 2000 字符防止上下文窗口过载。
      const thinkingParts = response.content
        .filter((c: any) => c.type === 'thinking')
        .map((c: any) => c.thinking)
      const thinking = thinkingParts.join('\n')
      if (thinking.trim()) return '[思考中...]\n' + thinking.slice(0, 2000)
    }
  }
  return JSON.stringify(response)
}
