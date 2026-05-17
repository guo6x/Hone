# FORGE — 个人 AI 编程助理进化蓝图 v2

## 0. 竞争格局与抄作业指南

### 0.1 赛道概览

| 项目 | 星标 | 语言 | 定位 | 抄什么 |
|------|------|------|------|--------|
| **OpenClaw** | 371k | TypeScript | 个人 AI 助理 | Gateway 单端口多路复用、Canvas 可视化、设备配对模型、多频道消息网关 |
| **Hermes Agent** | 145k | Python | 自进化 AI 代理 | 闭环学习(经验→技能)、自驱记忆管理、7种终端后端、Cron 调度、子代理并行 |
| **Trae** | - | - | 全栈 AI IDE | 生态整合策略(IDE+模型+社区)、Builder 自主模式 |
| **Claude Code** | - | TypeScript | 终端 AI 编程 | 远程控制桥接、REPL 桥、语音模式、Buddy 伙伴系统、定时后台代理 |

### 0.2 Claude Code 已有的远程/移动能力（我们代码里就有）

**重要发现：当前代码库已经包含完整的远程控制系统，只是被功能开关限制了。这些不需要抄，只需要激活和改造！**

| 功能 | 开关 | 状态 | 说明 |
|------|------|------|------|
| 远程控制桥接 (Bridge) | `BRIDGE_MODE` | ✅已编译 | `claude remote-control` — 将本地机器注册为远程环境，支持 Web/手机远程操控 |
| REPL 桥接 | `BRIDGE_MODE` | ✅已编译 | 活动 CLI 会话实时连接到 claude.ai 或手机 App |
| 自动连接 | `CCR_AUTO_CONNECT` | ✅已编译 | 所有会话自动注册到远程系统 |
| 镜像模式 | `CCR_MIRROR` | ✅已编译 | 本地会话自动生成远程镜像 |
| 推送通知 | `KAIROS_PUSH_NOTIFICATION` | ✅已编译 | 向移动设备推送通知 |
| 后台守护 | `DAEMON` | ✅已编译 | 长驻后台，管理后台会话 |
| 直接连接 | `DIRECT_CONNECT` | ✅已编译 | 设备直连 |
| SSH 远程 | `SSH_REMOTE` | ✅已编译 | 基于 SSH 的远程访问 |
| 语音模式 | `VOICE_MODE` | ✅已编译 | 本地麦克风语音输入 |
| 定时远程代理 | `AGENT_TRIGGERS_REMOTE` | ✅已编译 | 创建/管理定时任务，在云端执行 |
| Buddy 伙伴 | `BUDDY` | ✅已编译 | 终端像素宠物，有动画和交互 |
| 移动 App 二维码 | - | ✅已编译 | `/mobile` 命令生成 iOS/Android 下载二维码 |
| 会话二维码 | - | ✅已编译 | `/session` 命令生成远程会话连接二维码 |

**关键架构问题：当前桥接系统依赖 Anthropic 云服务器中转 (`api.anthropic.com`)。改造需要自建中继或改为 P2P。**

### 0.3 从 OpenClaw 抄什么

| 功能 | 优先级 | 抄法 |
|------|--------|------|
| **Gateway 单端口多路复用** | 高 | WS RPC + HTTP API + OpenAI 兼容端点共用一个端口(18789)。比当前的多端口架构简洁得多 |
| **Canvas 可视化工作区** | 高 | 代理写 HTML/CSS/JS 到目录，WebView 自动刷新。比流式协议简单无数倍 |
| **设备配对模型** | 高 | 所有设备通过 WS 连接为 "node"(外设) 或 "client"(操作者)，公钥挑战签名 |
| **多代理路由** | 中 | 按频道/账号/对等方确定性路由到隔离的代理工作区 |
| **Voice Wake + Talk Mode** | 中 | 唤醒词检测 → 持续语音循环：听→转写→发送→播放 |
| **ClawHub 技能市场** | 中 | SKILL.md + 支持文件 + semver 版本化，社区发布 |

### 0.4 从 Hermes Agent 抄什么

| 功能 | 优先级 | 抄法 |
|------|--------|------|
| **闭环学习系统** | 最高 | 完成复杂任务后自主创建技能。技能在使用中自我改进。这是 Hermes 最核心的差异化 |
| **自驱记忆管理** | 高 | 代理主动检测值得持久化的知识，自己写 MEMORY.md，自己定期整理 |
| **7种终端后端** | 高 | 本地/Docker/SSH/Singularity/Modal/Daytona/Vercel Sandbox 统一抽象。Daytona/Modal 支持空闲休眠 |
| **Cron 作为一等公民** | 中 | 自然语言定时任务，代理直接调度，交付到任意消息平台 |
| **子代理委托** | 中 | 隔离的子代理并行工作，Python RPC 桥接降低上下文消耗 |

### 0.5 关于 Claude Design

**Claude Design 不是 UI 组件库！** 它是 Anthropic Labs 在 2026 年 4 月发布的 AI 设计工具，运行在 claude.ai/design。本质是 Figma/Canva 的 AI 替代品，不是给开发者用的前端框架。

**但我们可以在前端开发中这样用它：**
- 在 claude.ai/design 中描述 UI 需求 → Claude Design 生成设计稿
- 调整完善后导出 → 设计稿可直接交给 Claude Code/FORGE 来实现
- 这正好符合"你设计，我实现"的工作流

---

## 1. 产品定位（修订版）

**Forge** 不只是 CLI 编程工具。参考 OpenClaw/Hermes 的进化路径和 Claude Code 已有的远程能力，我们的路线是：

```
CLI 编程引擎 → +远程控制(手机访问) → +Canvas 可视化 → +消息网关 → +IDE 插件
```

不做"万能的 AI 助理"，但必须做到"随时随地都能写代码"——手机、平板、桌面，都是 Forge 的终端。

### 品牌命名：Forge

| 维度 | 说明 |
|------|------|
| **含义** | 锻造/铸造 — "Forge your code, anywhere" |
| **中文** | 熔炉 — "百炼成钢" |
| **简短** | 单音节，比 OpenClaw(3音节)/Hermes(2音节) 更简洁 |
| **延展** | forge-cli / forge-desktop / forge-canvas / forge-vscode |

---

## 2. 技术架构目标

### 2.1 当前架构（丑陋的中间层）
```
User → Forge CLI → Anthropic 格式请求 → deepseek.ts 翻译 → DeepSeek API
                                                        ↓
User ← Forge CLI ← Anthropic 格式响应 ← deepseek.ts 翻译 ←
```
远程控制还要经过 `api.anthropic.com` 中转——依赖 Anthropic 的云基础设施。

### 2.2 目标架构（Forge 原生）
```
┌─────────────────────────────────────────────────────────┐
│                    Forge Gateway                         │
│  localhost:18789 (WS + HTTP + OpenAI API 单端口)        │
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ CLI App  │  │ Desktop  │  │ Mobile/Web Client    │  │
│  │ (Ink)    │  │ (Tauri)  │  │ (connect via WS)     │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│                      │                                  │
│              ┌───────┴────────┐                         │
│              │ Forge Core     │                         │
│              │ DeepSeek 原生  │                         │
│              │ 无格式翻译层   │                         │
│              └────────────────┘                         │
├─────────────────────────────────────────────────────────┤
│  Nodes (外设/执行环境)                                   │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ Canvas  │  │ SSH Host │  │ Docker/Sandbox       │   │
│  │ WebView │  │ 远程执行 │  │ 隔离执行             │   │
│  └─────────┘  └──────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**关键设计原则（从 OpenClaw 抄来）：**
- **Gateway 是大脑，Nodes 是手脚** — 模型在 Gateway 跑，命令在 Node 执行
- **单端口多路复用** — WS 实时通信 + HTTP REST + OpenAI API 都在同一个端口
- **设备配对 + 能力声明** — 新设备连接需审批，Node 声明自己能做什么

---

## 3. Phase 1: 点火重塑（当前阶段）

### 任务 0: 品牌重命名
```
优先级: 立即
策略: 分层替换，不是全局 sed
```

| 层 | 内容 | 操作 |
|----|------|------|
| CLI 输出 | "Claude Code" → "Forge" | 替换 prompts.ts 中的品牌字符串 |
| 文件查找 | CLAUDE.md → FORGE.md | 兼容降级读取 CLAUDE.md |
| 入口脚本 | claude-local.ps1 → forge.ps1 | 新建 |
| 环境变量 | CLAUDE_LOCAL_* → FORGE_* | 替换 |
| package.json | name/description | 改为 forge |
| API 协议层 | anthropicBody/anthropic 变量名 | **不改**（翻译层还有用） |

### 任务 1: God Mode 权限爆破
```
优先级: 立即
目标: 0 确认，全自动执行
```

- 注入 `FORGE_GOD_MODE` 环境变量
- 绕过 `src/utils/permissions/` 下所有确认逻辑
- 所有工具 `isEnabled()` 返回 true
- 保留权限日志备查

### 任务 2: 远程控制系统激活
```
优先级: 高
目标: 让手机/网页能操控本地 Forge
```

**当前状态：代码完善，但依赖 Anthropic 服务器中转**

具体步骤：
1. 分析 `src/bridge/` 的完整协议 — 理解 CLI ↔ 云端 ↔ 客户端的消息格式
2. 自建中继服务器（最小可行：WebSocket relay + 会话管理）
3. 替换 `SessionsWebSocket.ts` 中的 `wss://api.anthropic.com` → 自建中继地址
4. 验证 `/mobile` 二维码生成 → 改为自己的 App 下载链接
5. 验证 `/session` 远程会话二维码 → 连接到自建中继
6. 测试：手机浏览器 → 扫描二维码 → 操控本地 Forge

**抄 OpenClaw 的要点：**
- 设备配对审批流（`openclaw devices approve <requestId>`）
- 公钥挑战签名保证安全
- Capability 声明模型（Node 告诉 Gateway 自己能做什么）

### 任务 3: DeepSeek 原生化
```
优先级: 高
目标: 移除 Anthropic 中间翻译层
```

1. 去掉 `src/utils/deepseek.ts` 的格式翻译，直接调用 DeepSeek API
2. reasoning_content 全链路原生利用：规划→执行→反思
3. 系统提示词从 Anthropic 格式重写为通用格式
4. 支持 DeepSeek 系列模型一键切换

### 任务 4: Canvas 可视化工作区
```
优先级: 中
目标: 代理可写 HTML/CSS/JS，WebView 实时渲染
```

抄 OpenClaw 的方案（极简且有效）：
1. 创建一个 Canvas 目录 `~/.forge/canvas/<session>/`
2. 代理通过 Write 工具写 HTML/CSS/JS 文件到该目录
3. WebView/浏览器自动监听文件变化并刷新
4. 后续可用于：项目仪表盘、架构图、测试报告可视化

### 任务 5: 闭环学习系统
```
优先级: 中（依赖 Phase 1 稳定后）
目标: 从经验中自动创建技能
```

抄 Hermes Agent 的方案：
1. 复杂任务完成后，代理自动提取工作流 → 创建 SKILL.md
2. 技能在使用中自我改进（记录成功率、优化步骤）
3. 自驱记忆管理：代理主动写 MEMORY.md，定期整理老旧记忆

---

## 4. 里程碑

### M1: 品牌独立 + God Mode (本周)
- [x] DeepSeek 功能跑通
- [ ] 重命名所有用户可见引用
- [ ] God Mode 权限爆破
- [ ] 构建产物稳定运行

### M2: 远程可用 (下周)
- [ ] 自建中继服务器
- [ ] 替换 Anthropic 中继地址
- [ ] 手机浏览器操控本地 Forge
- [ ] 设备配对审批流

### M3: DeepSeek 原生 + Canvas (两周内)
- [ ] 移除 Anthropic 格式翻译层
- [ ] reasoning_content 全链路利用
- [ ] Canvas 可视化 MVP
- [ ] 系统提示词重写

### M4: 学习系统 + IDE 插件 (一个月内)
- [ ] 闭环学习系统 MVP
- [ ] VS Code 插件基础版
- [ ] 终端后端抽象层

---

## 5. 去 Anthropic 化清单

| 组件 | 当前 | 目标 |
|------|------|------|
| API 客户端 | 拦截 `/messages` 转发 DeepSeek | DeepSeek SDK 直连 |
| 系统提示词 | Anthropic 格式 + 品牌 | Forge 品牌 + 通用格式 |
| OAuth 登录 | Anthropic Console | 移除，仅 API Key / 自建 |
| Grove/Bootstrap | Anthropic 服务 | 已 bypass，彻底删除 |
| 远程中继 | `api.anthropic.com` | 自建 WebSocket 中继 |
| 更新检查 | Anthropic 更新服务器 | 自建或移除 |
| 遥测分析 | Anthropic analytics | 移除 |

---

## 6. 开发纪律

1. **先抄后改** — OpenClaw/Hermes 验证过的方案直接拿来用，不要重新发明
2. **能做就做** — 远程控制、手机连接这些功能用户需要，不能因为"不想竞争"就砍掉
3. **一次只改一个模块** — 改完编译运行验证，再改下一个
4. **git 管理所有变更** — feature branch per milestone

---

**灵感来源：**
- OpenClaw: Gateway 架构、Canvas、设备配对、Voice Wake
- Hermes Agent: 闭环学习、自驱记忆、终端后端抽象、Cron
- Trae: 生态整合策略（IDE + 模型 + 社区）
- Claude Code 逆向: 远程控制桥接、Buddy、REPL 桥

**当前状态：** Phase 1 功能跑通 ✅ | 等待用户确认后开始 M1 执行
