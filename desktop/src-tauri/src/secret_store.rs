use crate::gateway_manager::{GatewayConfig, ProviderProfile};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

pub fn load(secret_id: &str) -> Result<GatewaySecrets, String> {
    let encoded = entry(secret_id)?
        .get_password()
        .map_err(|error| format!("credential read failed: {error}"))?;
    serde_json::from_str(&encoded)
        .map_err(|error| format!("credential data is invalid: {error}"))
}

pub fn save(secret_id: &str, secrets: &GatewaySecrets) -> Result<(), String> {
    let encoded = serde_json::to_string(secrets)
        .map_err(|error| format!("credential serialization failed: {error}"))?;
    entry(secret_id)?
        .set_password(&encoded)
        .map_err(|error| format!("credential write failed: {error}"))
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
    config.api_key = secrets.api_key.clone();
    config.gui_model_key = secrets.gui_model_key.clone();
    config.relay_gateway_token = secrets.relay_gateway_token.clone();
    config.local_auth_token = secrets.local_auth_token.clone();
    config.pairing_code = secrets.pairing_code.clone();

    for (index, profile) in config.providers.iter_mut().enumerate() {
        let key = provider_key(profile, index);
        profile.api_key = secrets.provider_api_keys.get(&key).cloned().unwrap_or_default();
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
