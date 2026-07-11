# 设置页现代化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hone Desktop 设置页升级到 2026 年标准：多 Provider 卡片 + 模型列表拉取、Agent Skills 规范、MCP 三种传输方式、整页 UI 现代化。

**Architecture:** 前端重构 SettingsPage.tsx + 新增子组件；后端新增 3 个 Tauri command + 扩展 GatewayConfig；旧配置自动迁移。

**Tech Stack:** React + TypeScript（前端）、Rust + Tauri 2 + reqwest（后端）

---

## File Structure

**前端（新建/修改）：**
- 修改 `desktop/src/data/mock.ts` — 新增 ProviderProfile/SkillConfig/McpServer 类型，保留旧类型
- 修改 `desktop/src/tauri/api.ts` — 新增 providerFetchModels/syncMcpsV2/syncSkillsV2
- 修改 `desktop/src/components/SettingsPage.tsx` — 整页重构
- 新建 `desktop/src/components/settings/ProviderSection.tsx` — Provider 多卡片
- 新建 `desktop/src/components/settings/SkillSection.tsx` — Skill 编辑器
- 新建 `desktop/src/components/settings/McpSection.tsx` — MCP 三种传输
- 新建 `desktop/src/components/settings/SettingsStyles.ts` — 共享样式

**后端（修改）：**
- 修改 `desktop/src-tauri/src/commands.rs` — 新增 provider_fetch_models / settings_sync_mcps_v2 / settings_sync_skills_v2
- 修改 `desktop/src-tauri/src/gateway_manager.rs` — GatewayConfig 增加 providers 字段
- 修改 `desktop/src-tauri/src/lib.rs` — 注册新命令

---

### Task 1: 后端 — GatewayConfig 增加 providers 字段

**Files:**
- Modify: `desktop/src-tauri/src/gateway_manager.rs:64-136`

- [ ] **Step 1: 在 GatewayConfig 中增加 providers 字段**

在 `gateway_manager.rs` 的 `GatewayConfig` struct 中，`browser_max_steps` 字段后面增加：

```rust
    /// Multi-provider profiles (2026 format). Empty = use legacy single-provider fields.
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
```

在 `GatewayConfig` struct 定义之后、`fn default_true` 之前，增加 `ProviderProfile` struct：

```rust
/// A single AI provider configuration (OpenAI-compatible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,         // "deepseek" | "openai" | "openrouter" | "custom"
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub is_default: bool,
}
```

- [ ] **Step 2: 在 Default impl 中初始化 providers**

在 `impl Default for GatewayConfig` 的 `Self { ... }` 中，最后一个字段后加：

```rust
            providers: Vec::new(),
```

- [ ] **Step 3: 在 start() 方法中支持多 provider**

在 `gateway_manager.rs` 的 `start()` 方法中（约 line 297-340），在现有 provider 环境变量设置逻辑之前，增加：如果 `providers` 非空，找到 `is_default == true` 的那条，用它覆盖旧字段值再走原有逻辑。

```rust
        // 2026 multi-provider: use the default profile to override legacy fields
        if let Some(default_p) = self.config.providers.iter().find(|p| p.is_default && p.enabled) {
            if !default_p.kind.is_empty() { self.config.provider = default_p.kind.clone(); }
            if !default_p.api_key.is_empty() { self.config.api_key = default_p.api_key.clone(); }
            if !default_p.base_url.is_empty() { self.config.base_url = default_p.base_url.clone(); }
            if !default_p.model.is_empty() { self.config.model = default_p.model.clone(); }
            if default_p.temperature > 0.0 { self.config.temperature = default_p.temperature; }
            if default_p.max_tokens > 0 { self.config.max_tokens = default_p.max_tokens; }
        }
```

- [ ] **Step 4: 编译验证**

Run: `cd desktop/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/gateway_manager.rs
git commit -m "feat: add ProviderProfile and providers field to GatewayConfig"
```

---

### Task 2: 后端 — provider_fetch_models 命令

**Files:**
- Modify: `desktop/src-tauri/src/commands.rs` (在 `test_provider` 函数之后)
- Modify: `desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 新增 provider_fetch_models**

在 `test_provider` 函数之后增加：

```rust
// ── Provider model list fetch ──

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

/// Fetch available models from an OpenAI-compatible /models endpoint.
#[tauri::command]
pub async fn provider_fetch_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ModelInfo>, String> {
    if base_url.trim().is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {}", e))?;

    let resp = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text.chars().take(200).collect::<String>()));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析失败: {} — 响应: {}", e, text.chars().take(200).collect::<String>()))?;

    let data = parsed.get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("响应缺少 data 数组: {}", text.chars().take(200).collect::<String>()))?;

    let models: Vec<ModelInfo> = data.iter().filter_map(|item| {
        let id = item.get("id")?.as_str()?.to_string();
        let owned_by = item.get("owned_by").and_then(|v| v.as_str()).map(String::from);
        Some(ModelInfo { id, owned_by })
    }).collect();

    Ok(models)
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

在 `lib.rs` 的 `generate_handler!` 中，`commands::test_provider,` 之后增加：

```rust
            commands::provider_fetch_models,
```

- [ ] **Step 3: 编译验证**

Run: `cd desktop/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat: add provider_fetch_models command"
```

---

### Task 3: 后端 — settings_sync_mcps_v2 命令

**Files:**
- Modify: `desktop/src-tauri/src/commands.rs` (在 `settings_sync_mcps` 之后)
- Modify: `desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 新增 McpServerV2 struct 和 settings_sync_mcps_v2**

在 `settings_sync_mcps` 函数之后增加：

```rust
// ── MCP v2: stdio / sse / streamable-http ──

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerV2 {
    pub id: String,
    pub name: String,
    pub transport: String,     // "stdio" | "sse" | "streamable-http"
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub enabled: bool,
}

/// Sync MCP servers to claude_desktop_config.json (standard MCP format).
/// Writes to %APPDATA%/Claude/ on Windows, ~/Library/Application Support/Claude/ on macOS.
/// Preserves non-Hone-managed servers via a manifest.
#[tauri::command]
pub async fn settings_sync_mcps_v2(mcps: Vec<McpServerV2>) -> Result<String, String> {
    // Determine the Claude Desktop config directory
    let config_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|h| h.join("Library").join("Application Support").join("Claude"))
    } else {
        dirs::data_dir()  // %APPDATA% on Windows
            .map(|d| d.join("Claude"))
    }
    .ok_or_else(|| "无法确定 Claude 配置目录".to_string())?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("创建 Claude 配置目录失败: {}", e))?;

    let config_path = config_dir.join("claude_desktop_config.json");
    let manifest_path = config_dir.join(".hone-managed-mcps.json");

    // Read existing config to preserve non-Hone servers
    let mut existing: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({ "mcpServers": {} }));

    let existing_servers = existing
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "claude_desktop_config.json 格式错误".to_string())?;

    // Read manifest of previously managed names
    let prev_managed: Vec<String> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // Remove previously managed servers
    for name in &prev_managed {
        existing_servers.remove(name);
    }

    // Add current managed servers
    let mut current_managed = Vec::new();
    for mcp in mcps.into_iter().filter(|m| m.enabled) {
        let name = validate_managed_name(&mcp.name)?;
        let server_config = match mcp.transport.as_str() {
            "stdio" => {
                let mut obj = serde_json::Map::new();
                if let Some(cmd) = &mcp.command {
                    obj.insert("command".into(), serde_json::json!(cmd));
                }
                if let Some(args) = &mcp.args {
                    obj.insert("args".into(), serde_json::json!(args));
                }
                if let Some(env) = &mcp.env {
                    if !env.is_empty() {
                        obj.insert("env".into(), serde_json::json!(env));
                    }
                }
                serde_json::Value::Object(obj)
            }
            "sse" => {
                serde_json::json!({ "url": mcp.url.as_deref().unwrap_or("") })
            }
            "streamable-http" => {
                let mut obj = serde_json::Map::new();
                obj.insert("type".into(), serde_json::json!("streamable-http"));
                if let Some(url) = &mcp.url {
                    obj.insert("url".into(), serde_json::json!(url));
                }
                if let Some(headers) = &mcp.headers {
                    if !headers.is_empty() {
                        obj.insert("headers".into(), serde_json::json!(headers));
                    }
                }
                serde_json::Value::Object(obj)
            }
            other => return Err(format!("未知传输类型: {}", other)),
        };
        existing_servers.insert(name.clone(), server_config);
        current_managed.push(name);
    }

    // Write config (atomic)
    let raw = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    let tmp = config_path.with_extension("json.tmp");
    std::fs::write(&tmp, &raw)
        .map_err(|e| format!("写入配置失败 {}: {}", config_path.display(), e))?;
    std::fs::rename(&tmp, &config_path)
        .map_err(|e| format!("写入配置失败(重命名) {}: {}", config_path.display(), e))?;

    // Write manifest
    let manifest_raw = serde_json::to_string_pretty(&current_managed)
        .map_err(|e| format!("序列化清单失败: {}", e))?;
    let mtmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&mtmp, &manifest_raw)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    std::fs::rename(&mtmp, &manifest_path)
        .map_err(|e| format!("写入清单失败(重命名): {}", e))?;

    Ok(format!("synced {} MCP server(s)", current_managed.len()))
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

在 `commands::settings_sync_mcps,` 之后增加：

```rust
            commands::settings_sync_mcps_v2,
```

- [ ] **Step 3: 编译验证**

Run: `cd desktop/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat: add settings_sync_mcps_v2 with stdio/sse/streamable-http support"
```

---

### Task 4: 后端 — settings_sync_skills_v2 命令

**Files:**
- Modify: `desktop/src-tauri/src/commands.rs` (在 `settings_sync_skills` 之后)
- Modify: `desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: 在 commands.rs 新增 SkillConfigV2 和 settings_sync_skills_v2**

在 `settings_sync_skills` 函数之后增加：

```rust
// ── Skills v2: Agent Skills 规范 (SKILL.md) ──

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConfigV2 {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub compatibility: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub instructions: String,
    pub enabled: bool,
}

/// Validate skill name per Agent Skills spec: lowercase + digits + hyphens, 1-64 chars.
fn validate_skill_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("技能名称长度必须为 1-64 字符".to_string());
    }
    if trimmed.starts_with('-') || trimmed.ends_with('-') || trimmed.contains("--") {
        return Err("技能名称不能以连字符开头/结尾或连续连字符".to_string());
    }
    if !trimmed.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("技能名称只能包含小写字母、数字和连字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// Sync skills to ~/.codex/skills/{name}/SKILL.md (Agent Skills open format).
#[tauri::command]
pub async fn settings_sync_skills_v2(skills: Vec<SkillConfigV2>) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    let skills_dir = home.join(".codex").join("skills");
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("创建 skills 目录失败: {}", e))?;

    let manifest_path = skills_dir.join(".hone-managed-skills.json");
    let prev: Vec<String> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let mut current = Vec::new();

    // Remove stale skills
    for stale in prev.iter().filter(|n| !skills.iter().any(|s| s.name == **n && s.enabled)) {
        let dir = skills_dir.join(stale);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // Write current skills
    for skill in skills.into_iter().filter(|s| s.enabled) {
        let name = validate_skill_name(&skill.name)?;
        let skill_dir = skills_dir.join(&name);
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| format!("创建技能目录失败 {}: {}", skill_dir.display(), e))?;

        // Build YAML frontmatter
        let mut fm = format!("---\nname: {}\ndescription: {}\n", name, quote_frontmatter_value(&skill.description));
        if let Some(lic) = &skill.license {
            if !lic.trim().is_empty() { fm.push_str(&format!("license: {}\n", quote_frontmatter_value(lic))); }
        }
        if let Some(comp) = &skill.compatibility {
            if !comp.trim().is_empty() { fm.push_str(&format!("compatibility: {}\n", quote_frontmatter_value(comp))); }
        }
        if let Some(meta) = &skill.metadata {
            if let Some(obj) = meta.as_object() {
                if !obj.is_empty() {
                    fm.push_str("metadata:\n");
                    for (k, v) in obj {
                        fm.push_str(&format!("  {}: {}\n", k, v));
                    }
                }
            }
        }
        if let Some(tools) = &skill.allowed_tools {
            if !tools.is_empty() {
                fm.push_str(&format!("allowed-tools: {}\n", tools.join(" ")));
            }
        }
        fm.push_str("---\n\n");

        // Build full SKILL.md
        let body = if skill.instructions.trim().is_empty() {
            format!("# {}\n\n{}", name, skill.description)
        } else {
            skill.instructions.clone()
        };
        let content = format!("{}{}", fm, body);

        let skill_file = skill_dir.join("SKILL.md");
        let tmp = skill_dir.join(".SKILL.md.tmp");
        std::fs::write(&tmp, &content)
            .map_err(|e| format!("写入技能失败 {}: {}", skill_file.display(), e))?;
        std::fs::rename(&tmp, &skill_file)
            .map_err(|e| format!("写入技能失败(重命名) {}: {}", skill_file.display(), e))?;

        current.push(name);
    }

    // Write manifest
    let manifest_raw = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("序列化清单失败: {}", e))?;
    let mtmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&mtmp, &manifest_raw)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    std::fs::rename(&mtmp, &manifest_path)
        .map_err(|e| format!("写入清单失败(重命名): {}", e))?;

    Ok(format!("synced {} skill(s)", current.len()))
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

在 `commands::settings_sync_skills,` 之后增加：

```rust
            commands::settings_sync_skills_v2,
```

- [ ] **Step 3: 编译验证**

Run: `cd desktop/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat: add settings_sync_skills_v2 with Agent Skills SKILL.md format"
```

---

### Task 5: 前端 — 类型定义和 API 封装

**Files:**
- Modify: `desktop/src/data/mock.ts`
- Modify: `desktop/src/tauri/api.ts`

- [ ] **Step 1: 在 mock.ts 新增类型**

在 `McpInfo` interface 之后、`// ── Empty defaults` 之前增加：

```ts
// ── 2026 modernized types ──

export interface ProviderProfile {
  id: string;
  name: string;
  kind: 'deepseek' | 'openai' | 'openrouter' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
  isDefault: boolean;
  fetchedModels?: string[];
  lastFetchError?: string;
}

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: { author?: string; version?: string };
  allowedTools?: string[];
  instructions: string;
  enabled: boolean;
  trigger?: string; // 兼容旧字段
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  tools?: number;
  error?: string;
}
```

- [ ] **Step 2: 在 api.ts 新增 API 函数**

在 `clearUserData` 之后增加：

```ts
// ── Provider model fetch ──

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export function providerFetchModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  return invoke('provider_fetch_models', { baseUrl, apiKey });
}

// ── MCP v2 sync ──

export interface McpServerV2 {
  id: string;
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export function syncMcpsV2(mcps: McpServerV2[]): Promise<string> {
  return invoke('settings_sync_mcps_v2', { mcps });
}

// ── Skills v2 sync ──

export interface SkillConfigV2 {
  id: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  instructions: string;
  enabled: boolean;
}

export function syncSkillsV2(skills: SkillConfigV2[]): Promise<string> {
  return invoke('settings_sync_skills_v2', { skills });
}
```

- [ ] **Step 3: TypeScript 编译验证**

Run: `cd desktop && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add desktop/src/data/mock.ts desktop/src/tauri/api.ts
git commit -m "feat: add 2026 types and API wrappers for providers/skills/mcps"
```

---

### Task 6: 前端 — Provider 多卡片组件

**Files:**
- Create: `desktop/src/components/settings/ProviderSection.tsx`

- [ ] **Step 1: 创建 ProviderSection 组件**

```tsx
import React, { useState, useCallback } from 'react';
import { type ProviderProfile } from '../../data/mock';
import { providerFetchModels, testProvider } from '../../tauri/api';
import { isTauri } from '../../tauri/useTauri';

const KIND_DEFAULTS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: '',
};

const KIND_PRESETS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro'],
  custom: [],
};

interface Props {
  providers: ProviderProfile[];
  onChange: (providers: ProviderProfile[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function ProviderSection({ providers, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const update = useCallback((id: string, patch: Partial<ProviderProfile>) => {
    onChange(providers.map(p => p.id === id ? { ...p, ...patch } : p));
  }, [providers, onChange]);

  const addProvider = () => {
    const newP: ProviderProfile = {
      id: `prov_${Date.now()}`,
      name: `Provider ${providers.length + 1}`,
      kind: 'custom',
      apiKey: '',
      baseUrl: '',
      model: '',
      enabled: true,
      isDefault: providers.length === 0,
    };
    onChange([...providers, newP]);
    setExpandedId(newP.id);
  };

  const removeProvider = (id: string) => {
    const filtered = providers.filter(p => p.id !== id);
    if (providers.find(p => p.id === id)?.isDefault && filtered.length > 0) {
      filtered[0].isDefault = true;
    }
    onChange(filtered);
  };

  const setDefault = (id: string) => {
    onChange(providers.map(p => ({ ...p, isDefault: p.id === id })));
  };

  const fetchModels = async (p: ProviderProfile) => {
    if (!isTauri()) return;
    const baseUrl = p.baseUrl || KIND_DEFAULTS[p.kind] || '';
    if (!baseUrl || !p.apiKey) return;
    setFetchingId(p.id);
    try {
      const models = await providerFetchModels(baseUrl, p.apiKey);
      update(p.id, { fetchedModels: models.map(m => m.id), lastFetchError: undefined });
    } catch (e: any) {
      update(p.id, { lastFetchError: String(e?.message ?? e), fetchedModels: undefined });
    } finally {
      setFetchingId(null);
    }
  };

  const testConn = async (p: ProviderProfile) => {
    if (!isTauri()) return;
    setTestingId(p.id);
    try {
      await testProvider({ provider: p.kind, apiKey: p.apiKey, baseUrl: p.baseUrl || KIND_DEFAULTS[p.kind] || '', model: p.model });
      update(p.id, { lastFetchError: undefined });
    } catch (e: any) {
      update(p.id, { lastFetchError: String(e?.message ?? e) });
    } finally {
      setTestingId(null);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
    transition: 'box-shadow 0.15s, border-color 0.15s',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 8,
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box',
  };

  const btnStyle: React.CSSProperties = {
    padding: '7px 16px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none',
  };

  const btnAccent: React.CSSProperties = {
    ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none',
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('大模型', 'AI Providers', lang)}</h2>
        <button style={btnAccent} onClick={addProvider}>{t('+ 添加', '+ Add', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 }}>
        {t('管理多个 AI 模型提供商，支持 OpenAI 兼容接口。', 'Manage multiple AI providers with OpenAI-compatible APIs.', lang)}
      </p>

      {providers.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', color: 'var(--hone-muted)' }}>
          {t('暂无 Provider，点击「添加」创建。', 'No providers yet. Click "Add" to create one.', lang)}
        </div>
      )}

      {providers.map(p => {
        const isExpanded = expandedId === p.id;
        const presets = KIND_PRESETS[p.kind] || [];
        const models = p.fetchedModels || [];
        return (
          <div key={p.id} style={{
            ...cardStyle,
            borderColor: p.isDefault ? 'var(--hone-accent)' : 'var(--hone-border)',
            boxShadow: p.isDefault ? '0 0 0 1px var(--hone-accent)' : 'none',
          }}>
            {/* 卡片头部 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
                   onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                <span style={{ fontSize: 18 }}>{p.isDefault ? '⭐' : '🔌'}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name || `Provider`}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>
                    {p.kind} · {p.model || t('未选模型', 'no model', lang)}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!p.isDefault && (
                  <button style={btnStyle} onClick={() => setDefault(p.id)}>
                    {t('设为默认', 'Set Default', lang)}
                  </button>
                )}
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                  {isExpanded ? t('收起', 'Collapse') : t('编辑', 'Edit')}
                </button>
              </div>
            </div>

            {/* 展开内容 */}
            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('别名', 'Name')}</label>
                  <input style={inputStyle} value={p.name} onChange={e => update(p.id, { name: e.target.value })} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('类型', 'Type')}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['deepseek', 'openai', 'openrouter', 'custom'] as const).map(k => (
                      <button key={k} style={{
                        ...btnStyle,
                        flex: 1,
                        borderColor: p.kind === k ? 'var(--hone-accent)' : 'var(--hone-border)',
                        color: p.kind === k ? 'var(--hone-accent)' : 'var(--hone-muted)',
                      }} onClick={() => update(p.id, { kind: k, baseUrl: p.baseUrl || KIND_DEFAULTS[k] })}>
                        {k}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>API Key</label>
                  <input style={inputStyle} type="password" value={p.apiKey} onChange={e => update(p.id, { apiKey: e.target.value })} placeholder="sk-..." />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>Base URL</label>
                  <input style={inputStyle} value={p.baseUrl} onChange={e => update(p.id, { baseUrl: e.target.value })} placeholder={KIND_DEFAULTS[p.kind] || 'https://...'} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('模型', 'Model')}</label>
                  {models.length > 0 ? (
                    <div>
                      <input list={`models-${p.id}`} style={inputStyle} value={p.model} onChange={e => update(p.id, { model: e.target.value })} placeholder={t('搜索或输入模型名', 'Search or type model name', lang)} />
                      <datalist id={`models-${p.id}`}>
                        {models.map(m => <option key={m} value={m} />)}
                      </datalist>
                      <div style={{ fontSize: 11, color: 'var(--hone-success)', marginTop: 4 }}>
                        {t(`拉取成功，共 ${models.length} 个模型`, `Fetched ${models.length} models`, lang)}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <input style={inputStyle} value={p.model} onChange={e => update(p.id, { model: e.target.value })} placeholder={presets[0] || 'model-name'} />
                      {presets.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {presets.map(m => (
                            <button key={m} style={{ ...btnStyle, padding: '3px 10px', fontSize: 11, borderColor: p.model === m ? 'var(--hone-accent)' : 'var(--hone-border)' }} onClick={() => update(p.id, { model: m })}>{m}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('温度', 'Temperature')}</label>
                    <input type="number" step="0.1" min="0" max="2" style={inputStyle} value={p.temperature ?? ''} onChange={e => update(p.id, { temperature: parseFloat(e.target.value) || undefined })} placeholder="0.7" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('最大 Tokens', 'Max Tokens')}</label>
                    <input type="number" step="128" min="0" style={inputStyle} value={p.maxTokens ?? ''} onChange={e => update(p.id, { maxTokens: parseInt(e.target.value) || undefined })} placeholder="4096" />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button style={{ ...btnAccent, opacity: testingId === p.id ? 0.6 : 1 }} disabled={testingId === p.id} onClick={() => testConn(p)}>
                    {testingId === p.id ? t('测试中…', 'Testing…', lang) : t('🔌 测试', '🔌 Test', lang)}
                  </button>
                  <button style={{ ...btnStyle, opacity: fetchingId === p.id ? 0.6 : 1 }} disabled={fetchingId === p.id} onClick={() => fetchModels(p)}>
                    {fetchingId === p.id ? t('拉取中…', 'Fetching…', lang) : t('📋 拉取模型', '📋 Fetch Models', lang)}
                  </button>
                  <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)' }} onClick={() => removeProvider(p.id)}>
                    {t('删除', 'Delete')}
                  </button>
                </div>

                {p.lastFetchError && (
                  <div style={{ fontSize: 12, color: 'var(--hone-danger)', padding: '8px 12px', background: 'var(--hone-dangerMuted)', borderRadius: 6 }}>
                    {p.lastFetchError}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd desktop && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/settings/ProviderSection.tsx
git commit -m "feat: add ProviderSection multi-card component with model fetching"
```

---

### Task 7: 前端 — Skill 编辑器组件

**Files:**
- Create: `desktop/src/components/settings/SkillSection.tsx`

- [ ] **Step 1: 创建 SkillSection 组件**

```tsx
import React, { useState } from 'react';
import { type SkillConfig } from '../../data/mock';
import { isTauri } from '../../tauri/useTauri';

const TEMPLATES: Array<Partial<SkillConfig>> = [
  { name: 'code-review', description: 'Review code for security issues and best practices. Use when user asks for code review.', instructions: '# Code Review\n\n## Instructions\n1. 检查安全漏洞\n2. 评估性能问题\n3. 检查代码风格\n4. 给出改进建议' },
  { name: 'weekly-report', description: 'Generate a structured weekly report. Use when user asks for weekly report.', instructions: '# Weekly Report\n\n## Instructions\n1. 收集本周完成的工作\n2. 列出阻塞问题\n3. 规划下周计划' },
  { name: 'deploy', description: 'Deploy the project to production. Use when user mentions deploy.', instructions: '# Deploy\n\n## Instructions\n1. 运行测试\n2. 构建项目\n3. 部署到服务器\n4. 验证部署' },
];

interface Props {
  skills: SkillConfig[];
  onChange: (skills: SkillConfig[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function SkillSection({ skills, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({});

  const update = (id: string, patch: Partial<SkillConfig>) => {
    onChange(skills.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  const addSkill = (template?: Partial<SkillConfig>) => {
    const newS: SkillConfig = {
      id: `skill_${Date.now()}`,
      name: template?.name || 'new-skill',
      description: template?.description || '',
      instructions: template?.instructions || '',
      allowedTools: [],
      enabled: true,
      ...template,
    };
    onChange([...skills, newS]);
    setExpandedId(newS.id);
  };

  const removeSkill = (id: string) => {
    onChange(skills.filter(s => s.id !== id));
  };

  const validateName = (name: string): string | null => {
    if (!name) return t('名称不能为空', 'Name required', lang);
    if (name.length > 64) return t('最多 64 字符', 'Max 64 chars', lang);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return t('只能小写字母、数字、连字符', 'lowercase+digits+hyphens only', lang);
    return null;
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 8,
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box',
  };
  const btnStyle: React.CSSProperties = {
    padding: '7px 16px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none',
  };
  const btnAccent: React.CSSProperties = { ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none' };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('技能', 'Skills', lang)}</h2>
        <button style={btnAccent} onClick={() => addSkill()}>{t('+ 新建', '+ New', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 12 }}>
        {t('Agent Skills 规范：SKILL.md + YAML frontmatter + Markdown 指令。', 'Agent Skills spec: SKILL.md + YAML frontmatter + Markdown instructions.', lang)}
      </p>

      {/* 模板 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--hone-muted)', alignSelf: 'center' }}>{t('模板:', 'Templates:', lang)}</span>
        {TEMPLATES.map(tpl => (
          <button key={tpl.name} style={{ ...btnStyle, fontSize: 11, padding: '3px 10px' }} onClick={() => addSkill(tpl)}>{tpl.name}</button>
        ))}
      </div>

      {skills.map(s => {
        const isExpanded = expandedId === s.id;
        const nameError = validateName(s.name);
        return (
          <div key={s.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }} onClick={() => setExpandedId(isExpanded ? null : s.id)}>
                <span style={{ fontSize: 18 }}>📦</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'monospace' }}>/{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{s.description.slice(0, 60) || t('无描述', 'no description', lang)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: s.enabled ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                  {s.enabled ? t('启用', 'On') : t('禁用', 'Off')}
                </span>
                <button style={{ ...btnStyle, padding: '4px 12px' }} onClick={() => update(s.id, { enabled: !s.enabled })}>
                  {s.enabled ? '禁用' : '启用'}
                </button>
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : s.id)}>
                  {isExpanded ? t('收起', 'Collapse') : t('编辑', 'Edit')}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('名称', 'Name')}</label>
                  <input style={{ ...inputStyle, borderColor: nameError ? 'var(--hone-danger)' : 'var(--hone-border)' }} value={s.name} onChange={e => update(s.id, { name: e.target.value })} />
                  {nameError && <div style={{ fontSize: 11, color: 'var(--hone-danger)', marginTop: 4 }}>{nameError}</div>}
                  <div style={{ fontSize: 11, color: 'var(--hone-muted)', marginTop: 4 }}>{t('小写字母+数字+连字符，1-64 字符', 'lowercase+digits+hyphens, 1-64 chars', lang)}</div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('描述', 'Description')}</label>
                  <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={s.description} onChange={e => update(s.id, { description: e.target.value })} placeholder={t('说明做什么 + 什么时候用', 'What it does + when to use', lang)} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('指令 (Markdown)', 'Instructions (Markdown)')}</label>
                  <textarea style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'monospace' }} value={s.instructions} onChange={e => update(s.id, { instructions: e.target.value })} />
                </div>

                <button style={{ ...btnStyle, fontSize: 12, width: 'fit-content' }} onClick={() => setShowAdvanced({ ...showAdvanced, [s.id]: !showAdvanced[s.id] })}>
                  {showAdvanced[s.id] ? t('▼ 高级', '▼ Advanced') : t('▶ 高级', '▶ Advanced')}
                </button>

                {showAdvanced[s.id] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 12, borderLeft: '2px solid var(--hone-border)' }}>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('许可证', 'License')}</label>
                      <input style={inputStyle} value={s.license || ''} onChange={e => update(s.id, { license: e.target.value })} placeholder="MIT" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('兼容性', 'Compatibility')}</label>
                      <input style={inputStyle} value={s.compatibility || ''} onChange={e => update(s.id, { compatibility: e.target.value })} placeholder="Requires Python 3.9+" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('允许工具', 'Allowed Tools')}</label>
                      <input style={inputStyle} value={(s.allowedTools || []).join(' ')} onChange={e => update(s.id, { allowedTools: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="Bash(python:*) Read Write" />
                    </div>
                  </div>
                )}

                <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)', width: 'fit-content' }} onClick={() => removeSkill(s.id)}>
                  {t('删除技能', 'Delete Skill')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd desktop && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/settings/SkillSection.tsx
git commit -m "feat: add SkillSection with Agent Skills SKILL.md editor"
```

---

### Task 8: 前端 — MCP 三种传输组件

**Files:**
- Create: `desktop/src/components/settings/McpSection.tsx`

- [ ] **Step 1: 创建 McpSection 组件**

```tsx
import React, { useState } from 'react';
import { type McpServer } from '../../data/mock';

interface Props {
  mcps: McpServer[];
  onChange: (mcps: McpServer[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function McpSection({ mcps, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const update = (id: string, patch: Partial<McpServer>) => {
    onChange(mcps.map(m => m.id === id ? { ...m, ...patch } : m));
  };

  const addMcp = () => {
    const newM: McpServer = {
      id: `mcp_${Date.now()}`,
      name: 'new-mcp',
      transport: 'stdio',
      command: '',
      args: [],
      enabled: true,
      status: 'disconnected',
    };
    onChange([...mcps, newM]);
    setExpandedId(newM.id);
  };

  const removeMcp = (id: string) => {
    onChange(mcps.filter(m => m.id !== id));
  };

  const copyJson = (m: McpServer) => {
    const config: Record<string, unknown> = {};
    if (m.transport === 'stdio') {
      if (m.command) config.command = m.command;
      if (m.args && m.args.length) config.args = m.args;
      if (m.env && Object.keys(m.env).length) config.env = m.env;
    } else if (m.transport === 'sse') {
      config.url = m.url || '';
    } else {
      config.type = 'streamable-http';
      config.url = m.url || '';
      if (m.headers && Object.keys(m.headers).length) config.headers = m.headers;
    }
    const text = JSON.stringify({ mcpServers: { [m.name]: config } }, null, 2);
    navigator.clipboard.writeText(text);
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 8,
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box',
  };
  const btnStyle: React.CSSProperties = {
    padding: '7px 16px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none',
  };
  const btnAccent: React.CSSProperties = { ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none' };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>MCP {t('服务器', 'Servers', lang)}</h2>
        <button style={btnAccent} onClick={addMcp}>{t('+ 添加', '+ Add', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 }}>
        {t('支持 stdio / sse / streamable-http 三种传输，同步到 claude_desktop_config.json。', 'Supports stdio / sse / streamable-http. Syncs to claude_desktop_config.json.', lang)}
      </p>

      {mcps.map(m => {
        const isExpanded = expandedId === m.id;
        return (
          <div key={m.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }} onClick={() => setExpandedId(isExpanded ? null : m.id)}>
                <span style={{ fontSize: 18 }}>🔌</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{m.transport}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: m.enabled ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                  {m.enabled ? t('启用', 'On') : t('禁用', 'Off')}
                </span>
                <button style={{ ...btnStyle, padding: '4px 12px' }} onClick={() => update(m.id, { enabled: !m.enabled })}>
                  {m.enabled ? '禁用' : '启用'}
                </button>
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : m.id)}>
                  {isExpanded ? t('收起', 'Collapse') : t('编辑', 'Edit')}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('名称', 'Name')}</label>
                  <input style={inputStyle} value={m.name} onChange={e => update(m.id, { name: e.target.value })} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('传输类型', 'Transport')}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['stdio', 'sse', 'streamable-http'] as const).map(tr => (
                      <button key={tr} style={{
                        ...btnStyle, flex: 1,
                        borderColor: m.transport === tr ? 'var(--hone-accent)' : 'var(--hone-border)',
                        color: m.transport === tr ? 'var(--hone-accent)' : 'var(--hone-muted)',
                      }} onClick={() => update(m.id, { transport: tr })}>{tr}</button>
                    ))}
                  </div>
                </div>

                {m.transport === 'stdio' && (
                  <>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('命令', 'Command')}</label>
                      <input style={inputStyle} value={m.command || ''} onChange={e => update(m.id, { command: e.target.value })} placeholder="npx" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('参数 (每行一个)', 'Args (one per line)')}</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={(m.args || []).join('\n')} onChange={e => update(m.id, { args: e.target.value.split('\n').filter(a => a.trim()) })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/user/data'} />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>Env</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={Object.entries(m.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')} onChange={e => {
                        const env: Record<string, string> = {};
                        e.target.value.split('\n').forEach(line => {
                          const idx = line.indexOf('=');
                          if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
                        });
                        update(m.id, { env });
                      }} placeholder="NODE_ENV=production" />
                    </div>
                  </>
                )}

                {m.transport === 'sse' && (
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>URL</label>
                    <input style={inputStyle} value={m.url || ''} onChange={e => update(m.id, { url: e.target.value })} placeholder="http://localhost:3000/sse" />
                  </div>
                )}

                {m.transport === 'streamable-http' && (
                  <>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>URL</label>
                      <input style={inputStyle} value={m.url || ''} onChange={e => update(m.id, { url: e.target.value })} placeholder="https://serp.mcp.acedata.cloud/mcp" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('请求头', 'Headers')}</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={Object.entries(m.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')} onChange={e => {
                        const headers: Record<string, string> = {};
                        e.target.value.split('\n').forEach(line => {
                          const idx = line.indexOf(':');
                          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                        });
                        update(m.id, { headers });
                      }} placeholder="Authorization: Bearer YOUR_TOKEN" />
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={btnStyle} onClick={() => copyJson(m)}>{t('📋 复制 JSON', '📋 Copy JSON')}</button>
                  <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)' }} onClick={() => removeMcp(m.id)}>{t('删除', 'Delete')}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd desktop && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/settings/McpSection.tsx
git commit -m "feat: add McpSection with stdio/sse/streamable-http support"
```

---

### Task 9: 前端 — SettingsPage 整页重构

**Files:**
- Modify: `desktop/src/components/SettingsPage.tsx`

- [ ] **Step 1: 重构 SettingsPage，集成新组件 + 旧配置迁移 + 导航分组**

替换整个 `SettingsPage.tsx`。保留 Gateway/Browser/Appearance/About/Data 部分（从旧文件复制），重写 Provider/Skill/MCP 部分，使用新组件。关键变更：

1. 新增 state：`providers: ProviderProfile[]`、`skillsV2: SkillConfig[]`、`mcpsV2: McpServer[]`。
2. 首次加载时迁移旧配置（旧 `hone-skills` localStorage → `skillsV2`，旧 `hone-mcps` → `mcpsV2`，旧单 provider → `providers`）。
3. 自动保存扩展：保存 `providers` 到 GatewayConfig。
4. 同步 skills/mcps 走 v2 API。
5. 导航分组：AI（Provider、Skills）、连接（Gateway、MCP）、系统（Browser、Appearance、Data、About）。

由于此文件很大（1000+ 行），具体实现为：
- import 新组件 `ProviderSection`、`SkillSection`、`McpSection`。
- `renderProvider()` → `<ProviderSection providers={providers} onChange={setProviders} lang={lang} />`。
- `renderSkills()` → `<SkillSection skills={skillsV2} onChange={setSkillsV2} lang={lang} />`。
- `renderMcp()` → `<McpSection mcps={mcpsV2} onChange={setMcpsV2} lang={lang} />`。
- 导航数组改为分组结构。
- `autoSave` 增加 `providers` 字段。
- `updateSkills`/`updateMcps` 改为调用 `syncSkillsV2`/`syncMcpsV2`。

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd desktop && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/SettingsPage.tsx
git commit -m "feat: modernize SettingsPage with 2026 provider/skill/mcp UI"
```

---

### Task 10: 构建验证 + 手动测试

**Files:** N/A

- [ ] **Step 1: 后端编译**

Run: `cd desktop/src-tauri && cargo check`
Expected: 无错误

- [ ] **Step 2: 前端编译**

Run: `cd desktop && npx tsc --noEmit && npm run build`
Expected: 无错误

- [ ] **Step 3: 启动 dev 模式手动验证**

Run: `cd desktop && npm run tauri dev`

手动检查：
- 设置页打开无崩溃
- Provider 添加/编辑/删除/设为默认
- Skill 添加/编辑/删除/模板
- MCP 三种传输切换
- 旧配置正确迁移显示
- 自动保存正常工作

- [ ] **Step 4: 构建 CLI 和安装包**

Run: `cd desktop && npm run build:cli && npm run tauri build`
Expected: 生成 `target/release/bundle/nsis/Hone_0.3.0-alpha_x64-setup.exe`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete settings page modernization (2026 standard)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Provider 多卡片 + 模型拉取 → Task 1, 2, 6
- ✅ Skill Agent Skills 规范 → Task 4, 7
- ✅ MCP 三种传输 → Task 3, 8
- ✅ 整页 UI/UX → Task 9
- ✅ 旧配置迁移 → Task 9
- ✅ 后端 API → Task 1-4
- ✅ 构建验证 → Task 10

**Placeholder scan:** 无 TBD/TODO。Task 9 步骤 1 因文件太大用描述性指引而非完整代码，但提供了明确的改造要点。

**Type consistency:** ProviderProfile/SkillConfig/McpServer 在 mock.ts 和 api.ts 中字段名一致；后端 Rust struct 用 `#[serde(rename_all = "camelCase")]` 对齐前端。
