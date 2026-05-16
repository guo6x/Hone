/**
 * Postinstall script - runs automatically after `pnpm install`.
 *
 * 1. Creates stub modules for Anthropic-internal private packages
 *    that are not available on the public npm registry.
 * 2. Patches commander to allow multi-character short flags (e.g. -d2e).
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const NM = join(ROOT, 'node_modules')

// ─── 1. Private package stubs ───────────────────────────────────────────────

const stubs = [
  {
    dir: join(NM, 'color-diff-napi'),
    pkg: { name: 'color-diff-napi', version: '0.0.0', main: 'index.js', type: 'module' },
    code: `// Stub: native syntax highlighting module (unavailable outside Anthropic)
export class ColorDiff { constructor() {} render() { return null; } }
export class ColorFile { constructor() {} render() { return null; } }
export function getSyntaxTheme() { return null; }
`,
  },
  {
    dir: join(NM, 'modifiers-napi'),
    pkg: { name: 'modifiers-napi', version: '0.0.0', main: 'index.js' },
    code: `// Stub: macOS keyboard modifier detection (unavailable outside Anthropic)
module.exports = {
  prewarm() {},
  isModifierPressed() { return false; },
};
`,
  },
  {
    dir: join(NM, '@ant', 'claude-for-chrome-mcp'),
    pkg: { name: '@ant/claude-for-chrome-mcp', version: '0.0.0', main: 'index.js', type: 'module' },
    code: `// Stub: Chrome extension MCP server (unavailable outside Anthropic)
export const BROWSER_TOOLS = [];
export function createClaudeForChromeMcpServer() { throw new Error('Not available'); }
`,
  },
  {
    dir: join(NM, '@anthropic-ai', 'mcpb'),
    pkg: { name: '@anthropic-ai/mcpb', version: '0.0.0', main: 'index.js', type: 'module' },
    code: `// Stub: MCP bundle handler (unavailable outside Anthropic)
export const McpbManifestSchema = { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) };
export function getMcpConfigForManifest() { return {}; }
`,
  },
  {
    dir: join(NM, '@anthropic-ai', 'sandbox-runtime'),
    pkg: { name: '@anthropic-ai/sandbox-runtime', version: '0.0.0', main: 'index.js', type: 'module' },
    code: `// Stub: Linux sandbox runtime (unavailable outside Anthropic)
export class SandboxManager {
  constructor() {}
  async start() {}
  async stop() {}
  static isSupportedPlatform() { return false; }
  static checkDependencies() { return { satisfied: false, missing: [] }; }
  static async initialize() {}
  static updateConfig() {}
  static async reset() {}
  static wrapWithSandbox(command) { return command; }
  static getFsReadConfig() { return null; }
  static getFsWriteConfig() { return null; }
  static getNetworkRestrictionConfig() { return null; }
  static getIgnoreViolations() { return null; }
  static getAllowUnixSockets() { return false; }
  static getAllowLocalBinding() { return false; }
  static getEnableWeakerNestedSandbox() { return false; }
  static getProxyPort() { return null; }
  static getSocksProxyPort() { return null; }
}
export const SandboxRuntimeConfigSchema = { parse: (v) => v };
export class SandboxViolationStore {
  constructor() {}
  getViolations() { return []; }
}
`,
  },
]

let stubCount = 0
for (const stub of stubs) {
  mkdirSync(stub.dir, { recursive: true })
  writeFileSync(join(stub.dir, 'package.json'), JSON.stringify(stub.pkg, null, 2) + '\n')
  writeFileSync(join(stub.dir, 'index.js'), stub.code)
  stubCount++
}
console.log(`  ✓ Created ${stubCount} private package stubs`)

// ─── 2. Patch commander ─────────────────────────────────────────────────────
//
// The source uses `-d2e` as a multi-character short flag, but commander v14
// only allows single-character short flags (`/^-[^-]$/`).
// We relax the regex to `/^-[^-]+$/` to accept multi-character short flags.

const optionFile = join(NM, 'commander', 'lib', 'option.js')
try {
  let content = readFileSync(optionFile, 'utf-8')
  const original = '/^-[^-]$/'
  const patched = '/^-[^-]+$/'
  if (content.includes(original)) {
    content = content.replace(original, patched)
    writeFileSync(optionFile, content)
    console.log('  ✓ Patched commander for multi-character short flags')
  } else if (content.includes(patched)) {
    console.log('  ✓ Commander already patched')
  } else {
    console.log('  ⚠ Commander patch target not found (version may differ)')
  }
} catch (e) {
  console.log('  ⚠ Could not patch commander:', e.message)
}

console.log('  ✓ Postinstall complete')
