# Hone (磨石)

全功能 AI 编程助手 —— 终端 CLI + 桌面控制台 + 24/7 网关 + 手机端。原名 Claude Code，现已完全重新品牌化。

> **状态：v0.3.0-alpha** —— 开发中，正在测试。欢迎一起测试和优化，问题请提 issue。

## 这是什么

Hone 由四部分组成：

| 组件 | 说明 |
|------|------|
| **CLI** (`src/`, 构建为 `dist/cli.js`) | 终端 AI 编程助手，负责实际的读写文件、运行命令 |
| **Desktop** (`desktop/`) | Tauri 桌面控制台：对话、工作台、盯盘、日程、可视化、设置 |
| **Gateway** (`src/daemon/`) | 24/7 后台进程：意图分发、日程调度、设备配对 |
| **Relay** (`relay/`) | Cloudflare Worker 中继，桥接桌面端 / 网关 / 手机端 |

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org) | **>= 22.5** | 运行时（依赖内置 `node:sqlite`，低版本无法启动） |
| [Bun](https://bun.sh) | >= 1.3.5 | 依赖安装 + 构建打包 |
| [Rust](https://rustup.rs) + Tauri 依赖 | 最新稳定版 | 仅构建桌面端时需要（Windows 需 MSVC Build Tools） |

## 快速开始

### 构建 CLI

```bash
bun install        # 安装依赖（postinstall 会自动生成存根）
bun run build      # 构建，输出 dist/cli.js (~21MB)
node dist/cli.js   # 运行交互模式
```

### 构建桌面端

```bash
cd desktop
npm install
npm run tauri build   # 输出 NSIS 安装包到 src-tauri/target/release/bundle/nsis/
```

桌面安装包内置了 CLI 和 Node 运行时，装好即可用，无需单独装 Node。

### 配置 API Key

CLI 侧通过环境变量配置（详见 [USAGE.md](USAGE.md)）：

```powershell
# Windows PowerShell
setx DEEPSEEK_API_KEY "sk-your-key"
```

桌面端在「设置」页直接填写即可，会自动持久化。

完整用法见 **[USAGE.md](USAGE.md)**。

## 目录结构

```
.
├── src/                  # CLI / Gateway 源码
│   ├── entrypoints/cli.tsx  # 构建入口
│   ├── daemon/              # Gateway daemon（网关、调度、浏览器自动化）
│   ├── components/          # 终端 UI 组件
│   └── tools/               # 工具实现（Bash, Edit, Read 等）
├── desktop/              # 桌面应用（Tauri + React）
├── relay/                # Cloudflare Relay（worker.js）
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

## 参与测试

正在 alpha 阶段，欢迎反馈。发现 bug 或有改进建议请提 issue / PR。详细功能和故障排除见 [USAGE.md](USAGE.md)。
