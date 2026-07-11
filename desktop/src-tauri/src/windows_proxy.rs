#[cfg(windows)]
use std::process::Command;

#[cfg(windows)]
const INTERNET_SETTINGS_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[cfg(windows)]
pub fn env_vars() -> Vec<(String, String)> {
    if std::env::var_os("HTTPS_PROXY").is_some()
        || std::env::var_os("https_proxy").is_some()
        || std::env::var_os("HTTP_PROXY").is_some()
        || std::env::var_os("http_proxy").is_some()
    {
        return Vec::new();
    }

    let Some(proxy) = system_proxy_url() else {
        return Vec::new();
    };

    vec![
        ("HTTP_PROXY".to_string(), proxy.clone()),
        ("HTTPS_PROXY".to_string(), proxy.clone()),
        ("ALL_PROXY".to_string(), proxy),
        (
            "NO_PROXY".to_string(),
            "localhost,127.0.0.1,::1".to_string(),
        ),
    ]
}

#[cfg(not(windows))]
pub fn env_vars() -> Vec<(String, String)> {
    Vec::new()
}

pub fn apply_to_command(cmd: &mut std::process::Command) {
    for (key, value) in env_vars() {
        cmd.env(key, value);
    }
}

#[cfg(windows)]
fn system_proxy_url() -> Option<String> {
    if !proxy_enabled()? {
        return None;
    }

    let raw = read_reg_value("ProxyServer")?;
    parse_proxy_server(&raw)
}

#[cfg(windows)]
fn proxy_enabled() -> Option<bool> {
    let raw = read_reg_value("ProxyEnable")?;
    Some(raw.trim().eq_ignore_ascii_case("0x1") || raw.trim() == "1")
}

#[cfg(windows)]
fn read_reg_value(name: &str) -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", INTERNET_SETTINGS_KEY, "/v", name]);
    // Hide console window — this runs on every gateway/CLI spawn path.
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(name) {
            return None;
        }
        trimmed
            .split_whitespace()
            .last()
            .map(|value| value.trim().to_string())
    })
}

#[cfg(windows)]
fn parse_proxy_server(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }

    let endpoint = if value.contains(';') {
        value
            .split(';')
            .find_map(|part| part.strip_prefix("https=").or_else(|| part.strip_prefix("http=")))?
    } else {
        value
    };

    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        Some(endpoint.to_string())
    } else {
        Some(format!("http://{}", endpoint))
    }
}
