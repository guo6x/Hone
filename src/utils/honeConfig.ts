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

/** DeepSeek 旧版/无效模型名映射到当前旗舰模型 deepseek-v4-pro。
 *  - deepseek-v4 是无效名称（官方只有 v4-pro / v4-flash）
 *  - deepseek-chat / deepseek-reasoner 已在 2026-07-24 废弃
 */
const INVALID_DEEPSEEK_MODELS = new Set(['deepseek-v4', 'deepseek-chat', 'deepseek-reasoner'])
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'

function normalizeModelName(model?: string): string | undefined {
  if (!model) return undefined
  if (INVALID_DEEPSEEK_MODELS.has(model.trim().toLowerCase())) {
    return DEFAULT_DEEPSEEK_MODEL
  }
  return model
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

function maskedKey(key?: string): string {
  if (!key) return '(未设置)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

/**
 * 将配置文件中的值注入到 process.env，供 Gateway 和 Provider 读取。
 *
 * Hone CLI 有自己的持久化配置（~/.hone/cli-config.json），是用户通过 Settings
 * 显式保存的权威来源。系统环境变量中可能残留过期/无效的 key（例如用户之前
 * 手动设置过旧 key），因此配置文件中的非空值会覆盖同名环境变量。
 * 仅在配置文件没有对应值时，保留已有环境变量。
 *
 * 设置 HONE_CONFIG_APPLIED 标记，供 managedEnv.ts 识别，防止 Claude Code 的
 * settings.json env 在后续初始化中覆盖 Hone 管理的 provider/API key 变量。
 */
export function applyConfigToEnv(config: HoneCliConfig): void {
  process.env.HONE_CONFIG_APPLIED = '1'
  const provider = config.provider
  if (provider) {
    process.env.HONE_PROVIDER = provider
  }

  const normalizedModel = normalizeModelName(config.model)
  if (normalizedModel) {
    process.env.HONE_MODEL = normalizedModel
  }

  // 主循环模型默认跟随 provider，避免 DeepSeek provider + Claude 模型名的错误组合。
  // 只有当用户没有显式设置 ANTHROPIC_MODEL 时才注入。
  if (normalizedModel && !process.env.ANTHROPIC_MODEL) {
    process.env.ANTHROPIC_MODEL = normalizedModel
  }

  if (config.deepseekApiKey) {
    const prev = process.env.HONE_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY
    process.env.HONE_DEEPSEEK_API_KEY = config.deepseekApiKey
    if (prev && prev !== config.deepseekApiKey) {
      console.error(`[Hone Config] 使用 ~/.hone/cli-config.json 中的 DeepSeek API key (${maskedKey(config.deepseekApiKey)})，覆盖环境变量中的旧值 (${maskedKey(prev)})`)
    }
  }
  if (config.deepseekBaseUrl) {
    process.env.HONE_DEEPSEEK_BASE_URL = config.deepseekBaseUrl
  }
  if (config.openaiApiKey) {
    const prev = process.env.HONE_OPENAI_API_KEY || process.env.OPENAI_API_KEY
    process.env.HONE_OPENAI_API_KEY = config.openaiApiKey
    if (prev && prev !== config.openaiApiKey) {
      console.error(`[Hone Config] 使用 ~/.hone/cli-config.json 中的 OpenAI API key (${maskedKey(config.openaiApiKey)})，覆盖环境变量中的旧值 (${maskedKey(prev)})`)
    }
  }
  if (config.openaiBaseUrl) {
    process.env.HONE_OPENAI_BASE_URL = config.openaiBaseUrl
  }
}

export function maskKey(key?: string): string {
  if (!key) return '(未设置)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
