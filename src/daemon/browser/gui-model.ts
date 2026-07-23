/**
 * GUI agent vision model client.
 *
 * Sends a screenshot + task to an OpenAI-compatible vision endpoint and parses
 * a structured next-action JSON. Configured via env vars:
 *   HONE_GUI_MODEL_URL   — e.g. https://api.moonshot.cn/v1/chat/completions
 *   HONE_GUI_MODEL_NAME  — e.g. moonshot-v1-32k-vision-preview
 *   HONE_GUI_MODEL_KEY   — API key for the endpoint
 *
 * Works with Kimi (Moonshot), GPT-4V, Claude (via OpenAI-compatible proxy),
 * or any locally-served UI-TARS/Qwen-VL deployment that speaks OpenAI chat.
 *
 * Note for general vision LLMs (Kimi/GPT-4V): they do NOT natively output
 * click coordinates. We ask for CSS selectors and let Playwright resolve.
 * This is less accurate than purpose-trained models (UI-TARS) but works.
 */
import type { GUIAction } from './types.js'

const GUI_SYSTEM_PROMPT = `你是一个能看屏幕的浏览器操作 agent。

每一步根据 screenshot + 当前页面文本，输出**一个**下一步动作的 JSON。
JSON 形式（用其中一种）：

{ "action": "click", "selector": "<css 选择器>", "reason": "为什么点这个" }
{ "action": "type", "selector": "<input 的 css 选择器>", "text": "要输入的内容", "reason": "..." }
{ "action": "navigate", "url": "https://...", "reason": "..." }
{ "action": "scroll", "coordinates": {"x": 0, "y": 300}, "reason": "..." }
{ "action": "press", "key": "Enter", "reason": "..." }
{ "action": "wait", "waitMs": 2000, "reason": "..." }
{ "action": "done", "reason": "任务完成" }
{ "action": "fail", "reason": "无法完成的原因" }

选择器要求：
- 优先用稳定的属性（id / data-testid / aria-label / name），避免位置类
- 看清楚截图里元素的真实文字，用 :has-text() 或 input[name=...] 这类语义选择器
- 不能编造选择器；只用你能从截图或页面文本里推断出存在的

仅输出 JSON，不要 markdown 围栏，不要 JSON 外的文字。`

export interface VisionModelConfig {
  url: string
  model: string
  apiKey?: string
}

/** Build config from env vars; returns null if URL is not set. */
export function visionConfigFromEnv(): VisionModelConfig | null {
  const url = process.env.HONE_GUI_MODEL_URL
  if (!url || !url.trim()) return null
  // API Key 降级链（按优先级）：
  //   1. HONE_GUI_MODEL_KEY  — vision 专用 key（推荐）
  //   2. ARK_API_KEY         — 火山方舟（豆包视觉模型）
  //   3. MOONSHOT_API_KEY    — Kimi 月之暗面
  //   4. OPENAI_API_KEY      — OpenAI GPT-4V
  // 注：使用哪个 key 不打印（避免日志泄露 key 来源），但会记录是否找到 key。
  const apiKey = process.env.HONE_GUI_MODEL_KEY
    || process.env.ARK_API_KEY
    || process.env.MOONSHOT_API_KEY
    || process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(`[GUI Model] ⚠️ 未配置 API Key，vision model 调用可能返回 401: ${url.trim()}`)
  }
  return {
    url: url.trim(),
    model: process.env.HONE_GUI_MODEL_NAME || '',
    apiKey,
  }
}

export async function queryGUIModel(
  screenshotBase64: string,
  task: string,
  domText: string,
  config: VisionModelConfig | null,
): Promise<GUIAction> {
  if (!config || !config.url) throw new NoVisionModelError()
  return queryVisionModel(screenshotBase64, task, domText, config)
}

async function queryVisionModel(
  screenshotBase64: string,
  task: string,
  domText: string,
  config: VisionModelConfig,
): Promise<GUIAction> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

  const body = {
    model: config.model,
    temperature: 0.1,
    max_tokens: 512,
    messages: [
      { role: 'system', content: GUI_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
          },
          {
            type: 'text',
            text: `任务: ${task}\n\n页面文本节选:\n${domText.slice(0, 3000)}\n\n下一步动作 JSON:`,
          },
        ],
      },
    ],
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  let res: Response
  try {
    res = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Vision model 请求超时（30s）— 模型可能不可用或响应过慢')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Vision model HTTP ${res.status}: ${errText.slice(0, 300)}`)
  }
  const data = await res.json() as any
  const content = data?.choices?.[0]?.message?.content ?? ''
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      : JSON.stringify(content)
  return parseAction(text)
}

function parseAction(text: string): GUIAction {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    validateAction(parsed)
    return parsed
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        validateAction(parsed)
        return parsed
      } catch {
        return { action: 'fail', reason: `无法解析模型响应: ${text.slice(0, 200)}` }
      }
    }
    return { action: 'fail', reason: `无法解析模型响应: ${text.slice(0, 200)}` }
  }
}

function validateAction(action: any): asserts action is GUIAction {
  const valid = ['click', 'type', 'scroll', 'press', 'navigate', 'wait', 'done', 'fail']
  if (!valid.includes(action.action)) {
    throw new Error(`Invalid action: ${action.action}`)
  }
}

export class NoVisionModelError extends Error {
  constructor() {
    super('No vision model configured (set HONE_GUI_MODEL_URL)')
    this.name = 'NoVisionModelError'
  }
}
