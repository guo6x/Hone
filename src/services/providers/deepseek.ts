/**
 * DeepSeek Provider —— 实现 AIProvider 接口。
 * 默认使用 DeepSeek Chat 模型，通过 OpenAI 兼容 API 调用。
 */
import { randomUUID } from 'crypto'
import type { AIProvider, CreateMessageParams, ProviderResponse, StreamChunk } from './types.js'

export function createDeepSeekProvider(): AIProvider {
  const apiKey =
    process.env.HONE_DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  const baseUrl =
    process.env.HONE_DEEPSEEK_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    'https://api.deepseek.com'
  const defaultModel =
    process.env.HONE_DEEPSEEK_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    'deepseek-v4-pro'

  return {
    name: 'DeepSeek',

    async createMessage(params: CreateMessageParams): Promise<ProviderResponse> {
      if (!apiKey) {
        throw new Error('未设置 DEEPSEEK_API_KEY 或 HONE_DEEPSEEK_API_KEY 环境变量')
      }
      const model = params.model || defaultModel

      // 构建 OpenAI 兼容格式的消息
      const messages: any[] = [
        ...(params.system
          ? [{ role: 'system' as const, content: params.system }]
          : []),
        ...params.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      ]

      // 推理模型（deepseek-v4-pro）需要的 token 预算远大于非推理模型。
      // 思考 token 和输出 token 共享 max_tokens 配额，4096 在思考阶段就被耗尽。
      // 默认 65536 保证充足推理空间；非推理调用方（如 Gateway 意图分类）会传入自有的 maxTokens。
      const isReasoningModel = model.includes('v4-pro') || model.includes('reasoner')
      const body: any = {
        model,
        messages,
        max_tokens: params.maxTokens || (isReasoningModel ? 65536 : 16384),
        temperature: params.temperature ?? (isReasoningModel ? 1.0 : 0.7),
        top_p: params.topP ?? (isReasoningModel ? 1.0 : undefined),
      }

      // 推理模式：DeepSeek v4-pro 的 enable_thinking + thinking_budget
      if (isReasoningModel) {
        if (params.enableThinking !== false) {
          body.enable_thinking = true
          body.thinking_budget = params.thinkingBudget || 32768
          if (params.reasoningEffort) {
            body.reasoning_effort = params.reasoningEffort
          }
        } else {
          body.enable_thinking = false
        }
      }

      // 工具调用
      if (params.tools?.length) {
        body.tools = params.tools
        if (params.toolChoice) {
          body.tool_choice = params.toolChoice
        }
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`DeepSeek API 错误 ${response.status}: ${text}`)
      }

      const data: any = await response.json()
      const choice = data.choices?.[0]
      const message = choice?.message

      // 将 DeepSeek 响应转为通用格式
      const content: any[] = []
      if (message?.reasoning_content) {
        content.push({ type: 'thinking', thinking: message.reasoning_content })
      }
      if (message?.content) {
        content.push({ type: 'text', text: message.content })
      }
      if (message?.tool_calls) {
        for (const tc of message.tool_calls) {
          content.push({
            type: 'tool_use',
            toolCallId: tc.id,
            name: tc.function.name,
            input: safeJsonParse(tc.function.arguments),
          })
        }
      }

      const stopReasonMap: Record<string, string> = {
        stop: 'end_turn',
        tool_calls: 'tool_use',
        length: 'max_tokens',
        content_filter: 'end_turn',
      }

      return {
        content: content.length > 0 ? content : message?.content || '',
        model: data.model,
        usage: data.usage
          ? {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
            }
          : undefined,
        stopReason: stopReasonMap[choice?.finish_reason] || choice?.finish_reason,
      }
    },

    async *streamMessage(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
      if (!apiKey) {
        throw new Error('未设置 DEEPSEEK_API_KEY 或 HONE_DEEPSEEK_API_KEY 环境变量')
      }
      const model = params.model || defaultModel

      const messages: any[] = [
        ...(params.system
          ? [{ role: 'system' as const, content: params.system }]
          : []),
        ...params.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      ]

      // 推理模型默认值对齐 createMessage
      const isReasoningModel = model.includes('v4-pro') || model.includes('reasoner')
      const body: any = {
        model,
        messages,
        max_tokens: params.maxTokens || (isReasoningModel ? 65536 : 16384),
        temperature: params.temperature ?? (isReasoningModel ? 1.0 : 0.7),
        top_p: params.topP ?? (isReasoningModel ? 1.0 : undefined),
        stream: true,
      }

      if (isReasoningModel) {
        if (params.enableThinking !== false) {
          body.enable_thinking = true
          body.thinking_budget = params.thinkingBudget || 32768
          if (params.reasoningEffort) {
            body.reasoning_effort = params.reasoningEffort
          }
        } else {
          body.enable_thinking = false
        }
      }

      if (params.tools?.length) {
        body.tools = params.tools
        if (params.toolChoice) {
          body.tool_choice = params.toolChoice
        }
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`DeepSeek API 流式错误 ${response.status}: ${text}`)
      }

      const reader = response.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const cleaned = line.trim()
          if (!cleaned || cleaned === 'data: [DONE]') continue
          if (!cleaned.startsWith('data: ')) continue

          try {
            const chunk = JSON.parse(cleaned.slice(6))
            const delta = chunk.choices?.[0]?.delta
            if (!delta) continue

            if (delta.reasoning_content) {
              yield { type: 'thinking', thinking: delta.reasoning_content }
            }
            if (delta.content) {
              yield { type: 'text', text: delta.content }
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  yield {
                    type: 'tool_use',
                    toolCallId: tc.id,
                    name: tc.function?.name || '',
                    input: {},
                  }
                }
                if (tc.function?.arguments) {
                  yield {
                    type: 'tool_use',
                    text: tc.function.arguments,
                  }
                }
              }
            }
          } catch {
            // 跳过解析错误的行
          }
        }
      }
    },
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
