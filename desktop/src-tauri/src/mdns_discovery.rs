use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredGateway {
    pub host: String,
    pub port: u16,
    pub name: String,
    pub instance_id: String,
    pub version: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("mDNS service error: {0}")]
    ServiceError(String),
    #[error("Timeout")]
    Timeout,
}

pub struct MdnsDiscovery {
    service_type: String,
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl MdnsDiscovery {
    pub fn new() -> Self {
        Self {
            service_type: "_hone-gw._tcp.local.".to_string(),
            cancel_tx: None,
        }
    }

    pub fn browse(
        &mut self,
        timeout: Duration,
    ) -> Result<mpsc::Receiver<DiscoveredGateway>, DiscoveryError> {
        use mdns_sd::{ServiceDaemon, ServiceEvent};

        let (tx, rx) = mpsc::channel(32);
        let daemon = ServiceDaemon::new()
            .map_err(|e| DiscoveryError::ServiceError(e.to_string()))?;

        let receiver = daemon
            .browse(&self.service_type)
            .map_err(|e| DiscoveryError::ServiceError(e.to_string()))?;

        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        self.cancel_tx = Some(cancel_tx);

        tokio::spawn(async move {
            let timeout_fut = tokio::time::sleep(timeout);
            tokio::pin!(timeout_fut);
            let mut cancel_rx = cancel_rx;

            loop {
                tokio::select! {
                    event = receiver.recv_async() => {
                        match event {
                            Ok(ServiceEvent::ServiceResolved(info)) => {
                                let host = info.get_addresses().iter()
                                    .next()
                                    .map(|a| a.to_string())
                                    .unwrap_or_else(|| "unknown".to_string());

                                let gateway = DiscoveredGateway {
                                    host,
                                    port: info.get_port(),
                                    name: info.get_fullname().trim_end_matches(
                                        &format!(".{}", "_hone-gw._tcp.local."),
                                    ).to_string(),
                                    instance_id: info
                                        .get_property_val("id")
                                        .unwrap_or_default()
                                        .map(|v| String::from_utf8_lossy(v).to_string())
                                        .unwrap_or_default(),
                                    version: info
                                        .get_property_val("version")
                                        .unwrap_or_default()
                                        .map(|v| String::from_utf8_lossy(v).to_string())
                                        .unwrap_or_default(),
                                };

                                let _ = tx.send(gateway).await;
                            }
                            Ok(ServiceEvent::ServiceRemoved(_kind, fullname)) => {
                                log::info!("Gateway removed: {}", fullname);
                            }
                            Err(e) => {
                                log::error!("mDNS browse error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ = &mut cancel_rx => {
                        log::info!("mDNS browse cancelled");
                        break;
                    }
                    _ = &mut timeout_fut => {
                        log::info!("mDNS browse timeout reached");
                        break;
                    }
                }
            }

            // Shutdown the daemon when done
            if let Err(e) = daemon.shutdown() {
                log::warn!("Error shutting down mDNS daemon: {}", e);
            }
        });

        Ok(rx)
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Default for MdnsDiscovery {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discovery_default() {
        let d = MdnsDiscovery::new();
        assert!(d.cancel_tx.is_none());
    }

    #[test]
    fn test_discovered_gateway_serialization() {
        let gw = DiscoveredGateway {
            host: "192.168.1.100".into(),
            port: 9876,
            name: "hone-gw-local".into(),
            instance_id: "abc-123".into(),
            version: "0.2.1".into(),
        };
        let json = serde_json::to_string(&gw).unwrap();
        let parsed: DiscoveredGateway = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.host, "192.168.1.100");
        assert_eq!(parsed.port, 9876);
    }
}
