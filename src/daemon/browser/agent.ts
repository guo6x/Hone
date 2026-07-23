/**
 * Browser Agent — core automation loop.
 * Orchestrates Playwright + GUI model (or DOM fallback) to execute web tasks.
 *
 * Loop:
 *   1. Take screenshot + extract page text
 *   2. Send to GUI model (or DOM fallback via gatewayLLM)
 *   3. Parse action JSON from response
 *   4. Execute action in Playwright
 *   5. Check if task is complete or max steps reached
 *   6. Save browser state to disk
 */
import type {
  BrowserConfig,
  GUITask,
  GUITaskResult,
  GUIStep,
  GUIAction,
  BrowserAgent as BrowserAgentInterface,
} from './types.js'
import * as playwright from './playwright-runner.js'
import { validateUrl } from './playwright-runner.js'
import { queryGUIModel, visionConfigFromEnv, NoVisionModelError, type VisionModelConfig } from './gui-model.js'
import { extractPage } from './playwright-runner.js'
import { buildFallbackPrompt, parseFallbackResponse } from './dom-fallback.js'
import * as os from 'os'

/** Callback to request user confirmation for high-risk actions. */
export type ConfirmCallback = (taskId: string, description: string) => Promise<boolean>

/** Callback to broadcast agent step progress to connected clients. */
export type StepCallback = (taskId: string, step: GUIStep) => void

/** GatewayLLM function signature for DOM fallback. */
export type LLMCallback = (prompt: string) => Promise<string>

export class BrowserAgent implements BrowserAgentInterface {
  private config: BrowserConfig
  private visionConfig: VisionModelConfig | null
  private onConfirm: ConfirmCallback
  private onStep: StepCallback
  private llmCall: LLMCallback | null

  constructor(
    config: BrowserConfig,
    visionConfig: VisionModelConfig | null,
    onConfirm: ConfirmCallback,
    onStep: StepCallback,
    llmCall: LLMCallback | null,
  ) {
    this.config = config
    this.visionConfig = visionConfig
    this.onConfirm = onConfirm
    this.onStep = onStep
    this.llmCall = llmCall
  }

  async executeTask(task: GUITask): Promise<GUITaskResult> {
    const startTime = Date.now()
    // maxSteps 校验：
    //   - 至少 1（避免 0 步直接退出无法执行任何动作）
    //   - 至多 100（防止配置错误导致无限循环消耗 token）
    //   - 优先级：task.maxSteps > config.maxSteps > 默认 15
    const rawMaxSteps = task.maxSteps || this.config.maxSteps || 15
    const maxSteps = Math.max(1, Math.min(100, rawMaxSteps))
    const taskTimeoutMs = (task.timeoutMs || this.config.defaultTimeout * 5) // default 5 mins
    const steps: GUIStep[] = []

    try {
      // Navigate to start URL if provided
      if (task.startUrl) {
        validateUrl(task.startUrl)
        await playwright.navigate(this.config, task.profileName, task.startUrl)
      }

      for (let i = 0; i < maxSteps; i++) {
        // Global task timeout check
        if (Date.now() - startTime > taskTimeoutMs) {
          return {
            taskId: task.id,
            status: 'timeout',
            steps,
            durationMs: Date.now() - startTime,
            error: `Global task timeout after ${taskTimeoutMs}ms`,
          }
        }

        const stepStart = Date.now()

        // 截图前等待 200ms 让页面稳定（避免截到加载中的中间状态）。
        // 不使用 waitForLoadState('networkidle') 因为很多 SPA 永远不会 idle。
        await new Promise(resolve => setTimeout(resolve, 200))

        // Get current page state
        const screenshotBase64 = await playwright.screenshot(this.config, task.profileName)
        const page = await extractPage(this.config, task.profileName)

        // Decide action
        let action: GUIAction
        try {
          action = await queryGUIModel(screenshotBase64, task.task, page.text, this.visionConfig)
        } catch (err) {
          if (err instanceof NoVisionModelError && this.llmCall) {
            // DOM fallback
            const prompt = buildFallbackPrompt(task.task, page, i + 1, maxSteps)
            const response = await this.llmCall(prompt)
            action = parseFallbackResponse(response)
          } else {
            throw err
          }
        }

        // 防御性检查：action 必须有 action 字段且为已知类型，
        // 否则视为 fail，避免无效 action 导致死循环
        const validActions = ['click', 'type', 'scroll', 'navigate', 'wait', 'done', 'fail']
        if (!action || !action.action || !validActions.includes(action.action)) {
          return {
            taskId: task.id,
            status: 'failed',
            steps,
            error: `Invalid action returned by model: ${JSON.stringify(action).slice(0, 200)}`,
            durationMs: Date.now() - startTime,
          }
        }

        // Check for high-risk action confirmation
        if (task.riskLevel === 'high' && ['click', 'type'].includes(action.action)) {
          const confirmed = await this.onConfirm(
            task.id,
            `About to ${action.action} "${action.selector || ''}" — ${action.reason || ''}`,
          )
          if (!confirmed) {
            return {
              taskId: task.id,
              status: 'cancelled',
              steps,
              durationMs: Date.now() - startTime,
              error: 'User cancelled high-risk action',
            }
          }
        }

        // Execute action
        const actionStart = Date.now()
        await playwright.executeAction(this.config, task.profileName, action)

        const step: GUIStep = {
          stepNumber: i + 1,
          action,
          screenshotBase64, // full screenshot for client preview
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - actionStart,
        }
        steps.push(step)

        // Broadcast step to clients
        try { this.onStep(task.id, step) } catch {}

        // Check completion
        if (action.action === 'done') {
          await playwright.saveContextState(this.config, task.profileName)
          return {
            taskId: task.id,
            status: 'success',
            steps,
            finalUrl: page.url,
            durationMs: Date.now() - startTime,
          }
        }

        if (action.action === 'fail') {
          return {
            taskId: task.id,
            status: 'failed',
            steps,
            error: action.reason || 'Agent reported failure',
            durationMs: Date.now() - startTime,
          }
        }

        // Brief pause between steps
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      // Max steps reached
      await playwright.saveContextState(this.config, task.profileName)
      return {
        taskId: task.id,
        status: 'timeout',
        steps,
        durationMs: Date.now() - startTime,
        error: `Reached max ${maxSteps} steps`,
      }
    } catch (err: any) {
      return {
        taskId: task.id,
        status: 'failed',
        steps,
        error: err.message || String(err),
        durationMs: Date.now() - startTime,
      }
    }
  }

  async navigate(profileName: string, url: string): Promise<import('./types.js').BrowserState> {
    validateUrl(url)
    return playwright.navigate(this.config, profileName, url)
  }

  async screenshot(profileName: string): Promise<string> {
    return playwright.screenshot(this.config, profileName)
  }

  async extract(profileName: string, selector: string): Promise<string> {
    const page = await extractPage(this.config, profileName, selector)
    return page.text
  }

  async listProfiles(): Promise<string[]> {
    const fs = await import('fs/promises')
    const path = await import('path')
    const profilesDir = path.join(this.config.dataDir, 'profiles')
    try {
      const entries = await fs.readdir(profilesDir)
      const dirs: string[] = []
      for (const entry of entries) {
        try {
          const stat = await fs.stat(path.join(profilesDir, entry))
          if (stat.isDirectory()) dirs.push(entry)
        } catch {}
      }
      return dirs
    } catch {
      return []
    }
  }

  async shutdown(): Promise<void> {
    await playwright.shutdown()
  }
}

/** Factory: create a BrowserAgent with defaults from environment. */
export function createBrowserAgent(
  onConfirm: ConfirmCallback,
  onStep: StepCallback,
  llmCall: LLMCallback | null,
): BrowserAgent | null {
  const enabled = process.env.HONE_BROWSER_ENABLED === 'true' || process.env.HONE_BROWSER_ENABLED === '1'
  if (!enabled) return null

  const dataDir = process.env.HONE_DATA_DIR || `${os.homedir()}/.hone`
  const guiModelUrl = process.env.HONE_GUI_MODEL_URL || ''

  const config: BrowserConfig = {
    enabled: true,
    headless: process.env.HONE_BROWSER_HEADLESS !== 'false',
    guiModelUrl,
    guiModelName: process.env.HONE_GUI_MODEL_NAME || 'ui-tars-7b',
    maxSteps: parseInt(process.env.HONE_BROWSER_MAX_STEPS || '15', 10),
    screenshotQuality: parseInt(process.env.HONE_BROWSER_SCREENSHOT_QUALITY || '75', 10),
    dataDir: `${dataDir}/browser`,
    defaultTimeout: parseInt(process.env.HONE_BROWSER_TIMEOUT || '30000', 10),
  }

  // 复用 visionConfigFromEnv 统一 API Key 降级链，避免两处降级顺序不一致
  // （原 agent.ts 缺少 ARK_API_KEY，导致用户配置 ARK_API_KEY 时无法生效）。
  const visionConfig = visionConfigFromEnv()
  if (visionConfig) {
    console.error(`[BrowserAgent] vision model: ${visionConfig.model || '(unnamed)'} @ ${visionConfig.url}`)
  }

  return new BrowserAgent(config, visionConfig, onConfirm, onStep, llmCall)
}
