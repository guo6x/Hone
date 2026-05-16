/** Types mirroring Rust struct serialization from the Tauri backend. */

// ── Gateway ──

export interface GatewayConfig {
  relay_url: string;
  local_port: number;
  auto_start: boolean;
  machine_name: string;
  provider?: string;
  api_key?: string;
  model?: string;
  data_dir?: string;
}

export type GatewayStatus =
  | 'Stopped'
  | 'Starting'
  | 'Running'
  | 'Stopping'
  | { Error: string };

// ── Machines ──

export type ConnectionMethod =
  | { Local: { pairing_code: string } }
  | { Ssh: { host: string; port: number; username: string } }
  | { Tunnel: { host: string; port: number } };

export type MachineStatus = 'Online' | 'Busy' | 'Offline';

export interface MachineInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  method: ConnectionMethod;
  status: MachineStatus;
  sessions: number;
  os: string;
  cpu: string;
  last_seen: string | null;
  added_at: string;
}

export interface MachineStats {
  machine_id: string;
  active_sessions: number;
  tokens_used_today: number;
  cpu_percent: number;
  memory_used_gb: number;
  memory_total_gb: number;
}

// ── Discovery ──

export interface DiscoveredGateway {
  host: string;
  port: number;
  name: string;
  instance_id: string;
  version: string;
}

// ── SSH ──

export type SshAuth =
  | { Password: string }
  | { Key: { path: string; passphrase: string | null } }
  | 'Agent';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
}
