# Hone (磨石)

全功能 AI 编程控制台，支持多种 AI 模型。原名 Claude Code，现已完全重新品牌化。

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 构建
bun run build

# 3. 运行
bun dist/cli.js
```

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| [Bun](https://bun.sh) | >= 1.3.5 | 依赖安装 + 构建打包 |
| [Node.js](https://nodejs.org) | >= 18 | 运行时 |

### 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

## 如何使用

### 认证

支持多种 AI 模型和认证方式：

```bash
# 环境变量方式
export ANTHROPIC_API_KEY="sk-ant-..."
# 或其他模型的环境变量

# OAuth 登录
bun dist/cli.js auth
```

## 构建原理

### `bun install` 做了什么

`postinstall` 脚本（`scripts/postinstall.js`）自动完成：

1. **创建私有包存根**：源码引用了 Anthropic 内部包，存根使构建通过并在运行时安全降级
2. **补丁 commander**：支持多字符短选项

### `bun run build` 做了什么

`build.ts` 使用 Bun bundler 将 TypeScript 源码编译为单文件 `dist/cli.js`（~21MB）。

### vendor/ 目录

原生模块 TypeScript 加载层，编译进产物但因缺少对应 `.node` 二进制文件而自动降级。不影响核心功能。

## 目录结构

```
.
├── src/                  # 核心源码
│   ├── entrypoints/cli.tsx  # 构建入口
│   ├── components/          # 终端 UI 组件（含小石吉祥物）
│   ├── hooks/               # 生命周期钩子
│   ├── tools/               # 工具实现（Bash, Edit, Read 等）
│   └── ...
├── desktop/              # 桌面应用（Tauri + React）
├── relay/                # 中继服务器
├── vscode-extension/     # VS Code 扩展
├── vendor/               # 原生模块加载层
├── scripts/              # 构建辅助脚本
├── build.ts              # Bun 构建脚本
├── package.json
└── tsconfig.json
```

## 常见问题

### 构建报错 `Could not resolve "xxx"`

在 `build.ts` 的 `external` 数组中添加该包名，或在 `scripts/postinstall.js` 中添加对应存根。

### 重新安装依赖后存根丢失

再次运行 `bun install` 或 `node scripts/postinstall.js` 即可重建。
