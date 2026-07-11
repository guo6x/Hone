# Hone (磨石)

全功能 AI 编程助手 —— 终端 CLI + 桌面控制台 + 24/7 网关 + 手机端。原名 Claude Code，现已完全重新品牌化。

> **状态：v0.3.0-alpha** —— 开发中，正在测试。欢迎一起测试和优化，问题请提 issue。
>
> 📱 **在线展示**：[hone landing page](https://guo6x.github.io/Hone/) · 💾 **下载**：[GitHub Releases](https://github.com/guo6x/Hone/releases)

## 这是什么

Hone 由四部分组成：

| 组件 | 说明 |
|------|------|
| **CLI** (`src/`, 构建为 `dist/cli.js`) | 终端 AI 编程助手，负责实际的读写文件、运行命令 |
| **Desktop** (`desktop/`) | Tauri 桌面控制台：对话、工作台、盯盘、日程、可视化、设置 |
| **Gateway** (`src/daemon/`) | 24/7 后台进程：意图分发、日程调度、设备配对、成本/Token 预算 |
| **Relay** (`relay/`) | Cloudflare Worker 中继，桥接桌面端 / 网关 / 手机端 |

## 核心特性

### 🔐 安全优先
- **OS 凭据存储**：所有 API Key、Relay Token、配对码通过系统 keyring（Windows Credential Manager / macOS Keychain）保存，绝不写入明文 JSON
- **6 位一次性配对码**：手机端配对成功后立即清空，Relay 只存派生证明
- **设备撤销**：桌面端可随时踢掉已配对设备

### 📱 移动端配对
- 扫二维码 + 6 位配对码即可连接
- 手机端 PWA，浏览器打开即用，可"添加到主屏幕"
- 远程对话、查看任务进度、批准/拒绝危险操作、管理日程
- Gateway 离线自动重连（指数退避，上限 30s）

### 🖥️ 桌面控制台
- **系统托盘**：关闭窗口最小化到托盘，Gateway 后台常驻
- **开机自启**：可选的开机自动启动 + Gateway 自启
- **内置 PTY**：工作台集成真实终端，支持 xterm 交互
- **执行日志**：所有 CLI 任务执行记录可查

### ⚙️ 现代化设置页
- **多 Provider 卡片**：deepseek / openai / openrouter / custom，支持 `/models` 端点自动拉取模型列表
- **Agent Skills（2026 规范）**：`SKILL.md` + YAML frontmatter + Markdown 指令，支持扫描本地文件夹批量导入
- **MCP 三种传输**：stdio / sse / streamable-http，配置写入 `claude_desktop_config.json`
- **移动端配对面板**：二维码 + 配对码 + 一键重新生成
- 旧配置自动迁移，无需手动转换

### 🌐 Windows 系统代理透传
- 自动读取注册表系统代理，注入到 Gateway / CLI 子进程环境变量
- 用户配了系统代理就自动走，无需重复配置

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org) | **>= 22.5** | 运行时（依赖内置 `node:sqlite`，低版本无法启动） |
| [Bun](https://bun.sh) | >= 1.3.5 | 依赖安装 + 构建打包 |
| [Rust](https://rustup.rs) + Tauri 依赖 | 最新稳定版 | 仅构建桌面端时需要（Windows 需 MSVC Build Tools） |

## 快速开始

### 方式一：下载安装包（推荐普通用户）

到 [GitHub Releases](https://github.com/guo6x/Hone/releases) 下载最新的 `Hone_0.3.0-alpha_x64-setup.exe`，双击安装即可。安装包内置了 CLI 和 Node 运行时，装好即用，无需单独装 Node。

> 安装包是 user 权限（不触发 UAC），默认装到 `%LOCALAPPDATA%\Programs\Hone`，安装时可自行改到 D 盘。

### 方式二：从源码构建

#### 构建 CLI

```bash
bun install        # 安装依赖（postinstall 会自动生成存根）
bun run build      # 构建，输出 dist/cli.js (~21MB)
node dist/cli.js   # 运行交互模式
```

#### 构建桌面端

```bash
cd desktop
npm install
npm run tauri build   # 输出 NSIS 安装包到 src-tauri/target/release/bundle/nsis/
```

> 如果 Tauri 自动下载 NSIS 卡住，可用仓库内的 [installer.nsi](desktop/src-tauri/installer.nsi) 手动调用 `makensis.exe` 编译。

### 配置 API Key

CLI 侧通过环境变量配置（详见 [USAGE.md](USAGE.md)）：

```powershell
# Windows PowerShell
setx DEEPSEEK_API_KEY "sk-your-key"
```

桌面端在「设置 → 提供方」直接填写即可，会自动持久化到 OS 凭据存储。

完整用法见 **[USAGE.md](USAGE.md)**。

## 手机端使用

1. 桌面端打开「设置 → 移动端」，看到二维码和 6 位配对码
2. 手机浏览器扫二维码（或访问 Relay 地址 + 输入配对码）
3. 配对成功后即可在手机上：
   - 发消息给 Gateway 执行编程任务
   - 查看任务实时进度
   - 批准/拒绝危险操作（如网页自动化）
   - 创建/管理日程
   - "添加到主屏幕"当原生 App 用

> 手机端是 PWA，部署在 Cloudflare Worker 上，无需安装 App。

## 目录结构

```
.
├── src/                  # CLI / Gateway 源码
│   ├── entrypoints/cli.tsx  # 构建入口
│   ├── daemon/              # Gateway daemon（网关、调度、浏览器自动化）
│   ├── components/          # 终端 UI 组件
│   └── tools/               # 工具实现（Bash, Edit, Read 等）
├── desktop/              # 桌面应用（Tauri + React）
│   └── src/components/settings/  # 现代化设置组件（Provider/Skill/MCP/Mobile）
├── relay/                # Cloudflare Relay（worker.js + relay-room.js + client.html）
├── landing/              # 官网 landing page（GitHub Pages 部署）
├── docs/                 # 设计文档与实现计划
├── vscode-extension/     # VS Code 扩展
├── vendor/               # 原生模块加载层
├── scripts/              # 构建辅助脚本
└── build.ts              # Bun 构建脚本
```

## 构建说明

- `bun install` 的 `postinstall`（`scripts/postinstall.js`）会生成私有包存根并补丁 commander。重装依赖后存根丢失，再跑一次 `bun install` 即可。
- `build.ts` 用 Bun bundler 把 TypeScript 源码打成单文件 `dist/cli.js`。
- `vendor/` 是原生模块加载层，编译进产物，缺对应 `.node` 二进制时自动降级，不影响核心功能。

### 常见问题

- **构建报 `Could not resolve "xxx"`** —— 在 `build.ts` 的 `external` 数组加该包名，或在 `scripts/postinstall.js` 加存根。
- **桌面端构建失败** —— 确认 Rust 工具链和 Tauri 系统依赖已装齐。
- **桌面端窗口卡死/白屏** —— 确认 `index.html` 没有引用 Google Fonts（国内网络会阻塞 WebView2 渲染）。
- **NSIS 打包卡在 "Recreating it"** —— 用仓库内的 `installer.nsi` 手动调用 `makensis.exe` 编译。

## 参与测试

正在 alpha 阶段，欢迎反馈。发现 bug 或有改进建议请提 issue / PR。详细功能和故障排除见 [USAGE.md](USAGE.md)。
