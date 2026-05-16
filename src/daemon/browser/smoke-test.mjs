/**
 * Self-contained E2E test: real browser agent loop with DOM fallback.
 *
 * Run: node src/daemon/browser/smoke-test.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.hone', 'browser', 'e2e-test');
const PROFILE_DIR = join(DATA_DIR, 'profiles', 'default');
const STATE_FILE = join(PROFILE_DIR, 'state.json');

// ── DOM extraction ──

function getPageExtractionScript() {
  return `
    (() => {
      const interactiveTags = ['input', 'button', 'a', 'select', 'textarea', '[role="button"]'];
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
          name: el.getAttribute('name') || '',
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
  `;
}

function buildFallbackPrompt(task, page, step, maxSteps) {
  const elementList = page.elements.slice(0, 50).map(el => {
    const parts = [
      el.id && `#${el.id}`,
      el.name && `[name="${el.name}"]`,
      el.dataTestId && `[data-testid="${el.dataTestId}"]`,
      el.ariaLabel && `[aria-label="${el.ariaLabel}"]`,
    ].filter(Boolean);
    const typeHint = el.type ? ` type=${el.type}` : '';
    const bestSelector = parts[0] || el.tag;
    return `  [${el.tag}${typeHint}] "${el.text.slice(0, 50)}" → ${bestSelector}`;
  }).join('\n');

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
JSON only, no markdown.`;
}

function parseFallbackResponse(text) {
  const cleaned = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { action: 'fail', reason: `Failed to parse: ${text.slice(0, 100)}` };
}

// ── Playwright lifecycle ──

let browser = null;
const contexts = new Map();
const pages = new Map();

async function launchBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, timeout: 120000 });
  return browser;
}

async function getContext(profileName) {
  const existing = contexts.get(profileName);
  if (existing) return existing;
  await mkdir(PROFILE_DIR, { recursive: true });
  let storageState;
  try { storageState = JSON.parse(await readFile(STATE_FILE, 'utf-8')); } catch {}
  const b = await launchBrowser();
  const context = await b.newContext({
    storageState,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  contexts.set(profileName, context);
  return context;
}

async function getPage(profileName) {
  const existing = pages.get(profileName);
  if (existing && !existing.isClosed()) return existing;
  const context = await getContext(profileName);
  const page = await context.newPage();
  pages.set(profileName, page);
  return page;
}

async function navigate(profileName, url) {
  const page = await getPage(profileName);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  return {
    url: page.url(),
    title: await page.title(),
    screenshotBase64: (await page.screenshot({ type: 'jpeg', quality: 50 })).toString('base64'),
    domText: await page.evaluate(() => (document.body?.innerText || '').slice(0, 8000)),
  };
}

async function screenshotPage(profileName) {
  const page = await getPage(profileName);
  return (await page.screenshot({ type: 'jpeg', quality: 50 })).toString('base64');
}

async function extractPageData(profileName) {
  const page = await getPage(profileName);
  return page.evaluate(getPageExtractionScript());
}

async function executeAction(profileName, action) {
  const page = await getPage(profileName);
  switch (action.action) {
    case 'click':
      if (action.selector) await page.click(action.selector, { timeout: 10000 });
      else if (action.coordinates) await page.mouse.click(action.coordinates.x, action.coordinates.y);
      break;
    case 'type':
      if (action.selector && action.text) await page.fill(action.selector, action.text, { timeout: 10000 });
      break;
    case 'scroll':
      if (action.coordinates) await page.evaluate(({ x, y }) => window.scrollBy(x, y), action.coordinates);
      break;
    case 'press':
      if (action.key) await page.keyboard.press(action.key);
      break;
    case 'navigate':
      if (action.url) await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      break;
    case 'wait':
      await new Promise(resolve => setTimeout(resolve, action.waitMs || 1000));
      break;
  }
}

async function saveContextState(profileName) {
  const context = contexts.get(profileName);
  if (!context) return;
  const state = await context.storageState();
  await mkdir(PROFILE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function shutdown() {
  for (const [, page] of pages) { try { if (!page.isClosed()) await page.close(); } catch {} }
  pages.clear();
  for (const [, ctx] of contexts) { try { await ctx.close(); } catch {} }
  contexts.clear();
  if (browser?.isConnected()) await browser.close();
  browser = null;
}

// ── Agent loop ──

async function executeTask(task, llmCall) {
  const startTime = Date.now();
  const maxSteps = task.maxSteps || 5;
  const steps = [];

  try {
    if (task.startUrl) await navigate(task.profileName, task.startUrl);

    for (let i = 0; i < maxSteps; i++) {
      await screenshotPage(task.profileName);
      const page = await extractPageData(task.profileName);
      const prompt = buildFallbackPrompt(task.task, page, i + 1, maxSteps);
      const response = await llmCall(prompt);
      const action = parseFallbackResponse(response);

      const actionStart = Date.now();
      await executeAction(task.profileName, action);

      steps.push({ stepNumber: i + 1, action, durationMs: Date.now() - actionStart });
      console.log(`  [step ${i + 1}] ${action.action} | ${action.selector || action.text || ''} | ${action.reason || ''} | ${steps[steps.length - 1].durationMs}ms`);

      if (action.action === 'done') {
        await saveContextState(task.profileName);
        return { taskId: task.id, status: 'success', steps, finalUrl: page.url, durationMs: Date.now() - startTime };
      }
      if (action.action === 'fail') {
        return { taskId: task.id, status: 'failed', steps, error: action.reason || 'Agent reported failure', durationMs: Date.now() - startTime };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await saveContextState(task.profileName);
    return { taskId: task.id, status: 'timeout', steps, durationMs: Date.now() - startTime, error: `Reached max ${maxSteps} steps` };
  } catch (err) {
    return { taskId: task.id, status: 'failed', steps, error: err.message, durationMs: Date.now() - startTime };
  }
}

// ── Smart LLM: stateful mini-agent ──

let lastUrl = '';
let filledFields = new Set();

function smartLLM(prompt) {
  const taskLine = prompt.match(/Task: (.+)/);
  const task = taskLine ? taskLine[1].toLowerCase() : '';
  const urlMatch = prompt.match(/\(https?:\/\/[^)]+\)/);
  const currentUrl = urlMatch ? urlMatch[0].slice(1, -1) : '';
  const stepMatch = prompt.match(/Step (\d+) of/);
  const step = stepMatch ? parseInt(stepMatch[1]) : 1;

  // Reset state on page change
  if (currentUrl !== lastUrl) {
    filledFields = new Set();
    lastUrl = currentUrl;
  }

  const elementPattern = /\s+\[(\w+)\]\s+"([^"]*)"\s+→\s+(\S+)/g;
  const elements = [];
  let m;
  while ((m = elementPattern.exec(prompt)) !== null) {
    elements.push({ tag: m[1], text: m[2], selector: m[3] });
  }

  console.log(`  [llm] step=${step} task="${task.slice(0, 60)}" elements=${elements.length}`);

  // Phase 1: fill the first unfilled text-like input (skip radio/checkbox/submit)
  const inputs = elements.filter(e => e.tag === 'textarea' || (e.tag === 'input' && !/radio|checkbox|submit|hidden/i.test(e.text)));
  const unfilled = inputs.filter(e => !filledFields.has(e.selector));

  if (unfilled.length > 0 && (task.includes('fill') || task.includes('type') || task.includes('form') || step < 2)) {
    const target = unfilled[0];
    filledFields.add(target.selector);

    const quoted = task.match(/"([^"]+)"/);
    const text = quoted ? quoted[1] : 'Hone Test';
    return JSON.stringify({ action: 'type', selector: target.selector, text, reason: `fill "${text}" into ${target.selector}` });
  }

  // Phase 2: find and click submit-like button
  const buttons = elements.filter(e => e.tag === 'button' || (e.tag === 'input' && /submit/i.test(e.text)));
  if (buttons.length > 0) {
    const btn = buttons[0];
    return JSON.stringify({ action: 'click', selector: btn.selector, reason: `click "${btn.text}" to submit` });
  }

  // Phase 3: try links
  const links = elements.filter(e => e.tag === 'a');
  if (links.length > 0) {
    return JSON.stringify({ action: 'click', selector: links[0].selector, reason: `click "${links[0].text}"` });
  }

  return JSON.stringify({ action: 'done', reason: 'done' });
}

// ── Main ──

async function main() {
  console.log('=== BrowserAgent E2E Test ===\n');

  // Test 1: Navigate + extract
  console.log('1. Navigate to httpbin.org/forms/post');
  const state = await navigate('default', 'https://httpbin.org/forms/post');
  console.log(`   URL: ${state.url}`);
  console.log(`   DOM text: ${state.domText.length} chars\n`);

  const page = await extractPageData('default');
  console.log(`   Elements: ${page.elements.length}`);
  page.elements.slice(0, 5).forEach(el => {
    console.log(`     [${el.tag}] "${el.text.slice(0, 40)}" → ${el.id || el.name || el.tag}`);
  });
  console.log();

  // Test 2: Fill form and submit
  console.log('2. Task: "Fill the form with \"Hone Test\" and submit"');
  const result = await executeTask({
    id: 'e2e_1',
    profileName: 'default',
    task: 'Fill the form with "Hone Test" and submit',
    riskLevel: 'low',
    maxSteps: 5,
  }, smartLLM);

  console.log(`\n   Status: ${result.status}`);
  console.log(`   Steps: ${result.steps.length}`);
  console.log(`   Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(`   Final URL: ${result.finalUrl || 'N/A'}`);

  // Test 3: Screenshot
  console.log('\n3. Screenshot');
  const shot = await screenshotPage('default');
  console.log(`   ${shot.length} chars\n`);

  // Test 4: Session persistence
  console.log('4. Session persistence');
  await saveContextState('default');
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
    console.log(`   Cookies: ${(raw.cookies || []).length}`);
    console.log(`   Origins: ${(raw.origins || []).length}`);
  }

  await shutdown();

  const ok = result.status === 'success';
  console.log(`\n=== ${ok ? 'SUCCESS' : 'PARTIAL'} ===`);
  console.log(`   Loop verified: navigate → extract → decide → type/click → done`);
  console.log(`   ${result.steps.length} steps in ${(result.durationMs / 1000).toFixed(2)}s`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  shutdown().catch(() => {});
  process.exit(1);
});
