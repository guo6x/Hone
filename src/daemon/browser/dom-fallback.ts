/**
 * DOM-based fallback for when no vision model is available.
 * Extracts page text and uses gatewayLLM() to decide the next action.
 */
import type { GUIAction } from './types.js'

export interface PageElement {
  tag: string
  text: string
  type: string
  href: string
  placeholder: string
  id: string
  className: string
  ariaLabel: string
  dataTestId: string
}

export interface PageExtraction {
  text: string
  title: string
  url: string
  elements: PageElement[]
}

/**
 * The evaluation script injected into the browser page via page.evaluate().
 * Extracts visible text and all interactive element metadata.
 */
export function getPageExtractionScript(): string {
  return `
    (() => {
      const interactiveTags = ['input', 'button', 'a', 'select', 'textarea', '[role="button"]', '[onclick]'];
      const elements = [];
      for (const el of document.querySelectorAll(interactiveTags.join(','))) {
        if (el.offsetParent === null) continue;
        elements.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 100),
          type: el.getAttribute('type') || '',
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          id: el.id || '',
          className: (typeof el.className === 'string' ? el.className : '') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          dataTestId: el.getAttribute('data-testid') || '',
        });
      }
      return {
        text: (document.body?.innerText || '').slice(0, 8000),
        title: document.title,
        url: location.href,
        elements,
      };
    })()
  `
}

/**
 * Build a prompt for gatewayLLM based on extracted page content.
 */
export function buildFallbackPrompt(
  task: string,
  page: PageExtraction,
  step: number,
  maxSteps: number,
): string {
  const elementList = page.elements.slice(0, 50).map(el => {
    const parts = [
      el.id && `#${el.id}`,
      el.dataTestId && `[data-testid="${el.dataTestId}"]`,
      el.ariaLabel && `[aria-label="${el.ariaLabel}"]`,
    ].filter(Boolean)
    const bestSelector = parts[0] || el.tag
    return `  [${el.tag}] "${el.text.slice(0, 50)}" → ${bestSelector}`
  }).join('\n')

  return `You are a web automation agent. Based on the page content, decide the next browser action.

Task: ${task}
Step ${step} of ${maxSteps}
Page: ${page.title} (${page.url})

Visible text (first 3000 chars):
${page.text.slice(0, 3000)}

Interactive elements (top 50):
${elementList}

Respond with ONE action as JSON:
{
  "action": "click|type|navigate|scroll|wait|done|fail",
  "selector": "CSS selector",
  "text": "text to type (for type action only)",
  "reason": "brief explanation"
}
JSON only, no markdown.`
}

/**
 * Parse a GUIAction from the LLM's text response.
 */
export function parseFallbackResponse(text: string): GUIAction {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    return parsed
  } catch {
    const match = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch {}
    }
    return { action: 'fail', reason: `Failed to parse: ${text.slice(0, 200)}` }
  }
}
