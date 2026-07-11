# Hone 设置页现代化设计文档（2026 版）

## 1. 目标
把 Hone Desktop 的设置页升级到 2026 年主流 AI 客户端配置标准：
- **Provider**：多卡片，OpenAI 兼容，支持 `/models` 自动拉取模型列表。
- **Skill**：采用 Agent Skills 开放规范（`SKILL.md` + YAML frontmatter + Markdown 指令 + scripts/references/assets 目录），不再是 JSON。
- **MCP**：支持三种传输方式 `stdio` / `sse` / `streamable-http`，配置写入 `claude_desktop_config.json`，支持 `headers` 认证。
- 整页 UI/UX 现代化、响应式、分组清晰、反馈明确。
- 完全兼容旧配置，首次打开时自动迁移。

## 2. 2026 年生态标准摘要（设计依据）

### 2.1 MCP（Model Context Protocol）
- 三种传输方式：
  - `stdio`：本地子进程，`{ "command": "npx", "args": [...], "env": {...} }`
  - `sse`：Server-Sent Events，`{ "url": "http://..." }`
  - `streamable-http`（2025 新增）：`{ "type": "streamable-http", "url": "https://...", "headers": { "Authorization": "Bearer ..." } }`
- 配置文件：`claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/`，Windows: `%APPDATA%/Claude/`，Store 版在 `Packages` 目录下）。
- 格式：`{ "mcpServers": { "name": { ...config } } }`
- 支持 `headers` 字段做 OAuth/Bearer 认证。

### 2.2 Agent Skills（开放规范，agentskills.io）
- **格式**：文件夹，核心是 `SKILL.md`（YAML frontmatter + Markdown body）。
- **目录结构**：
  ```
  my-skill/
  ├── SKILL.md          # 必须：元数据 + 指令
  ├── scripts/          # 可选：可执行脚本
  │   └── helper.py
  ├── references/       # 可选：参考文档
  │   └── REFERENCE.md
  └── assets/           # 可选：模板、资源
      └── template.json
  ```
- **Frontmatter 字段**：
  | 字段 | 必须 | 说明 |
  |------|------|------|
  | `name` | ✅ | 1-64 字符，小写+数字+连字符，必须与目录名一致 |
  | `description` | ✅ | 1-1024 字符，说明做什么+什么时候用 |
  | `license` | ❌ | 许可证 |
  | `compatibility` | ❌ | 环境要求 |
  | `metadata` | ❌ | 作者、版本等 |
  | `allowed-tools` | ❌ | 空格分隔的预批准工具列表 |
- **渐进式披露**：元数据 ~100 tokens → 激活 <5000 tokens → 资源按需加载。
- **加载路径**（Claude Code / Codex）：
  - `$CWD/.codex/skills`
  - `~/.codex/skills`
  - `/etc/codex/skills`
- **触发方式**：显式 `$skill-name` 或隐式 AI 自动选择。
- 已被 OpenAI Codex、Claude 采用。

### 2.3 Provider（OpenAI 兼容）
- 三要素：`Base URL` + `API Key` + `Model ID`。
- `/models` 端点：`GET {baseUrl}/models`，Header `Authorization: Bearer {key}`，返回 `{ "data": [{ "id": "..." }] }`。
- OpenRouter 作为多模型聚合：`https://openrouter.ai/api/v1`，model slug 格式 `provider/model-name`。
- 严格的 OpenAI-compatible gateway 会拒绝未知字段，调用时需清理自定义元数据。

## 3. 数据模型

### 3.1 ProviderProfile
```ts
interface ProviderProfile {
  id: string;                    // uuid
  name: string;                  // 用户自定义别名，如「公司 DeepSeek」
  kind: 'deepseek' | 'openai' | 'openrouter' | 'custom';
  apiKey: string;
  baseUrl: string;               // 留空使用 kind 默认地址
  model: string;                 // 默认模型
  temperature?: number;          // 0-2
  maxTokens?: number;            // >0
  enabled: boolean;
  isDefault: boolean;            // 当前默认 provider
  // 运行时缓存（不持久化到配置文件）
  fetchedModels?: string[];      // 上次拉取到的模型列表
  lastFetchError?: string;
}
```

**默认 baseUrl**
| kind | baseUrl |
|------|---------|
| deepseek | `https://api.deepseek.com` |
| openai | `https://api.openai.com/v1` |
| openrouter | `https://openrouter.ai/api/v1` |
| custom | 空 |

### 3.2 Skill（对齐 Agent Skills 规范）
```ts
interface SkillConfig {
  id: string;                    // 前端管理用 uuid
  name: string;                  // 必须符合规范：小写+数字+连字符
  description: string;           // 1-1024 字符
  license?: string;
  compatibility?: string;
  metadata?: {
    author?: string;
    version?: string;
  };
  allowedTools?: string[];       // 对应 allowed-tools，空格分隔
  instructions: string;          // Markdown body，SKILL.md 的正文
  enabled: boolean;
  // 兼容旧字段
  trigger?: string;              // 旧 hone-skills 的 trigger，迁移用
}
```

### 3.3 MCP Server（支持三种传输）
```ts
interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse / streamable-http
  url?: string;
  headers?: Record<string, string>;   // 如 Authorization
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  tools?: number;
  error?: string;
}
```

## 4. Provider 模型列表自动拉取

### 4.1 拉取方式
- 端点：`GET {baseUrl}/models`
- Header：`Authorization: Bearer {apiKey}`
- 解析返回 `{ "data": [{ "id": "model-name", ... }] }`
- 提取 `id` 数组，排序后缓存到 `fetchedModels`。

### 4.2 触发时机
- 用户在 provider 卡片点击「拉取模型」按钮。
- 测试连接成功后自动拉取一次。
- 不做后台轮询，避免浪费配额。

### 4.3 UI 表现
- 拉取前：模型名是普通文本输入框。
- 拉取成功后：变成可搜索下拉框 + 「手动输入」切换按钮。
- 显示「拉取成功，共 N 个模型」或错误信息。
- OpenRouter 返回模型多（几百个），必须支持搜索过滤。
- 始终保留手动输入能力（私有部署可能不暴露 `/models`）。

### 4.4 后端实现
```rust
#[tauri::command]
pub async fn provider_fetch_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ModelInfo>, String> {
    // 用 reqwest GET {base_url}/models
    // 返回 Vec<ModelInfo> { id, owned_by?, created? }
}
```
前端通过 `invoke('provider_fetch_models', { baseUrl, apiKey })` 调用。

## 5. Skill 配置

### 5.1 前端编辑器
- 表单字段：
  - `name`：带实时校验（小写+数字+连字符，1-64 字符）。
  - `description`：多行输入，提示「说明做什么 + 什么时候用」。
  - `license`、`compatibility`、`metadata.author/version`：折叠的「高级」区域。
  - `allowedTools`：标签输入。
  - `instructions`：Markdown 大文本编辑器，带预览。
- 模板库：「代码审查」「周报生成」「PDF 处理」「部署助手」。
- 导入/导出：支持导入 `.md` 文件或整个 skill 文件夹（zip），导出为文件夹或 zip。

### 5.2 同步到磁盘
同步到 `~/.codex/skills/{name}/`：
```
~/.codex/skills/
└── my-skill/
    └── SKILL.md      # 前端只生成 SKILL.md，scripts/references/assets 暂不管理
```
`SKILL.md` 内容：
```markdown
---
name: my-skill
description: ...
license: ...
compatibility: ...
metadata:
  author: ...
  version: "1.0.0"
allowed-tools: Bash(python:*) Read Write
---

# Skill Title

## Instructions
...
```

### 5.3 旧配置迁移
旧 `hone-skills` localStorage 的 `{ name, desc, descEn, trigger, enabled }`：
- `name` → `name`（需校验转小写+连字符）
- `desc` → `description`
- `trigger` → 保留为 `trigger` 兼容字段，同时写入 instructions：「当用户提到 {trigger} 时执行此技能。」
- `instructions = "# {name}\n\n{desc}\n\n## Instructions\n当用户提到触发词「{trigger}」时，执行此技能。"`

## 6. MCP 配置

### 6.1 三种传输的配置生成

**stdio**：
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/data"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

**sse**：
```json
{
  "mcpServers": {
    "remote-sse": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

**streamable-http**（2025 新增）：
```json
{
  "mcpServers": {
    "serp": {
      "type": "streamable-http",
      "url": "https://serp.mcp.acedata.cloud/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

### 6.2 配置文件路径
- Windows：`%APPDATA%/Claude/claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- 检测 Store 版路径：`%LOCALAPPDATA%/Packages/Claude_pzs8*/LocalCache/Roaming/Claude/`

### 6.3 前端表单
- 传输类型选择器：`stdio` / `sse` / `streamable-http`。
- 根据类型动态显示字段：
  - stdio：command、args（数组输入）、env（键值对输入）。
  - sse：url。
  - streamable-http：url、headers（键值对输入，常用 Authorization）。
- 一键复制为 JSON 片段。
- 状态检测：
  - sse/streamable-http：尝试 HTTP GET 连通性检查。
  - stdio：验证 command 是否在 PATH 中（`where`/`which`）。

### 6.4 后端实现
```rust
#[tauri::command]
pub async fn settings_sync_mcps_v2(mcps: Vec<McpServerV2>) -> Result<String, String>;
```
写入 `claude_desktop_config.json`，合并已有非 Hone 管理的 server（用 manifest 追踪）。

## 7. UI/UX 设计

### 7.1 布局
- 左侧导航分组：
  - **AI**：Provider、Skills
  - **连接**：Gateway、MCP Servers
  - **系统**：Browser、Appearance、Data、About
- 小屏幕（< 768px）：导航变顶部横向滚动标签。
- 内容区最大宽度 800px。

### 7.2 视觉
- 卡片：圆角 12px，边框 1px，hover 轻微上浮 + 阴影。
- 输入框统一高度 40px，聚焦时主题色边框 + 轻微发光。
- 开关、按钮、下拉框尺寸统一。
- 状态色：success / danger / warning / muted。

### 7.3 反馈
- 自动保存：「保存中…」「已保存」「保存失败」三态，顶部全局显示。
- 测试连接 / 拉取模型：loading spinner + 成功/失败内联提示。
- 危险操作：弹窗二次确认，列出影响范围。

### 7.4 细节
- Provider 卡片：支持设为默认、测试、拉取模型、编辑、删除。
- Skill：折叠列表 + 展开编辑；name 实时校验。
- MCP：传输类型切换时字段平滑过渡；配置 JSON 预览。
- About：复制版本号、打开日志目录、打开配置目录。

## 8. 后端 API 变更

### 8.1 新增命令
```rust
#[tauri::command]
pub async fn provider_fetch_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ModelInfo>, String>;

#[tauri::command]
pub async fn settings_sync_mcps_v2(mcps: Vec<McpServerV2>) -> Result<String, String>;

#[tauri::command]
pub async fn settings_sync_skills_v2(skills: Vec<SkillConfigV2>) -> Result<String, String>;
```

### 8.2 修改命令
- `GatewayConfig` 增加 `providers: Vec<ProviderProfile>`，保留旧字段做迁移。
- 旧 `settings_sync_mcps` / `settings_sync_skills` 标记 deprecated 但保留。

### 8.3 SkillConfigV2 / McpServerV2 Rust 结构
```rust
#[derive(Serialize, Deserialize)]
pub struct SkillConfigV2 {
    pub id: String,
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub allowed_tools: Option<Vec<String>>,
    pub instructions: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize)]
pub struct McpServerV2 {
    pub id: String,
    pub name: String,
    pub transport: String,      // "stdio" | "sse" | "streamable-http"
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub enabled: bool,
}
```

## 9. 迁移策略

### 9.1 Provider 迁移
首次读取旧 `gateway-config.json`：
1. 有 `provider`/`apiKey`/`baseUrl`/`model` → 生成一条 ProviderProfile，id=`legacy-default`，isDefault=true。
2. 写入 `providers` 数组，保留旧字段（兼容旧 daemon 读取）。
3. 后续读取优先用 `providers`。

### 9.2 MCP 迁移
- 旧 `.mcp.json`（Hone 自定义 `{ name, url }`）→ 转为 SSE 类型 McpServer。
- 新配置写入 `claude_desktop_config.json`。

### 9.3 Skill 迁移
- localStorage `hone-skills` 按 5.3 规则迁移。
- 同步到 `~/.codex/skills/` 生成 `SKILL.md`。

## 10. 错误处理
- 前端：API 失败显示 toast，表单校验内联提示。
- 后端：`/models` 拉取失败返回 HTTP 状态码 + 响应体摘要；配置写入失败原子替换（先写 .tmp 再 rename）。
- 迁移失败记录日志，不崩溃。

## 11. 不做的范围
- 不改 Gateway Daemon 的 LLM 调用协议。
- 不做云端配置同步。
- 不做 MCP server 市场。
- 不管理 skill 的 scripts/references/assets 子目录（仅生成 SKILL.md，用户可手动扩展）。
- 不做 MCP 实时进程启动/日志（仅配置同步 + 连通性检查）。
