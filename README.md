# Claude Code Source (v2.1.88)

从 `@anthropic-ai/claude-code` npm 包的 `cli.js.map` 中还原出的完整 TypeScript 源码，可编译运行。

## 快速开始

**三步即可运行：**

```bash
# 1. 安装依赖（自动创建私有包存根 + 补丁 commander）
bun install

# 2. 构建
bun run build

# 3. 运行
bun dist/cli.js
```

验证：

```bash
$ bun dist/cli.js --version
2.1.88 (Claude Code)

$ bun dist/cli.js --help
Usage: claude [options] [command] [prompt]
Claude Code - starts an interactive session by default...
```

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| [Bun](https://bun.sh) | >= 1.3.5 | 依赖安装 + 构建打包（源码使用 `bun:bundle` 特性） |
| [Node.js](https://nodejs.org) | >= 18 | 运行时 |

### 安装 Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# 或通过 Homebrew
brew install oven-sh/bun/bun
```

## 如何使用

### 与正式版共存

如果你已安装正式版 `claude`，可以通过别名区分：

```bash
# 在 ~/.zshrc 或 ~/.bashrc 中添加
alias claude-dev="bun /path/to/claude-code-source/dist/cli.js"
```

之后 `claude` 是正式版，`claude-dev` 是源码构建版。两者共享 `~/.claude/` 下的认证信息和配置，无需重新登录。

### 认证

源码版与正式版共享认证，如果正式版已登录则无需额外操作。否则：

```bash
# 方式一：环境变量
export ANTHROPIC_API_KEY="sk-ant-..."

# 方式二：OAuth 登录
bun dist/cli.js auth
```

## 构建原理

### `bun install` 做了什么

除了安装公开 npm 依赖外，`postinstall` 脚本（`scripts/postinstall.js`）会自动完成两件事：

**1. 创建私有包存根**

源码中引用了 5 个 Anthropic 内部包，公开 npm 上不存在。postinstall 会在 `node_modules/` 中创建功能存根（stub），使构建通过并在运行时安全降级：

| 包名 | 实际用途 | 存根行为 |
|------|---------|---------|
| `color-diff-napi` | 原生语法高亮 + 彩色 diff | 高亮不可用，回退纯文本 diff |
| `modifiers-napi` | macOS 键盘修饰键检测 | 始终返回 `false` |
| `@ant/claude-for-chrome-mcp` | Chrome 浏览器扩展 MCP 服务 | 功能不可用（正常使用不涉及） |
| `@anthropic-ai/mcpb` | MCP bundle / DXT 插件处理 | 插件安装功能受限 |
| `@anthropic-ai/sandbox-runtime` | Linux 沙箱（bubblewrap） | 返回不支持，跳过沙箱 |

**2. 补丁 commander**

源码使用 `-d2e` 作为多字符短选项，但 commander v14 只允许单字符短选项。postinstall 将正则 `/^-[^-]$/` 改为 `/^-[^-]+$/`。

### `bun run build` 做了什么

`build.ts` 使用 Bun bundler 将 TypeScript 源码编译为单文件 `dist/cli.js`（~21MB），过程中处理：

- **特性开关**：通过 Bun plugin 拦截 `import { feature } from 'bun:bundle'`，将 90+ 个 feature flag 替换为编译期常量，实现死代码消除
- **MACRO 常量**：通过 `define` 注入 `MACRO.VERSION`、`MACRO.BUILD_TIME` 等编译期常量
- **文本文件**：`.md`/`.txt` 文件作为字符串导入
- **External 排除**：`.node` 原生模块和可选云 SDK（Bedrock/Vertex/Foundry）标记为 external，不打包

### vendor/ 目录

包含 Anthropic 自研原生模块（`.node`）的 TypeScript 加载层：

| 模块 | 功能 |
|------|------|
| `modifiers-napi-src` | macOS 键盘修饰键检测 |
| `url-handler-src` | macOS URL scheme 事件监听（OAuth 回调） |
| `audio-capture-src` | 麦克风录音 / 音频播放（语音模式） |
| `image-processor-src` | 图片处理（替代 sharp） |

这些加载器编译进产物，但因缺少对应的 `.node` 二进制文件而自动降级（代码自带 try/catch 容错）。不影响核心功能。

## 源码还原方法

```bash
# 1. 下载 npm 包
npm pack @anthropic-ai/claude-code --registry https://registry.npmjs.org

# 2. 解压
tar xzf anthropic-ai-claude-code-2.1.88.tgz

# 3. 从 cli.js.map 还原源码
node -e "
const fs = require('fs'), path = require('path');
const map = JSON.parse(fs.readFileSync('package/cli.js.map', 'utf8'));
const outDir = './claude-code-source';
for (let i = 0; i < map.sources.length; i++) {
  const content = map.sourcesContent[i];
  if (!content) continue;
  let relPath = map.sources[i];
  while (relPath.startsWith('../')) relPath = relPath.slice(3);
  const outPath = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
}
"
```

## 目录结构

```
.
├── src/                  # 核心源码（1902 个文件）
│   ├── entrypoints/
│   │   └── cli.tsx       # ← 构建入口点
│   ├── main.tsx          # 主 REPL 逻辑
│   ├── Tool.ts           # 工具类型系统
│   ├── Task.ts           # 任务管理
│   ├── QueryEngine.ts    # 查询引擎
│   ├── assistant/        # 会话历史管理
│   ├── bridge/           # IDE 桥接层
│   ├── buddy/            # 子代理系统
│   ├── cli/              # CLI 参数解析
│   ├── commands/         # 斜杠命令
│   ├── components/       # 终端 UI 组件
│   ├── constants/        # 全局常量
│   ├── context/          # 上下文管理
│   ├── hooks/            # 生命周期钩子
│   ├── ink/              # 自研终端渲染引擎
│   ├── keybindings/      # 键盘快捷键
│   ├── services/         # 核心服务
│   ├── skills/           # 技能系统
│   ├── state/            # 状态管理
│   ├── tools/            # 工具实现（Bash, Edit, Read 等）
│   ├── utils/            # 工具函数
│   └── vim/              # Vim 模式
├── vendor/               # 原生模块加载层（4 文件）
├── scripts/
│   └── postinstall.js    # 自动创建私有包存根 + 补丁
├── dist/                 # 构建产出
│   └── cli.js            # 可执行文件（~21MB）
├── build.ts              # Bun 构建脚本
├── bunfig.toml           # Bun 配置（自动信任 postinstall）
├── tsconfig.json         # TypeScript 配置
├── package.json          # 项目配置
└── bun.lock              # 依赖锁定
```

## 常见问题

### 构建报错 `Could not resolve "xxx"`

如果出现新的无法解析的内部包，在 `build.ts` 的 `external` 数组中添加该包名，或在 `scripts/postinstall.js` 中添加对应存根。

### 运行时报 `xxx is not a function`

私有包存根缺少某个方法。查看报错堆栈找到调用的方法名，在 `scripts/postinstall.js` 对应存根中补充。

### 重新安装依赖后存根丢失

`bun install` 可能清除手动创建的 `node_modules` 内容。再次运行 `bun install` 或 `node scripts/postinstall.js` 即可重建。

## 统计

| 指标 | 数值 |
|------|------|
| 源文件总数 | 4,756 |
| 核心源码（src/ + vendor/） | 1,906 文件 |
| 构建产出大小 | ~21 MB |
| 包版本 | 2.1.88 |
| 特性开关数量 | 90 个 |
