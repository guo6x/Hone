// Rasterize hone-logo.svg → hone-icon.png (1024×1024) using Playwright.
// The PNG is the input to `tauri icon`, which fans it out to .ico / .icns /
// multiple platform-specific sizes.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '..', 'src-tauri', 'icons', 'hone-logo.svg');
const pngOut = resolve(here, '..', 'src-tauri', 'icons', 'hone-icon.png');

const svg = readFileSync(svgPath, 'utf-8');

// Wrap the SVG in a minimal page so we can screenshot it exactly.
const html = `<!doctype html>
<html><head><style>
  html, body { margin:0; padding:0; background: transparent; }
  body { width: 1024px; height: 1024px; }
  svg { display: block; width: 1024px; height: 1024px; }
</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });
const buf = await page.screenshot({ omitBackground: true, type: 'png' });
writeFileSync(pngOut, buf);
await browser.close();

console.log(`✓ Wrote ${pngOut} (${buf.length} bytes)`);
