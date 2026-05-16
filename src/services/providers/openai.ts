/**
 * OpenAI Provider —— 当设置 OPENAI_API_KEY 时自动切换。
 * 实现 AIProvider 接口，使用 OpenAI Chat Completions API。
 */
import type { AIProvider, CreateMessageParams, ProviderResponse, StreamChunk } from './types.js'

export function createOpenAIProvider(): AIProvider {
  const apiKey =
    process.env.HONE_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  const baseUrl =
    process.env.HONE_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com'
  const defaultModel =
    process.env.HONE_OPENAI_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-4o'

  return {
    name: 'OpenAI',

    async createMessage(params: CreateMessageParams): Promise<ProviderResponse> {
      if (!apiKey) {
        throw new Error('未设置 OPENAI_API_KEY 或 HONE_OPENAI_API_KEY 环境变量')
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

      const body: any = {
        model,
        messages,
        max_tokens: params.maxTokens || 4096,
        temperature: params.temperature ?? 0.7,
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
        throw new Error(`OpenAI API 错误 ${response.status}: ${text}`)
      }

      const data: any = await response.json()
      const choice = data.choices?.[0]
      const message = choice?.message

      // 处理 tool_calls
      if (message?.tool_calls?.length) {
        const content: any[] = []
        if (message.content) {
          content.push({ type: 'text', text: message.content })
        }
        for (const tc of message.tool_calls) {
          content.push({
            type: 'tool_use',
            toolCallId: tc.id,
            toolName: tc.function.name,
            toolInput: safeJsonParse(tc.function.arguments),
          })
        }
        return {
          content,
          model: data.model,
          usage: data.usage
            ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
            : undefined,
          stopReason: 'tool_use',
        }
      }

      return {
        content: message?.content || '',
        model: data.model,
        usage: data.usage
          ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
          : undefined,
        stopReason: choice?.finish_reason,
      }
    },

    async *streamMessage(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
      if (!apiKey) {
        throw new Error('未设置 OPENAI_API_KEY 或 HONE_OPENAI_API_KEY 环境变量')
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

      const body: any = {
        model,
        messages,
        max_tokens: params.maxTokens || 4096,
        temperature: params.temperature ?? 0.7,
        stream: true,
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
        throw new Error(`OpenAI API 流式错误 ${response.status}: ${text}`)
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

            if (delta.content) {
              yield { type: 'text', text: delta.content }
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  yield {
                    type: 'tool_use',
                    toolCallId: tc.id,
                    toolName: tc.function?.name || '',
                    toolInput: {},
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
