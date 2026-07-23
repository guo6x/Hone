use crate::gateway_manager::{GatewayConfig, ProviderProfile};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

const SERVICE_NAME: &str = "dev.hone.desktop";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct GatewaySecrets {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub gui_model_key: String,
    #[serde(default)]
    pub relay_gateway_token: String,
    #[serde(default)]
    pub local_auth_token: String,
    #[serde(default)]
    pub pairing_code: String,
    #[serde(default)]
    pub provider_api_keys: BTreeMap<String, String>,
}

fn entry(secret_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, secret_id)
        .map_err(|error| format!("credential store unavailable: {error}"))
}

fn fallback_path(secret_id: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("dev.hone.desktop").join(format!("secrets-{secret_id}.json")))
}

pub fn load(secret_id: &str) -> Result<GatewaySecrets, String> {
    // 优先从 OS 凭据管理器读取；如果失败（某些安装环境下 keyring 不可用），
    // 回退到同目录下的 secrets 文件，避免用户 API key 丢失。
    match entry(secret_id)?.get_password() {
        Ok(encoded) => {
            return serde_json::from_str(&encoded)
                .map_err(|error| format!("credential data is invalid: {error}"));
        }
        Err(keyring_error) => {
            if let Some(path) = fallback_path(secret_id) {
                if let Ok(bytes) = std::fs::read(&path) {
                    if let Ok(secrets) = serde_json::from_slice::<GatewaySecrets>(&bytes) {
                        return Ok(secrets);
                    }
                }
            }
            Err(format!("credential read failed: {keyring_error}"))
        }
    }
}

pub fn save(secret_id: &str, secrets: &GatewaySecrets) -> Result<(), String> {
    // 合并非空字段，避免用当前内存中的空值覆盖凭据管理器里已有的 API key。
    // 例如 Settings 页面 autoSave 可能传一个 api_key 为空的 GatewayConfig，
    // 如果直接写入会把用户之前保存的有效 key 清空。
    let merged = match load(secret_id) {
        Ok(existing) => GatewaySecrets {
            // 当前 config 中的值是权威；空值表示未设置，应保留已有非空凭据。
            api_key: if secrets.api_key.is_empty() && !existing.api_key.is_empty() { existing.api_key } else { secrets.api_key.clone() },
            gui_model_key: if secrets.gui_model_key.is_empty() && !existing.gui_model_key.is_empty() { existing.gui_model_key } else { secrets.gui_model_key.clone() },
            relay_gateway_token: if secrets.relay_gateway_token.is_empty() && !existing.relay_gateway_token.is_empty() { existing.relay_gateway_token } else { secrets.relay_gateway_token.clone() },
            local_auth_token: if secrets.local_auth_token.is_empty() && !existing.local_auth_token.is_empty() { existing.local_auth_token } else { secrets.local_auth_token.clone() },
            pairing_code: if secrets.pairing_code.is_empty() && !existing.pairing_code.is_empty() { existing.pairing_code } else { secrets.pairing_code.clone() },
            provider_api_keys: {
                let mut map = existing.provider_api_keys.clone();
                for (k, v) in &secrets.provider_api_keys {
                    if !v.is_empty() {
                        map.insert(k.clone(), v.clone());
                    }
                }
                map
            },
        },
        Err(_) => secrets.clone(),
    };
    let encoded = serde_json::to_string(&merged)
        .map_err(|error| format!("credential serialization failed: {error}"))?;
    if let Err(keyring_error) = entry(secret_id)?.set_password(&encoded) {
        // OS 凭据管理器写入失败时，回退到本地文件保存，确保 token/API key 不丢失。
        if let Some(path) = fallback_path(secret_id) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::write(&path, &encoded).is_ok() {
                return Ok(());
            }
        }
        return Err(format!("credential write failed: {keyring_error}"));
    }
    // keyring 成功时，也同步一份到 fallback 文件作为冗余备份。
    if let Some(path) = fallback_path(secret_id) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, &encoded);
    }
    Ok(())
}

pub fn delete(secret_id: &str) -> Result<(), String> {
    entry(secret_id)?
        .delete_credential()
        .map_err(|error| format!("credential delete failed: {error}"))
}

fn provider_key(profile: &ProviderProfile, index: usize) -> String {
    if profile.id.is_empty() {
        format!("index-{index}")
    } else {
        profile.id.clone()
    }
}

pub fn extract(config: &GatewayConfig) -> GatewaySecrets {
    let mut provider_api_keys = BTreeMap::new();
    for (index, profile) in config.providers.iter().enumerate() {
        provider_api_keys.insert(provider_key(profile, index), profile.api_key.clone());
    }

    GatewaySecrets {
        api_key: config.api_key.clone(),
        gui_model_key: config.gui_model_key.clone(),
        relay_gateway_token: config.relay_gateway_token.clone(),
        local_auth_token: config.local_auth_token.clone(),
        pairing_code: config.pairing_code.clone(),
        provider_api_keys,
    }
}

pub fn apply(config: &mut GatewayConfig, secrets: &GatewaySecrets) {
    // 凭据管理器中的空值不覆盖 config 中已生成的有效值。
    // 例如第一次启动时 config 已生成随机 local_auth_token，而 keyring 中可能
    // 残留旧记录的空值，直接覆盖会导致 Desktop 前端拿不到 token 无法连接。
    if !secrets.api_key.is_empty() { config.api_key = secrets.api_key.clone(); }
    if !secrets.gui_model_key.is_empty() { config.gui_model_key = secrets.gui_model_key.clone(); }
    if !secrets.relay_gateway_token.is_empty() { config.relay_gateway_token = secrets.relay_gateway_token.clone(); }
    if !secrets.local_auth_token.is_empty() { config.local_auth_token = secrets.local_auth_token.clone(); }
    if !secrets.pairing_code.is_empty() { config.pairing_code = secrets.pairing_code.clone(); }

    for (index, profile) in config.providers.iter_mut().enumerate() {
        // 优先按 profile.id 查找，找不到或值为空则 fallback 到 index-{i}
        // （兼容旧版没有 profile.id、或中途被分配了 UUID 但 secrets 仍用 index-{i}、
        //  或 keyring 中被存了 UUID→"" 空值的场景）
        let key = provider_key(profile, index);
        let value = secrets.provider_api_keys.get(&key).cloned();
        let has_value = value.as_ref().map_or(false, |v| !v.is_empty());
        if !has_value && !profile.id.is_empty() {
            let fallback_key = format!("index-{index}");
            if let Some(fb) = secrets.provider_api_keys.get(&fallback_key) {
                if !fb.is_empty() {
                    profile.api_key = fb.clone();
                    continue;
                }
            }
        }
        profile.api_key = value.unwrap_or_default();
    }
}

pub fn redact(config: &mut GatewayConfig) {
    config.api_key.clear();
    config.gui_model_key.clear();
    config.relay_gateway_token.clear();
    config.local_auth_token.clear();
    config.pairing_code.clear();
    for profile in &mut config.providers {
        profile.api_key.clear();
    }
}
