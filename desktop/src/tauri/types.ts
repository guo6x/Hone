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
  base_url?: string;
  custom_name?: string;
  temperature?: number;
  max_tokens?: number;
  data_dir?: string;
  workspace_dir?: string;
  browser_enabled?: boolean;
  gui_model_url?: string;
  gui_model_name?: string;
  gui_model_key?: string;
  browser_headless?: boolean;
  browser_max_steps?: number;
  providers?: ProviderProfileConfig[];
}

export interface GatewayConnectionInfo {
  local_port: number;
  local_auth_token: string;
  relay_url: string;
  relay_room: string;
  pairing_id: string;
  pairing_code: string;
  machine_name: string;
}

export interface ProviderProfileConfig {
  id: string;
  name: string;
  kind: string;
  api_key: string;
  base_url: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  enabled: boolean;
  is_default: boolean;
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
