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
 *   - deepseek: DeepSeek API（默认模型 deepseek-chat）
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
    case 'openai': {
      return createOpenAIProvider()
    }
    case 'custom': {
      // Custom provider 使用独立的 HONE_CUSTOM_* 环境变量，与 OpenAI 隔离。
      // 直接通过参数传递配置，避免临时修改 process.env 导致的竞态条件。
      return createOpenAIProvider({
        apiKey: process.env.HONE_CUSTOM_API_KEY || '',
        baseUrl: process.env.HONE_CUSTOM_BASE_URL || 'https://api.openai.com',
        model: process.env.HONE_CUSTOM_MODEL || 'gpt-4o',
        name: process.env.HONE_CUSTOM_NAME || 'Custom',
      })
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
