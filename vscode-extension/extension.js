/**
 * Hone VS Code Extension
 *
 * Features:
 * - Sidebar webview: chat with Hone, view dashboard
 * - Right-click menu: "Hone 解释" / "Hone 优化" / "Hone 审查"
 * - Selection send: send selected code to Hone for analysis
 * - Status bar: show Hone Gateway connection status
 */

const vscode = require('vscode');
const { exec, execFile } = require('child_process');

// ── Activation ──

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const channel = vscode.window.createOutputChannel('Hone');
  channel.appendLine('Hone VS Code 插件已激活');

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hone.explain', () => handleExplain(channel)),
    vscode.commands.registerCommand('hone.optimize', () => handleOptimize(channel)),
    vscode.commands.registerCommand('hone.review', () => handleReview(channel)),
    vscode.commands.registerCommand('hone.ask', () => handleAsk(channel)),
    vscode.commands.registerCommand('hone.openDashboard', () => handleOpenDashboard()),
    vscode.commands.registerCommand('hone.gatewayStatus', () => handleGatewayStatus(channel)),
  );

  // Register sidebar webview provider
  const provider = new SidebarProvider(context.extensionUri, channel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hone.sidebar', provider)
  );

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBarItem.command = 'hone.gatewayStatus';
  statusBarItem.text = '$(pulse) Hone';
  statusBarItem.tooltip = '检查 Hone Gateway 状态';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

// ── Command handlers ──

/**
 * Send selected code to Hone for explanation
 */
async function handleExplain(channel) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开一个文件');
    return;
  }

  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    vscode.window.showInformationMessage('请先选中要解释的代码');
    return;
  }

  const language = editor.document.languageId;
  const prompt = `解释以下 ${language} 代码:\n\`\`\`${language}\n${selection}\n\`\`\``;

  channel.appendLine('[Hone] 请求解释代码...');
  await sendToHone(prompt, channel);
}

/**
 * Send selected code to Hone for optimization suggestions
 */
async function handleOptimize(channel) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开一个文件');
    return;
  }

  const selection = editor.document.getText(editor.selection) || editor.document.getText();
  const language = editor.document.languageId;
  const prompt = `优化以下 ${language} 代码，提出具体改进建议:\n\`\`\`${language}\n${selection}\n\`\`\``;

  channel.appendLine('[Hone] 请求代码优化建议...');
  await sendToHone(prompt, channel);
}

/**
 * Send selected code to Hone for code review
 */
async function handleReview(channel) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开一个文件');
    return;
  }

  const selection = editor.document.getText(editor.selection) || editor.document.getText();
  const language = editor.document.languageId;
  const prompt = `审查以下 ${language} 代码，检查潜在的安全漏洞、bug 和性能问题:\n\`\`\`${language}\n${selection}\n\`\`\``;

  channel.appendLine('[Hone] 请求代码审查...');
  await sendToHone(prompt, channel);
}

/**
 * Ask Hone a custom question about the selected code
 */
async function handleAsk(channel) {
  const editor = vscode.window.activeTextEditor;
  const question = await vscode.window.showInputBox({
    prompt: '向 Hone 提问',
    placeHolder: '例如: 这段代码的时间复杂度是多少？',
  });

  if (!question) return;

  const selection = editor
    ? editor.document.getText(editor.selection) || editor.document.getText()
    : '';
  const language = editor?.document.languageId || 'text';

  const prompt = selection
    ? `${question}\n\n相关代码:\n\`\`\`${language}\n${selection}\n\`\`\``
    : question;

  channel.appendLine(`[Hone] 提问: ${question}`);
  await sendToHone(prompt, channel);
}

/**
 * Open Hone dashboard in external browser or side panel
 */
function handleOpenDashboard() {
  const panel = vscode.window.createWebviewPanel(
    'honeDashboard',
    'Hone Dashboard',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );
  panel.webview.html = getDashboardHTML();
}

/**
 * Check Gateway status
 */
function getHoneCli(): string {
  return vscode.workspace.getConfiguration('hone').get('cliPath', 'hone');
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function handleGatewayStatus(channel) {
  const cli = getHoneCli();
  const cwd = getWorkspaceRoot();
  execFile(cli, ['gateway', 'status'], { timeout: 5000, cwd }, (error, stdout, stderr) => {
    if (error) {
      vscode.window.showWarningMessage(`Hone Gateway 未运行。运行 ${cli} gateway start 启动。`);
    } else {
      const msg = stderr || stdout;
      vscode.window.showInformationMessage(msg.trim());
    }
    channel.appendLine(`[Hone] Gateway 状态: ${stderr || stdout || error?.message}`);
  });
}

// ── IPC: Send prompt to Hone CLI ──

/**
 * Send a prompt to Hone CLI and show result in output channel.
 */
async function sendToHone(prompt, channel) {
  const cli = getHoneCli();
  // Use execFile to avoid shell injection — prompt passed as argument
  const args = ['-p', prompt, '--god-mode'];

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Hone 思考中...',
      cancellable: false,
    },
    async () => {
      return new Promise((resolve) => {
        const cwd = getWorkspaceRoot();
        execFile(cli, args, { maxBuffer: 10 * 1024 * 1024, timeout: 120000, cwd }, (error, stdout, stderr) => {
          if (error && !stdout) {
            channel.appendLine(`[Hone] 错误: ${error.message}`);
            vscode.window.showErrorMessage(`Hone 执行失败: ${error.message}`);
            resolve();
            return;
          }

          const result = stdout.trim();
          channel.appendLine('[Hone] 结果:');
          channel.appendLine(result);
          channel.appendLine('---');

          // Show result in a new document
          vscode.workspace.openTextDocument({ content: result, language: 'markdown' })
            .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside));

          resolve();
        });
      });
    }
  );
}

// ── Sidebar Webview Provider ──

class SidebarProvider {
  /**
   * @param {vscode.Uri} extensionUri
   * @param {vscode.OutputChannel} channel
   */
  constructor(extensionUri, channel) {
    this.extensionUri = extensionUri;
    this.channel = channel;
  }

  /**
   * @param {vscode.WebviewView} webviewView
   * @param {vscode.WebviewViewResolveContext} _context
   * @param {vscode.CancellationToken} _token
   */
  resolveWebviewView(webviewView, _context, _token) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getSidebarHTML();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ask':
          this.channel.appendLine(`[Hone Sidebar] ${msg.text}`);
          sendToHone(msg.text, this.channel);
          break;
        case 'refresh':
          this.channel.appendLine('[Hone Sidebar] 刷新状态');
          break;
      }
    });
  }

  getSidebarHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-textLink-foreground);
    }
    textarea {
      width: 100%;
      height: 80px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      resize: vertical;
      font-family: inherit;
      font-size: 12px;
      margin-bottom: 8px;
    }
    textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    button {
      width: 100%;
      padding: 6px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .divider {
      border-top: 1px solid var(--vscode-widget-border);
      margin: 16px 0 12px;
    }
    .shortcut {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      line-height: 1.6;
    }
    .shortcut kbd {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <h3>Hone</h3>
  <textarea id="prompt" placeholder="向 Hone 提问..."></textarea>
  <button id="sendBtn">发送</button>
  <div class="divider"></div>
  <div class="shortcut">
    <kbd>Ctrl+Alt+E</kbd> 解释代码<br>
    <kbd>Ctrl+Alt+O</kbd> 优化建议<br>
    <kbd>Ctrl+Alt+R</kbd> 代码审查
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('sendBtn').addEventListener('click', () => {
      const text = document.getElementById('prompt').value.trim();
      if (text) {
        vscode.postMessage({ type: 'ask', text });
        document.getElementById('prompt').value = '';
      }
    });
    document.getElementById('prompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        document.getElementById('sendBtn').click();
      }
    });
  </script>
</body>
</html>`;
  }
}

// ── Dashboard HTML ──

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h2 {
      font-size: 18px;
      margin-bottom: 16px;
      color: var(--vscode-textLink-foreground);
    }
    .card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .dot.online { background: #4caf50; }
    .dot.offline { background: #9e9e9e; }
    .controls {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  </style>
</head>
<body>
  <h2>Hone Dashboard</h2>
  <div class="card">
    <div class="status-row">
      <div class="dot online" id="statusDot"></div>
      <strong id="statusText">检查中...</strong>
    </div>
    <p style="font-size: 12px; color: var(--vscode-descriptionForeground);" id="detailText">
      运行 hone gateway status 查看详情（可在设置中配置 hone.cliPath）
    </p>
  </div>
  <div class="controls">
    <button onclick="sendCmd('hone gateway start')">启动 Gateway</button>
    <button class="secondary" onclick="sendCmd('hone gateway stop')">停止 Gateway</button>
    <button class="secondary" onclick="location.reload()">刷新</button>
  </div>
  <pre id="output" style="margin-top: 16px; font-size: 11px; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; max-height: 300px; overflow-y: auto;"></pre>
  <script>
    const vscode = acquireVsCodeApi();
    function sendCmd(cmd) {
      document.getElementById('output').textContent = '执行中...';
      fetch('command:cmd?' + encodeURIComponent(cmd)).catch(() => {});
    }
    window.addEventListener('message', (e) => {
      if (e.data) {
        document.getElementById('output').textContent = e.data;
      }
    });
  </script>
</body>
</html>`;
}

// ── Deactivate ──

function deactivate() {}

module.exports = { activate, deactivate };
