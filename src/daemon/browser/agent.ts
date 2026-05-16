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
import { queryGUIModel, NoVisionModelError, type VisionModelConfig } from './gui-model.js'
import { extractPage, buildFallbackPrompt, parseFallbackResponse } from './dom-fallback.js'

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
    const maxSteps = task.maxSteps || this.config.maxSteps
    const steps: GUIStep[] = []

    try {
      // Navigate to start URL if provided
      if (task.startUrl) {
        await playwright.navigate(this.config, task.profileName, task.startUrl)
      }

      for (let i = 0; i < maxSteps; i++) {
        const stepStart = Date.now()

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
          screenshotBase64: screenshotBase64.slice(0, 200), // thumbnail only
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
    return playwright.navigate(this.config, profileName, url)
  }

  async screenshot(profileName: string): Promise<string> {
    return playwright.screenshot(this.config, profileName)
  }

  async extract(profileName: string, _selector: string): Promise<string> {
    const page = await extractPage(this.config, profileName)
    return page.text
  }

  listProfiles(): string[] {
    // Sync wrapper — profiles are listed via filesystem in listProfiles
    return []
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

  const dataDir = process.env.HONE_DATA_DIR || `${process.env.HOME || '~'}/.hone`
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

  const visionConfig: VisionModelConfig | null = guiModelUrl
    ? { url: guiModelUrl, model: config.guiModelName }
    : null

  return new BrowserAgent(config, visionConfig, onConfirm, onStep, llmCall)
}
