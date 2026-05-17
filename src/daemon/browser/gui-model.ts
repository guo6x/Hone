/**
 * GUI agent model client.
 * Sends screenshots + task description to a vision-capable model,
 * parses structured action JSON from the response.
 *
 * Reuses the existing provider chain for API calls.
 * Falls back to DOM-based extraction when no vision model is configured.
 */
import { getProvider } from '../../services/providers/index.js'
import type { GUIAction, GUITask } from './types.js'

const GUI_SYSTEM_PROMPT = `You are a vision-based web agent. Your task is to control a browser to complete user requests.

Given a screenshot and the current page state, respond with ONE action in JSON format:

{
  "action": "click",
  "selector": "css selector of element",
  "reason": "why you chose this action"
}

OR

{
  "action": "type",
  "selector": "css selector of input field",
  "text": "what to type",
  "reason": "why"
}

OR

{
  "action": "navigate",
  "url": "https://...",
  "reason": "why"
}

OR

{
  "action": "scroll",
  "coordinates": {"x": 0, "y": 300},
  "reason": "why"
}

OR

{
  "action": "press",
  "key": "Enter",
  "reason": "why"
}

OR

{
  "action": "wait",
  "waitMs": 2000,
  "reason": "why"
}

OR

{
  "action": "done",
  "reason": "task completed successfully"
}

OR

{
  "action": "fail",
  "reason": "why the task cannot be completed"
}

Rules:
- Use the most specific CSS selector possible (id > class > tag)
- Prefer [data-testid] or aria-label attributes when visible
- Never guess selectors that aren't visible in the page
- If the task is complete, return action: "done"
- Respond with JSON only, no markdown, no explanation outside the JSON`

export interface VisionModelConfig {
  url: string        // API endpoint
  model: string      // model name, e.g. "ui-tars-7b"
}

/**
 * Send a screenshot + task to the GUI agent model and get back an action.
 * Uses the vision-capable model endpoint configured via env vars.
 */
export async function queryGUIModel(
  screenshotBase64: string,
  task: string,
  domText: string,
  config: VisionModelConfig | null,
): Promise<GUIAction> {
  if (config && config.url) {
    return queryVisionModel(screenshotBase64, task, domText, config)
  }
  // No vision model configured — caller should use DOM fallback
  throw new NoVisionModelError()
}

async function queryVisionModel(
  screenshotBase64: string,
  task: string,
  domText: string,
  config: VisionModelConfig,
): Promise<GUIAction> {
  const provider = getProvider()

  const response = await provider.createMessage({
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: 'auto' },
          },
          {
            type: 'text',
            text: `Task: ${task}\n\nCurrent page text:\n${domText.slice(0, 4000)}\n\nRespond with the next action JSON.`,
          },
        ],
      },
    ],
    system: GUI_SYSTEM_PROMPT,
    maxTokens: 512,
    temperature: 0.1,
  })

  const text = extractText(response)
  return parseAction(text)
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

function parseAction(text: string): GUIAction {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    validateAction(parsed)
    return parsed
  } catch {
    // Try to find JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        validateAction(parsed)
        return parsed
      } catch {
        return { action: 'fail', reason: `Failed to parse model response: ${text.slice(0, 200)}` }
      }
    }
    return { action: 'fail', reason: `Failed to parse model response: ${text.slice(0, 200)}` }
  }
}

function validateAction(action: any): asserts action is GUIAction {
  const validActions = ['click', 'type', 'scroll', 'press', 'navigate', 'wait', 'done', 'fail']
  if (!validActions.includes(action.action)) {
    throw new Error(`Invalid action: ${action.action}`)
  }
}

export class NoVisionModelError extends Error {
  constructor() {
    super('No vision model configured')
    this.name = 'NoVisionModelError'
  }
}
