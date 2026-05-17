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
    case 'openai': {
      return createOpenAIProvider()
    }
    case 'custom': {
      // Custom provider 使用独立的 HONE_CUSTOM_* 环境变量，与 OpenAI 隔离。
      // 复用 OpenAI 兼容的 chat completions 调用逻辑，但参数全部来自 CUSTOM 命名空间。
      const savedKey = process.env.OPENAI_API_KEY
      const savedBase = process.env.OPENAI_BASE_URL
      const savedModel = process.env.OPENAI_MODEL
      try {
        process.env.OPENAI_API_KEY =
          process.env.HONE_CUSTOM_API_KEY || ''
        process.env.OPENAI_BASE_URL =
          process.env.HONE_CUSTOM_BASE_URL || 'https://api.openai.com'
        if (process.env.HONE_CUSTOM_MODEL) {
          process.env.OPENAI_MODEL = process.env.HONE_CUSTOM_MODEL
        }
        const provider = createOpenAIProvider()
        return {
          ...provider,
          name: process.env.HONE_CUSTOM_NAME || 'Custom',
        }
      } finally {
        // Restore originals — provider closes over current env at creation,
        // but other code may still rely on OPENAI_* being unchanged.
        if (savedKey === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = savedKey
        if (savedBase === undefined) delete process.env.OPENAI_BASE_URL
        else process.env.OPENAI_BASE_URL = savedBase
        if (savedModel === undefined) delete process.env.OPENAI_MODEL
        else process.env.OPENAI_MODEL = savedModel
      }
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
