use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionMethod {
    Local {
        pairing_code: String,
    },
    Ssh {
        host: String,
        port: u16,
        username: String,
    },
    Tunnel {
        host: String,
        port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MachineStatus {
    Online,
    Busy,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineInfo {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub method: ConnectionMethod,
    pub status: MachineStatus,
    pub sessions: u32,
    pub os: String,
    pub cpu: String,
    pub last_seen: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineStats {
    pub machine_id: String,
    pub active_sessions: u32,
    pub tokens_used_today: u32,
    pub cpu_percent: f32,
    pub memory_used_gb: f32,
    pub memory_total_gb: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("Machine not found: {0}")]
    NotFound(String),
    #[allow(dead_code)]
    #[error("Machine already exists: {0}")]
    AlreadyExists(String),
}

// ---------------------------------------------------------------------------
// Persistence helper (internal)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistrySnapshot {
    machines: Vec<MachineInfo>,
    stats: Vec<MachineStats>,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

pub struct MachineRegistry {
    machines: HashMap<String, MachineInfo>,
    stats: HashMap<String, MachineStats>,
    storage_path: PathBuf,
}

impl MachineRegistry {
    pub fn new(storage_path: PathBuf) -> Self {
        Self {
            machines: HashMap::new(),
            stats: HashMap::new(),
            storage_path,
        }
    }

    // -- registration -------------------------------------------------------

    pub fn register(&mut self, mut info: MachineInfo) -> String {
        if info.id.is_empty() {
            info.id = Uuid::new_v4().to_string();
        }
        let id = info.id.clone();
        self.stats.insert(
            id.clone(),
            MachineStats {
                machine_id: id.clone(),
                active_sessions: 0,
                tokens_used_today: 0,
                cpu_percent: 0.0,
                memory_used_gb: 0.0,
                memory_total_gb: 0.0,
            },
        );
        self.machines.insert(id.clone(), info);
        id
    }

    pub fn unregister(&mut self, id: &str) -> Result<(), RegistryError> {
        if self.machines.remove(id).is_none() {
            return Err(RegistryError::NotFound(id.to_string()));
        }
        self.stats.remove(id);
        Ok(())
    }

    // -- queries ------------------------------------------------------------

    pub fn list(&self) -> Vec<&MachineInfo> {
        self.machines.values().collect()
    }

    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<&MachineInfo> {
        self.machines.get(id)
    }

    #[allow(dead_code)]
    pub fn get_mut(&mut self, id: &str) -> Option<&mut MachineInfo> {
        self.machines.get_mut(id)
    }

    // -- status / stats -----------------------------------------------------

    pub fn update_status(&mut self, id: &str, status: MachineStatus) {
        if let Some(m) = self.machines.get_mut(id) {
            m.status = status;
        }
    }

    #[allow(dead_code)]
    pub fn update_stats(&mut self, id: &str, stats: MachineStats) {
        self.stats.insert(id.to_string(), stats);
    }

    #[allow(dead_code)]
    pub fn get_stats(&self, id: &str) -> Option<&MachineStats> {
        self.stats.get(id)
    }

    // -- persistence --------------------------------------------------------

    pub fn save(&self) -> Result<(), std::io::Error> {
        let snapshot = RegistrySnapshot {
            machines: self.machines.values().cloned().collect(),
            stats: self.stats.values().cloned().collect(),
        };
        let json = serde_json::to_string_pretty(&snapshot)?;
        if let Some(parent) = self.storage_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Atomic write: tmp + rename, so a crash mid-write can't corrupt the
        // existing registry file (which would lose all known machines).
        let tmp = self.storage_path.with_extension("json.tmp");
        fs::write(&tmp, &json)?;
        fs::rename(&tmp, &self.storage_path).map_err(|e| {
            // Best-effort cleanup of the temp file on rename failure so we
            // don't leave stale .tmp files behind.
            let _ = fs::remove_file(&tmp);
            e
        })
    }

    #[allow(dead_code)]
    pub fn load(storage_path: PathBuf) -> Result<Self, std::io::Error> {
        let data = fs::read_to_string(&storage_path)?;
        let snapshot: RegistrySnapshot = serde_json::from_str(&data)?;
        let mut machines = HashMap::new();
        for m in snapshot.machines {
            machines.insert(m.id.clone(), m);
        }
        let mut stats = HashMap::new();
        for s in snapshot.stats {
            stats.insert(s.machine_id.clone(), s);
        }
        Ok(Self {
            machines,
            stats,
            storage_path,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_machine() -> MachineInfo {
        MachineInfo {
            id: String::new(),
            name: "test-box".into(),
            host: "192.168.1.10".into(),
            port: 18789,
            method: ConnectionMethod::Ssh {
                host: "192.168.1.10".into(),
                port: 22,
                username: "dev".into(),
            },
            status: MachineStatus::Online,
            sessions: 0,
            os: "linux".into(),
            cpu: "16 cores".into(),
            last_seen: None,
            added_at: "2026-05-14T12:00:00Z".into(),
        }
    }

    #[test]
    fn register_assigns_id() {
        let mut reg = MachineRegistry::new(PathBuf::from("/tmp/test.json"));
        let id = reg.register(test_machine());
        assert!(!id.is_empty());
        assert!(reg.get(&id).is_some());
    }

    #[test]
    fn unregister_unknown_returns_error() {
        let mut reg = MachineRegistry::new(PathBuf::from("/tmp/test.json"));
        let result = reg.unregister("nope");
        assert!(result.is_err());
    }

    #[test]
    fn round_trip_save_load() {
        let mut reg = MachineRegistry::new(PathBuf::from("/tmp/hone_test_registry.json"));
        let id = reg.register(test_machine());
        reg.save().unwrap();

        let loaded = MachineRegistry::load(PathBuf::from("/tmp/hone_test_registry.json")).unwrap();
        assert!(loaded.get(&id).is_some());

        // Cleanup
        let _ = std::fs::remove_file("/tmp/hone_test_registry.json");
    }
}
