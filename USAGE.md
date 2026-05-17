# Hone 使用文档 v0.2.1

## 目录

1. [快速开始](#1-快速开始)
2. [Hone CLI](#2-hone-cli)
3. [Hone Desktop](#3-hone-desktop)
4. [Hone Gateway](#4-hone-gateway)
5. [浏览器自动化](#5-浏览器自动化)
6. [VS Code 插件](#6-vs-code-插件)
7. [手机端访问](#7-手机端访问)
8. [技能系统](#8-技能系统)
9. [记忆系统](#9-记忆系统)
10. [安全说明](#10-安全说明)
11. [环境变量参考](#11-环境变量参考)
12. [文件与目录结构](#12-文件与目录结构)
13. [故障排除](#13-故障排除)

---

## 1. 快速开始

### 前置条件

- **Node.js** >= 18（运行 Gateway 和浏览器自动化）
- **Bun** >= 1.0（运行 CLI）
- **Playwright** Chromium（浏览器自动化，可选）

### 安装

```bash
# 1. 构建项目
cd hone
npm run build          # 构建 CLI（输出 dist/cli.js）
cd desktop && npm run build  # 构建桌面端

# 2. 安装浏览器引擎（可选）
npx playwright install chromium
```

### 三步上手

**第一步：设置 API Key**

```powershell
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "sk-your-key"
```

**第二步：启动桌面端**

直接双击运行桌面端应用（Tauri），Gateway 和 WebSocket 连接会自动启动。你不需要手动输入任何命令。

**第三步：开始对话**

在桌面端的「对话」标签页直接输入你想做的事情，比如"检查今天的日程"或"帮我去 GitHub 看看有没有新 PR"。

---

## 2. Hone CLI

CLI 是 Hone 的执行体。它负责实际的代码操作——读文件、写代码、运行命令。

### 基本用法

```bash
# 交互模式（打开一个对话 session）
hone

# 单次提问模式
hone -p "这段代码有什么问题？"

# God Mode（跳过所有权限确认，默认开启）
# 环境变量 HONE_GOD_MODE=1 自动生效
```

### 常用斜杠命令

在交互模式中输入 `/` 查看所有命令：

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/commit` | 创建 git commit |
| `/review` | 代码审查 |
| `/clear` | 清空对话 |
| `/compact` | 压缩上下文 |
| `/doctor` | 诊断环境问题 |
| `/memory` | 查看已保存的记忆 |
| `/skills` | 管理技能 |
| `/status` | 查看当前状态 |
| `/cost` | 查看 token 消耗 |
| `/gateway` | Gateway 管理（start/stop/status） |
| `/canvas` | 打开 Canvas 可视化 |
| `/init` | 初始化项目配置（HONE.md） |

### 入口脚本

项目根目录提供了两个入口脚本，可以直接使用：

**Windows (PowerShell):**
```powershell
.\hone.ps1 -p "你好"
```

**Linux/macOS (Bash):**
```bash
./hone.sh -p "你好"
```

脚本会自动：
- 启用 God Mode（`HONE_GOD_MODE=1`）
- 清除 Anthropic 残留环境变量
- 找到 Bun 和 cli.js 的路径

---

## 3. Hone Desktop

桌面端是基于 Tauri v2 的全功能控制台。**打开即用，无需手动启动任何东西。**

### 启动行为

打开桌面端后自动完成：
1. Gateway daemon 在后台启动
2. WebSocket 连接到 Cloudflare Relay
3. 所有标签页就绪

### 六个标签页

| 标签页 | 功能 |
|--------|------|
| **仪表盘** | 机器列表、会话状态、活动时间线、token 统计 |
| **对话** | 与 Hone Gateway 24/7 对话，派发任务 |
| **日程管理** | 创建/编辑/删除定时任务，查看 AI 建议 |
| **可视化** | Canvas 实时预览 AI 生成的图表和 HTML |
| **网页任务** | 自然语言驱动浏览器自动化 |
| **设置** | 提供方/网关/数据/技能/MCP/外观/浏览器 |

### 对话标签页

- 直接输入文字与 Gateway 对话
- 快捷按钮：⚡派发到 CLI / 📊查看状态 / 📅查看日程 / 🎨打开画布
- Gateway 会自动判断你的意图：简单回复、派发 CLI 执行、创建日程、或打开浏览器操作
- 电源按钮只在需要停止/重启时才用，正常情况下不需要碰

### 网页任务标签页

- 直接说你想做什么，比如：
  - "帮我去 httpbin.org 填表并提交"
  - "打开百度搜索 AI 新闻"
  - "登录 GitHub 查看我的通知"
- Gateway LLM 自动识别你这是浏览器任务，调用 Playwright 执行
- 不需要手动填 URL、选风险级别——AI 自己判断
- WebSocket 连接断开后自动重连（指数退避：2s→4s→8s→...→30s，最多 10 次）
- 若 Gateway 离线，会显示清晰的黄色警告，不会假装执行任务

### 设置

所有设置自动保存（600ms 防抖），不需要手动点保存按钮。

关键设置项：
- **提供方**: DeepSeek / OpenAI / 自定义
- **API Key**: 支持显示/隐藏切换
- **开机自启**: 系统启动时自动运行 Gateway（默认开启）
- **浏览器代理**: 启用后 Gateway 可执行网页自动化任务
- **GUI 模型 URL**: 视觉模型端点（留空则使用 DOM 降级模式，仍可完成文本密集型任务）

---

## 4. Hone Gateway

Gateway 是 24/7 运行的后台进程，负责日程调度、任务分发、设备配对。

### 启动方式

**方式一：桌面端自动启动（推荐）**

打开桌面端 → Gateway 自动启动，不需要任何手动操作。

**方式二：CLI 启动**

```bash
hone gateway start    # 启动 Gateway
hone gateway status   # 查看状态
hone gateway stop     # 停止 Gateway
hone gateway approve <clientId>  # 批准设备配对
```

### 日程调度

Gateway 支持三种触发方式：

```
# Cron 表达式
"0 9 * * 1-5"  → 每个工作日早上 9 点

# 间隔
{ type: "interval", ms: 3600000 }  → 每小时

# 一次性
{ type: "one-time", at: 1718000000000 }  → 指定时间
```

**网页任务前缀 `web:`**

在日程的 task 字段中使用 `web:` 前缀，Gateway 会自动路由给浏览器代理：

```
web:登录看板并截图发给我
web:每天早上检查 GitHub 通知
```

### 自主学习

Gateway 每 6 小时分析 `~/.hone/logs/` 中的行为日志，检测：
- 你每天几点开始工作
- 你每周几做部署
- 你常用的项目目录

积累足够数据后，Gateway 会在对话中主动建议日程：
> "Hone 注意到你通常在 10:00 开始工作。要不要我每天早上 9:45 帮你检查 PR？"

### 设备配对

1. 手机浏览器打开 Relay 客户端页面
2. 输入配对码
3. Desktop 端自动批准（God Mode）或手动 `hone gateway approve <id>`

---

## 5. 浏览器自动化

### 架构

```
用户输入自然语言
     │
     ▼
Gateway LLM 识别浏览器意图
     │
     ▼
BrowserAgent 执行循环（最多 N 步）:
  ┌─ 截图 ──→ GUI 视觉模型（可选）
  │   或
  │   DOM 提取 → gatewayLLM（降级模式）
  ├─ 解析动作 JSON
  ├─ Playwright 执行
  └─ 循环直到 done/fail/timeout
```

### 两种模式

| 模式 | 需要 | 能力 |
|------|------|------|
| **视觉模式** | GUI vision 模型 API | 完整视觉理解，点击图标、识别图片 |
| **DOM 降级模式** | 无额外依赖 | 填表单、点按钮、读文字（文本密集型任务） |

**降级模式已足够完成大部分日常任务**——填表、搜索、提取信息、点击链接等。视觉模式需要额外部署 vision 模型（如 UI-TARS）。

### 使用方式

**桌面端**：打开「网页任务」标签页，直接说你想做什么。

**对话**：在「对话」标签页说"帮我去 xx 网站做 xx"，Gateway 会自动识别。

**定时任务**：创建日程，task 字段加上 `web:` 前缀。

### 安全机制

| 层级 | 机制 |
|------|------|
| 凭证加密 | DPAPI (Windows) / Keychain (macOS) / libsecret (Linux) / AES-256-CBC |
| 高风险操作 | 需要通过 relay 确认，60 秒超时自动拒绝 |
| 审计日志 | 所有网页操作记录到 `~/.hone/logs/YYYY-MM-DD.json` |

### 启用配置

在桌面端「设置 → 浏览器」中：

1. 开启「启用浏览器代理」
2. 可选：填入 GUI 模型 URL（不填则使用 DOM 降级模式）
3. 可选：关闭「无头模式」以观察浏览器操作过程
4. 可选：调整「最大步数」（默认 15）

或通过环境变量：
```bash
HONE_BROWSER_ENABLED=true
HONE_GUI_MODEL_URL=http://localhost:8000/v1/chat/completions  # 可选
HONE_BROWSER_HEADLESS=false  # 可选，显示浏览器窗口
HONE_BROWSER_MAX_STEPS=20    # 可选
```

### 限制

- Bun 在 Windows 上与 Playwright 不兼容，测试时需用 Node.js
- 首次启动 Chromium 时 Windows Defender 会扫描，可能较慢
- 国内网络环境访问被墙网站需要代理

---

## 6. VS Code 插件

### 安装

```bash
cd vscode-extension
# 复制到 VS Code 扩展目录，或使用 vsce package 打包
```

### 功能

| 操作 | 快捷键 | 说明 |
|------|--------|------|
| 解释代码 | `Ctrl+Alt+E` | 选中代码，Hone 解释含义 |
| 优化建议 | `Ctrl+Alt+O` | 选中代码，给出优化方案 |
| 代码审查 | `Ctrl+Alt+R` | 选中代码，检查安全/bug/性能 |
| 自定义提问 | 右键菜单 | 对选中代码提任意问题 |

所有操作也可以在右键菜单中找到。

### 设置

在 VS Code 设置中可配置：
- `hone.cliPath`: CLI 路径（默认 `hone`，可设为 `node /path/to/dist/cli.js`）

### 侧边栏

左侧活动栏的 Hone 图标 → 打开侧边栏对话面板，可直接输入问题。

---

## 7. 手机端访问

### 方式一：Relay 客户端页面

1. 确保 Gateway 在运行（桌面端打开即自动运行）
2. 手机浏览器打开 `https://hone-relay.marsailleippi79.workers.dev/client`
3. 输入配对码（God Mode 下自动批准）
4. 连接后即可发送消息给 Gateway

### 方式二：本地测试

```bash
# PC 浏览器直接打开
file:///E:/ai-work/claude-code-main/relay/client.html
```

### 能做什么

- 发送消息给 Gateway（自然语言）
- Gateway 会理解意图并执行：回复、派发 CLI、创建日程、启动浏览器操作
- 查看日程列表和管理日程

---

## 8. 技能系统

技能是可复用的专项能力模块，遵循 agentskills.io 开放格式。

### 使用技能

在 CLI 中输入 `/技能名` 即可调用：
```
/deploy-app
/review-code
```

### 创建技能

AI 会在复杂任务完成后自动建议提取技能。你也可以在桌面端「设置 → 技能」中手动创建。

技能格式（存储在 `~/.hone/skills/*.md`）：
```markdown
---
name: deploy-app
source: user-created
created: 2026-05-16T00:00:00.000Z
---

# deploy-app

## 描述
自动化部署应用到生产环境

## 触发条件
当用户提到部署、发布、上线相关任务时

## 步骤
1. 运行测试套件确认全部通过
2. 检查 git 状态确保在 main 分支
3. 构建生产版本
4. 推送到部署目标
```

---

## 9. 记忆系统

AI 会在对话中自动保存值得记住的信息到 `~/.hone/memory/`。

### 记忆类型

| 类型 | 内容 |
|------|------|
| `user` | 用户角色、偏好、知识水平 |
| `project` | 项目背景、目标、约束 |
| `feedback` | 用户纠正的方法、偏好的做法 |
| `reference` | 外部系统索引（Bug 追踪、监控面板等） |

### 查看记忆

```bash
# CLI 中
/memory

# 或直接在文件系统查看
ls ~/.hone/memory/
cat ~/.hone/memory/MEMORY.md
```

---

## 10. 安全说明

### 凭证存储

浏览器自动化的网站密码使用操作系统级加密：
- **Windows**: DPAPI（通过 PowerShell 调用 .NET ProtectedData）
- **macOS**: Keychain（通过 `security` CLI）
- **Linux**: libsecret（通过 `secret-tool` CLI，密码通过 stdin 管道传递，不暴露在命令行参数中）
- **降级**: AES-256-CBC（hostname 派生密钥）

### 命令执行

所有子进程调用均使用 `spawnSync` / `execFile`（参数数组传递），不使用 shell 字符串拼接，避免命令注入。

### 审计日志

所有网页操作记录到 `~/.hone/logs/YYYY-MM-DD.json`，包含时间戳、操作类型和详情。

### 网络通信

- Gateway ↔ Relay: WebSocket 加密连接
- 桌面端 ↔ Relay: WebSocket 加密连接
- 不存储任何用户凭证明文

---

## 11. 环境变量参考

### 核心

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key | — |
| `HONE_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `HONE_GOD_MODE` | 跳过权限弹窗 | `1`（启用） |
| `HONE_DATA_DIR` | 数据存储目录 | `~/.hone` |

### Gateway

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HONE_RELAY_URL` | Relay WebSocket 地址 | `wss://hone-relay.marsailleippi79.workers.dev/connect/default` |
| `HONE_CURRENT_REPO` | 当前仓库路径 | — |
| `HONE_CURRENT_BRANCH` | 当前分支 | — |

### 浏览器

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HONE_BROWSER_ENABLED` | 启用浏览器代理 | `false` |
| `HONE_GUI_MODEL_URL` | GUI 视觉模型 API | — |
| `HONE_GUI_MODEL_NAME` | 模型名称 | `ui-tars-7b` |
| `HONE_BROWSER_HEADLESS` | 无头模式 | `true` |
| `HONE_BROWSER_MAX_STEPS` | 最大操作步数 | `15` |
| `HONE_BROWSER_SCREENSHOT_QUALITY` | 截图质量 (1-100) | `75` |
| `HONE_BROWSER_TIMEOUT` | 操作超时 (ms) | `30000` |

---

## 12. 文件与目录结构

```
项目代码:
├── src/                          # CLI 源码
│   ├── daemon/                   # Gateway daemon
│   │   ├── gateway.ts            #   Gateway 核心
│   │   ├── scheduler.ts          #   日程调度器
│   │   ├── tools.ts              #   L1 工具定义
│   │   ├── llm.ts                #   意图分类
│   │   ├── pattern-learner.ts    #   行为模式学习
│   │   └── browser/              #   浏览器自动化
│   │       ├── agent.ts          #     核心 agent 循环
│   │       ├── playwright-runner.ts  #  Playwright 生命周期
│   │       ├── gui-model.ts      #     GUI 视觉模型调用
│   │       ├── dom-fallback.ts   #     DOM 降级模式
│   │       ├── credentials.ts    #     凭证管理
│   │       └── os-credentials.ts #     OS 级加密
│   ├── memory/                   # 记忆系统
│   ├── skills/                   # 技能系统
│   ├── services/providers/       # AI 提供方抽象
│   └── canvas/                   # Canvas 可视化
├── desktop/                      # 桌面端 (Tauri)
│   ├── src/                      #   React 前端
│   └── src-tauri/                #   Rust 后端
├── relay/                        # Cloudflare Relay
│   ├── worker.js                 #   CF Worker
│   ├── client.html               #   手机端页面
│   └── wrangler.toml             #   CF 配置
├── vscode-extension/             # VS Code 插件
├── hone.ps1 / hone.sh            # 入口脚本
└── HONE_EVOLUTION.md             # 项目进化蓝图

用户数据 (~/.hone/):
├── browser/                      # 浏览器 profile 和状态
│   └── profiles/default/state.json
├── memory/                       # AI 记忆
│   └── MEMORY.md
├── skills/                       # 技能定义
├── logs/                         # 审计日志
│   └── YYYY-MM-DD.json
├── schedules.json                # 日程持久化
├── canvas/                       # Canvas 输出
├── credentials.json              # 加密凭证
└── gateway.pid                   # Gateway 进程 PID
```

---

## 13. 故障排除

### Gateway 相关

**Q: 桌面端打开后对话标签页显示"离线"？**

检查：
1. 确认 Bun 和 Node.js 都已安装
2. 检查 Relay URL 是否正确（设置 → 网关 → 中继 URL）
3. 网络是否能访问 `hone-relay.marsailleippi79.workers.dev`

**Q: Gateway 日志在哪里看？**

桌面端对话标签页即为实时日志。也可以启动 CLI 的 verbose 模式，或查看 `~/.hone/logs/`。

### 浏览器自动化

**Q: "浏览器代理未启用"？**

在桌面端「设置 → 浏览器」中开启，或设置环境变量 `HONE_BROWSER_ENABLED=true`。

**Q: Playwright 启动超时？**

1. 确认已安装 Chromium：`npx playwright install chromium`
2. Windows Defender 首次扫描较慢，第二次会快很多
3. 测试时使用 Node.js 而非 Bun：`node src/daemon/browser/smoke-test.mjs`

**Q: 网站打不开？**

国内网络环境部分网站不可访问。使用代理或在任务中指定可访问的网站。

### VS Code 插件

**Q: 右键菜单没有 Hone 选项？**

确认插件已正确安装。检查 VS Code 扩展面板中 Hone 是否在列表中。

**Q: 点击命令后无反应？**

检查 `hone.cliPath` 设置是否正确。默认使用 `hone` 命令，如果未全局安装，改为 `node /absolute/path/to/dist/cli.js`。

### 常见错误

**`Cannot find module 'playwright'`**
```bash
npm install playwright
npx playwright install chromium
```

**`hone: command not found`**
入口脚本在项目根目录，使用 `./hone.ps1` 或完整路径运行。

**cargo build 失败**
确保安装了 Rust 工具链和 Tauri 依赖（Windows 需要 Microsoft Visual C++ Build Tools）。
