/**
 * L1 Gateway LLM — 轻量级意图分类和任务分发。
 * 使用 DeepSeek provider，最小 token 消耗（不生成代码）。
 */
import { getProvider, type ProviderResponse } from '../services/providers/index.js'

// 已中文化 — 见上方

const GATEWAY_SYSTEM_PROMPT = `你是一个 AI 调度助手 (Hone Gateway)。
你的职责是理解用户意图，然后决定如何响应。你永远不直接操作文件或执行命令。

你可以:
- 回答简单问题
- 创建/管理日程 (schedule_task)
- 分派任务给 CLI 执行 (dispatch_task)
- 总结 CLI 执行结果
- 批准设备配对请求 (approve_pairing)

当用户要求做代码相关的操作时（读文件、写代码、运行命令等），你必须使用 dispatch_task 分派给 CLI。

回复用中文，简洁直接。`

export interface GatewayLLMResponse {
  action: 'reply' | 'dispatch' | 'schedule'
  reply?: string
  task?: string
}

export async function gatewayLLM(userMessage: string): Promise<GatewayLLMResponse> {
  const provider = getProvider()

  try {
    const response = await provider.createMessage({
      model: process.env.HONE_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      messages: [{ role: 'user', content: userMessage }],
      system: GATEWAY_SYSTEM_PROMPT,
      maxTokens: 512,
      temperature: 0.3,
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
