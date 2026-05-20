/**
 * Playwright lifecycle manager for Hone Browser Agent.
 *
 * Uses `launchPersistentContext(userDataDir)` per profile so EVERYTHING
 * persists across runs — cookies, localStorage, indexedDB, service workers.
 * The user logs into a site (e.g. xiaohongshu.com) once via the desktop
 * "open for login" flow, and the agent reuses that session indefinitely.
 *
 * Trade-off: we can't share one Browser across persistent contexts; each
 * profile is its own process. For a single-user app this is fine.
 */
import type { BrowserContext, Page } from 'playwright'
import type { BrowserConfig, BrowserState, GUIAction } from './types.js'
import { getPageExtractionScript, type PageExtraction } from './dom-fallback.js'
import fs from 'fs/promises'
import path from 'path'

const contexts = new Map<string, BrowserContext>()
const pages = new Map<string, Page>()

function profileUserDataDir(config: BrowserConfig, profileName: string): string {
  return path.join(config.dataDir, 'profiles', profileName, 'userData')
}

/**
 * Get or open a persistent browser context for a profile.
 *
 * The userDataDir is a real Chrome profile directory — anything the user
 * does there (cookies, logins, extensions) survives restarts.
 */
export async function getContext(
  config: BrowserConfig,
  profileName: string,
  opts: { headless?: boolean } = {},
): Promise<BrowserContext> {
  const existing = contexts.get(profileName)
  if (existing) return existing

  const userDataDir = profileUserDataDir(config, profileName)
  await fs.mkdir(userDataDir, { recursive: true })

  const { chromium } = await import('playwright')
  const headless = opts.headless ?? config.headless
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  contexts.set(profileName, context)
  // If the user closes the window manually (e.g. after login), clean up our refs.
  context.on('close', () => {
    contexts.delete(profileName)
    pages.delete(profileName)
  })
  return context
}

/**
 * Open a profile in a non-headless browser so the user can manually log in
 * to a site. Resolves when the user closes the window.
 *
 * This is the "log in once like a normal person" entry point — sessions
 * persist via the userDataDir on disk.
 */
export async function openProfileForLogin(
  config: BrowserConfig,
  profileName: string,
  startUrl?: string,
): Promise<void> {
  // Close any existing headless context for this profile so we can reopen
  // it visibly (only one persistent context can use a userDataDir at a time).
  await closeProfile(profileName)
  const context = await getContext(config, profileName, { headless: false })
  const page = context.pages()[0] || (await context.newPage())
  pages.set(profileName, page)
  if (startUrl) {
    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' })
    } catch {
      // ignore — user may navigate elsewhere
    }
  }
  // Wait for the user to close either the window or the whole context.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    page.once('close', finish)
    context.once('close', finish)
  })
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
 * Save the current browser context storage state.
 * With persistent contexts (userDataDir), Chrome persists everything to disk
 * automatically — this is a no-op kept for API compatibility.
 */
export async function saveContextState(_config: BrowserConfig, _profileName: string): Promise<void> {
  // No-op: persistent context handles all storage on disk via Chrome itself.
}

/**
 * Close a specific profile's page and context.
 */
export async function closeProfile(profileName: string): Promise<void> {
  const page = pages.get(profileName)
  if (page && !page.isClosed()) {
    try { await page.close() } catch {}
  }
  pages.delete(profileName)

  const context = contexts.get(profileName)
  if (context) {
    try { await context.close() } catch {}
  }
  contexts.delete(profileName)
}

/**
 * Shut down browser and clean up all profiles.
 */
export async function shutdown(): Promise<void> {
  const names = [...pages.keys(), ...contexts.keys()]
  const unique = Array.from(new Set(names))
  for (const name of unique) {
    try { await closeProfile(name) } catch {}
  }
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
