/**
 * Hone CLI 持久化配置管理
 *
 * 配置保存在用户主目录下的 ~/.hone/config.json，避免 API key 进入 git 仓库。
 * CLI 启动 Gateway 前会自动读取并注入到 process.env。
 */
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export interface HoneCliConfig {
  /** 默认 AI provider: deepseek | openai */
  provider?: string
  /** 默认模型 */
  model?: string
  /** DeepSeek API key */
  deepseekApiKey?: string
  /** DeepSeek base URL（可选） */
  deepseekBaseUrl?: string
  /** OpenAI API key */
  openaiApiKey?: string
  /** OpenAI base URL（可选） */
  openaiBaseUrl?: string
}

const CONFIG_DIR = join(homedir(), '.hone')
const CONFIG_FILE = join(CONFIG_DIR, 'cli-config.json')

export async function loadConfig(): Promise<HoneCliConfig> {
  if (!existsSync(CONFIG_FILE)) {
    return {}
  }
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as HoneCliConfig
  } catch (err) {
    console.error(`[Hone] 读取配置文件失败: ${err}`)
    return {}
  }
}

export async function saveConfig(config: HoneCliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600, // 仅所有者可读写
  })
}

/**
 * 将配置文件中的值注入到 process.env，供 Gateway 和 Provider 读取。
 * 以配置文件为基准，但已有环境变量的优先级更高。
 */
export function applyConfigToEnv(config: HoneCliConfig): void {
  if (config.provider && !process.env.HONE_PROVIDER) {
    process.env.HONE_PROVIDER = config.provider
  }
  if (config.model && !process.env.HONE_MODEL) {
    process.env.HONE_MODEL = config.model
  }
  if (config.deepseekApiKey && !process.env.DEEPSEEK_API_KEY && !process.env.HONE_DEEPSEEK_API_KEY) {
    process.env.HONE_DEEPSEEK_API_KEY = config.deepseekApiKey
  }
  if (config.deepseekBaseUrl && !process.env.DEEPSEEK_BASE_URL && !process.env.HONE_DEEPSEEK_BASE_URL) {
    process.env.HONE_DEEPSEEK_BASE_URL = config.deepseekBaseUrl
  }
  if (config.openaiApiKey && !process.env.OPENAI_API_KEY && !process.env.HONE_OPENAI_API_KEY) {
    process.env.HONE_OPENAI_API_KEY = config.openaiApiKey
  }
  if (config.openaiBaseUrl && !process.env.OPENAI_BASE_URL && !process.env.HONE_OPENAI_BASE_URL) {
    process.env.HONE_OPENAI_BASE_URL = config.openaiBaseUrl
  }
}

export function maskKey(key?: string): string {
  if (!key) return '(未设置)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
