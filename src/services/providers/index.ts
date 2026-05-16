/**
 * AI Provider 工厂 —— 根据环境变量自动选择供应商。
 *
 * 优先级:
 *   1. HONE_PROVIDER 显式指定 (deepseek / openai / custom)
 *   2. DEEPSEEK_API_KEY 存在 → DeepSeek
 *   3. OPENAI_API_KEY 存在 → OpenAI
 *   4. HONE_CUSTOM_API_KEY 存在 → Custom
 *   5. 默认 → DeepSeek
 *
 * 可用提供商:
 *   - deepseek: DeepSeek API（默认模型 deepseek-v4-pro）
 *   - openai:   OpenAI / Azure OpenAI / 兼容 API
 *   - custom:   自定义 OpenAI 兼容端点（设置 HONE_CUSTOM_BASE_URL）
 */
import type { AIProvider } from './types.js'
import { createDeepSeekProvider } from './deepseek.js'
import { createOpenAIProvider } from './openai.js'

export type { AIProvider, CreateMessageParams, ProviderResponse, ProviderMessage, ProviderTool, StreamChunk } from './types.js'

let cachedProvider: AIProvider | null = null
let cachedProviderName: string | null = null

export function getProvider(): AIProvider {
  const desired = process.env.HONE_PROVIDER || detectProvider()

  if (cachedProvider && cachedProviderName === desired) {
    return cachedProvider
  }

  cachedProviderName = desired
  cachedProvider = createProvider(desired)
  return cachedProvider
}

function detectProvider(): string {
  if (process.env.DEEPSEEK_API_KEY || process.env.HONE_DEEPSEEK_API_KEY) return 'deepseek'
  if (process.env.OPENAI_API_KEY || process.env.HONE_OPENAI_API_KEY) return 'openai'
  if (process.env.HONE_CUSTOM_API_KEY) return 'custom'
  return 'deepseek'
}

function createProvider(name: string): AIProvider {
  switch (name) {
    case 'openai':
    case 'custom': {
      // Custom provider 复用 OpenAI 兼容格式，使用不同的环境变量
      const provider = createOpenAIProvider()
      // 如果是 custom，覆盖名称和 base URL
      if (name === 'custom') {
        const customName = process.env.HONE_CUSTOM_NAME || 'Custom'
        return {
          ...provider,
          name: customName,
        }
      }
      return provider
    }
    case 'deepseek':
    default:
      return createDeepSeekProvider()
  }
}

export function clearProviderCache(): void {
  cachedProvider = null
  cachedProviderName = null
}

/** 获取当前提供商名称（用于显示） */
export function getProviderName(): string {
  return getProvider().name
}
