/**
 * Build script for Claude Code source reconstruction.
 * Uses Bun's bundler with feature flag definitions and MACRO constants.
 */

const VERSION = '2.1.88'
const BUILD_TIME = new Date().toISOString()

// All feature flags - setting ALL to true to unlock hidden features
const featureFlags: Record<string, boolean> = {
  ABLATION_BASELINE: true,
  AGENT_MEMORY_SNAPSHOT: true,
  AGENT_TRIGGERS: true,
  AGENT_TRIGGERS_REMOTE: true,
  ALLOW_TEST_VERSIONS: true,
  ANTI_DISTILLATION_CC: true,
  AUTO_THEME: true,
  AWAY_SUMMARY: true,
  BASH_CLASSIFIER: true,
  BG_SESSIONS: true,
  BREAK_CACHE_COMMAND: true,
  BRIDGE_MODE: true,
  BUDDY: true,
  BUILDING_CLAUDE_APPS: true,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  BYOC_ENVIRONMENT_RUNNER: true,
  CACHED_MICROCOMPACT: true,
  CCR_AUTO_CONNECT: true,
  CCR_MIRROR: true,
  CCR_REMOTE_SETUP: true,
  CHICAGO_MCP: true,
  COMMIT_ATTRIBUTION: true,
  COMPACTION_REMINDERS: true,
  CONNECTOR_TEXT: true,
  CONTEXT_COLLAPSE: true,
  COORDINATOR_MODE: true,
  COWORKER_TYPE_TELEMETRY: true,
  DAEMON: true,
  DIRECT_CONNECT: true,
  DOWNLOAD_USER_SETTINGS: true,
  DUMP_SYSTEM_PROMPT: true,
  ENHANCED_TELEMETRY_BETA: true,
  EXPERIMENTAL_SKILL_SEARCH: true,
  EXTRACT_MEMORIES: true,
  FILE_PERSISTENCE: true,
  FORK_SUBAGENT: true,
  HARD_FAIL: true,
  HISTORY_PICKER: true,
  HISTORY_SNIP: true,
  HOOK_PROMPTS: true,
  IS_LIBC_GLIBC: true,
  IS_LIBC_MUSL: true,
  KAIROS: true,
  KAIROS_BRIEF: true,
  KAIROS_CHANNELS: true,
  KAIROS_DREAM: true,
  KAIROS_GITHUB_WEBHOOKS: true,
  KAIROS_PUSH_NOTIFICATION: true,
  LODESTONE: true,
  MCP_RICH_OUTPUT: true,
  MCP_SKILLS: true,
  MEMORY_SHAPE_TELEMETRY: true,
  MESSAGE_ACTIONS: true,
  MONITOR_TOOL: true,
  NATIVE_CLIENT_ATTESTATION: true,
  NATIVE_CLIPBOARD_IMAGE: true,
  NEW_INIT: true,
  OVERFLOW_TEST_TOOL: true,
  PERFETTO_TRACING: true,
  POWERSHELL_AUTO_MODE: true,
  PROACTIVE: true,
  PROMPT_CACHE_BREAK_DETECTION: true,
  QUICK_SEARCH: true,
  REACTIVE_COMPACT: true,
  REVIEW_ARTIFACT: true,
  RUN_SKILL_GENERATOR: true,
  SELF_HOSTED_RUNNER: true,
  SHOT_STATS: true,
  SKILL_IMPROVEMENT: true,
  SLOW_OPERATION_LOGGING: true,
  SSH_REMOTE: true,
  STREAMLINED_OUTPUT: true,
  TEAMMEM: true,
  TEMPLATES: true,
  TERMINAL_PANEL: true,
  TOKEN_BUDGET: true,
  TORCH: true,
  TRANSCRIPT_CLASSIFIER: true,
  TREE_SITTER_BASH: true,
  TREE_SITTER_BASH_SHADOW: true,
  UDS_INBOX: true,
  ULTRAPLAN: true,
  ULTRATHINK: true,
  UNATTENDED_RETRY: true,
  UPLOAD_USER_SETTINGS: true,
  VERIFICATION_AGENT: true,
  VOICE_MODE: true,
  WEB_BROWSER_TOOL: true,
  WORKFLOW_SCRIPTS: true,
}

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  define: {
    // MACRO constants inlined at build time
    'MACRO.VERSION': JSON.stringify('0.3.0-alpha'),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify(''),
    'MACRO.PACKAGE_URL': JSON.stringify(''),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    // Bun global
    'Bun.env.NODE_ENV': JSON.stringify('production'),
    'process.env.USER_TYPE': JSON.stringify('hone'),
  },
  external: [
    '*.node',
    'sharp',
    '@img/*',
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/vertex-sdk',
    '@anthropic-ai/foundry-sdk',
    'playwright',
    'playwright-core',
    'chromium-bidi',
  ],
  plugins: [
    {
      name: 'text-file-loader',
      setup(build) {
        // Load .md and .txt files as strings
        build.onLoad({ filter: /\.(md|txt)$/ }, async (args) => {
          const fs = await import('fs/promises')
          const contents = await fs.readFile(args.path, 'utf-8')
          return {
            contents: `export default ${JSON.stringify(contents)}`,
            loader: 'js',
          }
        })
        // Load .d.ts files as empty modules (they're type-only)
        build.onLoad({ filter: /\.d\.ts$/ }, () => ({
          contents: 'export {}',
          loader: 'js',
        }))
      },
    },
  ],
})

if (result.success) {
  // Add shebang to output
  const fs = await import('fs/promises')
  const outFile = result.outputs[0]!.path
  const content = await fs.readFile(outFile, 'utf-8')
  if (!content.startsWith('#!/')) {
    await fs.writeFile(outFile, `#!/usr/bin/env node\n${content}`)
  }
  await fs.chmod(outFile, 0o755)

  console.log('✓ Build succeeded')
  console.log(`  Output: ${result.outputs.map(o => o.path).join(', ')}`)
  const stat = await fs.stat(outFile)
  console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
} else {
  console.error('✗ Build failed')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
