/**
 * AI Provider 抽象接口定义。
 * 所有 AI 供应商必须实现此接口，支持模型切换而无需改上层代码。
 */

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ProviderTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface CreateMessageParams {
  model: string
  messages: ProviderMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  /** DeepSeek v4-pro 推理模式：enable_thinking 开启思维链 */
  enableThinking?: boolean
  /** DeepSeek v4-pro 推理预算（token 数），与 maxTokens 共享上下文窗口 */
  thinkingBudget?: number
  /** OpenAI 风格推理力度：none | low | medium | high | max */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max'
  tools?: ProviderTool[]
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
}

export interface ProviderResponse {
  content: string | { type: string; text?: string; thinking?: string }[]
  model?: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  stopReason?: string
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use'
  text?: string
  thinking?: string
  toolCallId?: string
  name?: string
  input?: Record<string, unknown>
}

export interface AIProvider {
  /** 提供商名称 */
  readonly name: string
  /** 非流式调用 */
  createMessage(params: CreateMessageParams): Promise<ProviderResponse>
  /** 流式调用（可选实现，默认 fallback 到非流式） */
  streamMessage?(params: CreateMessageParams): AsyncGenerator<StreamChunk>
}
