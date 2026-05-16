import { readFileSync, writeFileSync, existsSync } from 'fs';

function repairFile(filePath: string, replacements: Record<number, string>, append?: string, truncateToLine?: number) {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, 'utf8');
    let lines = content.split('\n');
    if (truncateToLine) {
        lines = lines.slice(0, truncateToLine);
    }
    for (const [lineNum, replacement] of Object.entries(replacements)) {
        lines[parseInt(lineNum) - 1] = replacement;
    }
    let newContent = lines.join('\n');
    if (append) {
        newContent += append;
    }
    writeFileSync(filePath, newContent);
    console.log(`Repaired ${filePath}`);
}

// 1. query.ts
repairFile('src/query.ts', {
    241: 'async function* queryLoop(',
    242: '  params: QueryParams,',
    243: '  consumedCommandUuids: string[]',
    244: '): AsyncGenerator<',
    245: '  | StreamEvent',
    246: '  | RequestStartEvent',
    247: '  | Message',
    248: '  | TombstoneMessage',
    249: '  | ToolUseSummaryMessage,',
    250: '  Terminal',
    251: '> {',
    252: '', 253: '', 254: '', 255: '', 256: '', 257: '', 258: '', 259: '', 260: '', 261: ''
});

// 2. prompts.ts
repairFile('src/constants/prompts.ts', {
    66: 'const getCachedMCConfigForFRC = null;',
    67: '', 68: '', 69: '', 70: '',
    72: 'const BRIEF_PROACTIVE_SECTION = null;',
    73: '', 74: '', 75: '', 76: '', 77: '',
    78: 'const briefToolModule = null;',
    79: '', 80: '', 81: '',
    82: 'const DISCOVER_SKILLS_TOOL_NAME = null;',
    83: '', 84: '', 85: '', 86: '', 87: '/**', 88: ' * Boundary marker separating static (cross-org cacheable) content from dynamic content.', 89: ' * Everything BEFORE this marker in the system prompt array can use scope: \'global\'.', 90: ' * Everything AFTER contains user/session-specific content and should not be cached.', 91: ' *', 92: ' * WARNING: Do not remove or reorder this marker without updating cache logic in:',
    93: ' * - src/utils/api.ts (splitSysPromptPrefix)',
    94: ' * - src/services/api/claude.ts (buildSystemPromptBlocks)',
    95: ' */',
    96: 'const skillSearchFeatureCheck = false;',
    97: "export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = Symbol('SYSTEM_PROMPT_DYNAMIC_BOUNDARY');"
});

// 3. slowOperations.ts
repairFile('src/utils/slowOperations.ts', {
    117: '        logForDebugging(`[SLOW OPERATION DETECTED] ${description} (${duration.toFixed(1)}ms)`);'
});

// 4. sessionStorage.ts
repairFile('src/utils/sessionStorage.ts', {
    4892: "          result = result.slice(0, 200).trim() + '...';"
});

// 5. Message.tsx
repairFile('src/components/Message.tsx', {
    250: 'const { isDeferredTool } = { isDeferredTool: (null as any) };',
    251: 'const { isSnipBoundaryMessage } = { isSnipBoundaryMessage: (null as any) };',
    252: ''
});

// 6. Stats.tsx
repairFile('src/components/Stats.tsx', {
    1060: '    setStatus(\'copying...\');'
});

// 7. main.tsx
repairFile('src/main.tsx', {
    2543: '    // Initialize versioned plugins system (triggers V1->V2 migration if',
    3211: "          process.stderr.write('Connecting to ' + _pendingSSH.host + '...\\n');",
    3327: "      const infoMessage = createSystemMessage('Attached to assistant session ' + targetSessionId.slice(0, 8) + '...', 'info');",
    3435: "          process.stdout.write('Created remote session: ' + createdSession.title + '\\n');",
    3436: "          process.stdout.write('View: ' + getRemoteSessionUrl(createdSession.id) + '?m=0\\n');",
    3437: "          process.stdout.write('Resume with: claude --teleport ' + createdSession.id + '\\n');",
    3456: "          return await exitWithError(root, 'Error: ' + (errorMessage(error) || 'Failed to authenticate'), () => gracefulShutdown(1));",
    3467: "        const remoteSessionUrl = getRemoteSessionUrl(createdSession.id) + '?m=0';"
});

// 8. UserTextMessage.tsx
repairFile('src/components/messages/UserTextMessage.tsx', {
    97: '        t1 = { UserGitHubWebhookMessage: (null as any) };',
    194: '        t1 = { UserForkBoilerplateMessage: (null as any) };',
    218: '        t1 = { UserCrossSessionMessage: (null as any) };',
    242: '        t1 = { UserChannelMessage: (null as any) };'
});

// 9. worktree.ts
repairFile('src/utils/worktree.ts', {
    1384: '    console.log(\'iTerm2 > Settings > General > tmux > "Tabs in attaching window"\');',
    1386: '  }',
    1385: '', 1387: '', 1388: '', 1389: '', 1390: ''
}, undefined, 1516);

// 10. ResumeConversation.tsx
repairFile('src/screens/ResumeConversation.tsx', {
    302: '        <Text> Loading conversations...</Text>',
    308: '        <Text> Resuming conversation...</Text>'
});

// 11. REPL.tsx
repairFile('src/screens/REPL.tsx', {
    471: "const TITLE_ANIMATION_FRAMES = ['-', '\\\\', '|', '/'];",
    472: "const TITLE_STATIC_PREFIX = 'Claude Code';",
    4163: "      return total === 1 ? (customMessage + '...') : (customMessage + '...' + completedCount + '/' + total);",
    4299: "      setStatus('rendering ' + deferredMessages.length + ' messages...');",
    4310: "          const path = join(tmpdir(), 'cc-transcript-' + Date.now() + '.txt');",
    4315: "          setStatus('render failed: ' + (e instanceof Error ? e.message : String(e)));",
    4612: "                  ruleContent: 'domain:' + approvedHost"
});

// 12. CompanionSprite.tsx
repairFile('src/buddy/CompanionSprite.tsx', {
    116: '      t8 = <Text color={borderColor}>-</Text>;',
    135: '    t8 = <Box flexDirection="column" alignItems="flex-end" paddingRight={6}><Text color={borderColor}>|</Text><Text color={borderColor}>|</Text></Box>;',
    228: "    const quip = reaction && reaction.length > NARROW_QUIP_CAP ? reaction.slice(0, NARROW_QUIP_CAP - 1) + '...' : reaction;"
});

// 13. useDiffInIDE.ts
repairFile('src/hooks/useDiffInIDE.ts', {
    63: "    () => 'Claude Code ' + basename(filePath) + ' (' + sha + ')',",
    193: "        'Unexpected number of hunks: ' + patch.length + '. Expected 1 hunk.',"
});

// 14. PromptInput.tsx
repairFile('src/components/PromptInput/PromptInput.tsx', {
    2245: '          <Text dimColor>Waiting for permission...</Text>'
});

// 15. PromptInputFooterLeftSide.tsx
repairFile('src/components/PromptInput/PromptInputFooterLeftSide.tsx', {
    161: '      t1 = <Text dimColor={true} key="pasting-message">Pasting text...</Text>;',
    332: '  // baseline, primaryItemCount is <= 1 for most sessions; keep the threshold',
    451: '    parts.push(<Text dimColor key="manage-tasks">{tasksSelected ? <KeyboardShortcutHint shortcut="Enter" action="view tasks" /> : <KeyboardShortcutHint shortcut="->" action="manage" />}</Text>);'
});

// 16. usePromptInputPlaceholder.ts
repairFile('src/components/PromptInput/usePromptInputPlaceholder.ts', {
    43: "      return `Message @${displayName}...`"
});

// 17. VoiceIndicator.tsx
repairFile('src/components/PromptInput/VoiceIndicator.tsx', {
    49: '          t1 = <Text dimColor={true}>listening...</Text>;',
    100: '      t0 = <Text color="warning">Voice: processing...</Text>;',
    120: '    t1 = <Text color={color}>Voice: processing...</Text>;'
});

console.log('Syntax repair complete.');
