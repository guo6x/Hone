/**
 * Playwright lifecycle manager for Hone Browser Agent.
 * Handles browser launch, context creation with persistent sessions,
 * page operations, and cleanup.
 */
import type { Browser, BrowserContext, Page } from 'playwright'
import type { BrowserConfig, BrowserState, BrowserProfile, GUIAction } from './types.js'
import { getPageExtractionScript, type PageExtraction } from './dom-fallback.js'
import fs from 'fs/promises'
import path from 'path'

let browser: Browser | null = null
const contexts = new Map<string, BrowserContext>()
const pages = new Map<string, Page>()

/**
 * Launch or reuse the Playwright browser instance.
 */
export async function launchBrowser(config: BrowserConfig): Promise<Browser> {
  if (browser?.isConnected()) return browser

  // Dynamic import to avoid loading playwright when browser is disabled
  const { chromium } = await import('playwright')
  browser = await chromium.launch({
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  return browser
}

/**
 * Get or create a browser context for a profile.
 * Restores storage state (cookies, localStorage) from disk.
 */
export async function getContext(config: BrowserConfig, profileName: string): Promise<BrowserContext> {
  const existing = contexts.get(profileName)
  if (existing) return existing

  const profileDir = path.join(config.dataDir, 'profiles', profileName)
  await fs.mkdir(profileDir, { recursive: true })

  const stateFile = path.join(profileDir, 'state.json')
  let storageState: any = undefined
  try {
    const raw = await fs.readFile(stateFile, 'utf-8')
    storageState = JSON.parse(raw)
  } catch {
    // No saved state yet — fresh session
  }

  const b = await launchBrowser(config)
  const context = await b.newContext({
    storageState,
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  contexts.set(profileName, context)
  return context
}

/**
 * Get or create a page for a profile.
 */
export async function getPage(config: BrowserConfig, profileName: string): Promise<Page> {
  const existing = pages.get(profileName)
  if (existing && !existing.isClosed()) return existing

  const context = await getContext(config, profileName)
  const page = await context.newPage()
  pages.set(profileName, page)
  return page
}

/**
 * Navigate to a URL and return the page state.
 */
export async function navigate(
  config: BrowserConfig,
  profileName: string,
  url: string,
): Promise<BrowserState> {
  const page = await getPage(config, profileName)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout })

  const title = await page.title()
  const screenshot = await page.screenshot({ type: 'jpeg', quality: config.screenshotQuality })
  const domText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 8000))

  return {
    url: page.url(),
    title,
    screenshotBase64: screenshot.toString('base64'),
    domText,
  }
}

/**
 * Extract structured page content for DOM fallback.
 */
export async function extractPage(config: BrowserConfig, profileName: string): Promise<PageExtraction> {
  const page = await getPage(config, profileName)
  return page.evaluate(getPageExtractionScript()) as Promise<PageExtraction>
}

/**
 * Take a screenshot of the current page.
 */
export async function screenshot(config: BrowserConfig, profileName: string): Promise<string> {
  const page = await getPage(config, profileName)
  const buf = await page.screenshot({ type: 'jpeg', quality: config.screenshotQuality })
  return buf.toString('base64')
}

/**
 * Execute a parsed GUIAction on the page.
 */
export async function executeAction(
  config: BrowserConfig,
  profileName: string,
  action: GUIAction,
): Promise<void> {
  const page = await getPage(config, profileName)

  switch (action.action) {
    case 'click': {
      if (action.selector) {
        await page.click(action.selector, { timeout: config.defaultTimeout })
      } else if (action.coordinates) {
        await page.mouse.click(action.coordinates.x, action.coordinates.y)
      }
      break
    }
    case 'type': {
      if (action.selector && action.text) {
        await page.fill(action.selector, action.text, { timeout: config.defaultTimeout })
      }
      break
    }
    case 'scroll': {
      if (action.coordinates) {
        await page.evaluate(
          ({ x, y }: { x: number; y: number }) => window.scrollBy(x, y),
          action.coordinates,
        )
      }
      break
    }
    case 'press': {
      if (action.key) {
        await page.keyboard.press(action.key)
      }
      break
    }
    case 'navigate': {
      if (action.url) {
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout })
      }
      break
    }
    case 'wait': {
      await new Promise(resolve => setTimeout(resolve, action.waitMs || 1000))
      break
    }
    case 'done':
    case 'fail':
      break
  }
}

/**
 * Save the current browser context storage state to disk.
 */
export async function saveContextState(config: BrowserConfig, profileName: string): Promise<void> {
  const context = contexts.get(profileName)
  if (!context) return

  const profileDir = path.join(config.dataDir, 'profiles', profileName)
  await fs.mkdir(profileDir, { recursive: true })

  const state = await context.storageState()
  await fs.writeFile(path.join(profileDir, 'state.json'), JSON.stringify(state, null, 2))
}

/**
 * Close a specific profile's page and context.
 */
export async function closeProfile(profileName: string): Promise<void> {
  const page = pages.get(profileName)
  if (page && !page.isClosed()) await page.close()
  pages.delete(profileName)

  const context = contexts.get(profileName)
  if (context) await context.close()
  contexts.delete(profileName)
}

/**
 * Shut down browser and clean up all profiles.
 */
export async function shutdown(): Promise<void> {
  for (const [name] of pages) {
    try { await closeProfile(name) } catch {}
  }
  if (browser?.isConnected()) {
    await browser.close()
  }
  browser = null
}

/**
 * List all known browser profiles from disk.
 */
export async function listProfiles(config: BrowserConfig): Promise<string[]> {
  const profilesDir = path.join(config.dataDir, 'profiles')
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
}
