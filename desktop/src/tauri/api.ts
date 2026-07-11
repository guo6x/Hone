/**
 * Typed wrappers around @tauri-apps/api invoke().
 * Every function maps 1:1 to a Rust #[tauri::command] in commands.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  GatewayConfig,
  GatewayConnectionInfo,
  GatewayStatus,
  MachineInfo,
  DiscoveredGateway,
  SshConfig,
} from './types';

// ── Gateway ──

export function gatewayStart(honePath: string, relayUrl?: string): Promise<string> {
  return invoke('gateway_start', { honePath, relayUrl });
}

export function gatewayStop(): Promise<string> {
  return invoke('gateway_stop');
}

export function gatewayStatus(): Promise<GatewayStatus> {
  return invoke('gateway_status');
}

export function gatewayUptime(): Promise<number | null> {
  return invoke('gateway_uptime');
}

// ── Machines ──

export function machinesList(): Promise<MachineInfo[]> {
  return invoke('machines_list');
}

export function machineAdd(info: Omit<MachineInfo, 'id'> & { id?: string }): Promise<string> {
  return invoke('machine_add', { info });
}

export function machineRemove(id: string): Promise<void> {
  return invoke('machine_remove', { id });
}

export function machineUpdateStatus(id: string, status: string): Promise<void> {
  return invoke('machine_update_status', { id, status });
}

// ── Discovery ──

export function discoverGateways(): Promise<DiscoveredGateway[]> {
  return invoke('discover_gateways');
}

// ── SSH ──

export function sshConnect(config: SshConfig): Promise<string> {
  return invoke('ssh_connect', { config });
}

export function sshDisconnect(): Promise<void> {
  return invoke('ssh_disconnect');
}

export function sshExecute(command: string): Promise<string> {
  return invoke('ssh_execute', { command });
}

// ── Hone path ──

export function getHonePath(): Promise<string | null> {
  return invoke('get_hone_path');
}

export function setHonePath(newPath: string): Promise<void> {
  return invoke('set_hone_path', { newPath });
}

// ── Local CLI instances (auto-discovered) ──

export interface LocalCliInstance {
  pid: number;
  cwd: string;
  machine_name: string;
  os: string;
  version: string;
  mode: string;
  started_at: string;
}

export function localCliInstancesList(): Promise<LocalCliInstance[]> {
  return invoke('local_cli_instances_list');
}

// ── CLI Task Workspace ──

/** Spawn a one-shot CLI task in a working directory. Returns the task_id.
 * Listen for `cli_task_chunk_<task_id>` and `cli_task_done_<task_id>` events. */
export function cliTaskRun(cwd: string, task: string): Promise<string> {
  return invoke('cli_task_run', { cwd, task });
}

// ── Local CLI pairing ──

export interface LocalPairResult {
  ok: boolean;
  token?: string;
  machine_name?: string;
  machine_id?: string;
  os?: string;
  cwd?: string;
  pid?: number;
  version?: string;
  error?: string;
}

export function pairWithLocalCli(host: string, port: number, code: string): Promise<LocalPairResult> {
  return invoke('pair_with_local_cli', { input: { host, port, code } });
}

// ── Provider connectivity test ──

export interface TestProviderInput {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function testProvider(input: TestProviderInput): Promise<string> {
  return invoke('test_provider', {
    input: {
      provider: input.provider,
      api_key: input.apiKey,
      base_url: input.baseUrl,
      model: input.model,
    },
  });
}

// ── Settings ──

export function getConfig(): Promise<GatewayConfig> {
  return invoke('get_config');
}

export function gatewayConnectionInfo(): Promise<GatewayConnectionInfo> {
  return invoke('gateway_connection_info');
}

export function mobilePairingRotate(): Promise<GatewayConnectionInfo> {
  return invoke('mobile_pairing_rotate');
}

export function saveConfig(config: GatewayConfig, honePath: string): Promise<void> {
  return invoke('save_config', { config, honePath });
}

// ── Schedules ──

export interface ScheduleInfo {
  id: string;
  title: string;
  desc: string;
  trigger: 'cron' | 'interval' | 'once';
  cron: string;
  triggerLabel: string;
  nextRun: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: 'success' | 'fail' | null;
  delivery: 'desktop' | 'cli' | 'session';
}

export function schedulesList(): Promise<ScheduleInfo[]> {
  return invoke('schedules_list');
}

export function schedulesSave(schedules: ScheduleInfo[]): Promise<void> {
  return invoke('schedules_save', { schedules });
}

// ── Canvas ──

export interface CanvasSessionInfo {
  id: string;
  name: string;
  modified_at: string;
}

export interface CanvasDocumentInfo extends CanvasSessionInfo {
  content: string;
}

export function canvasSessionsList(): Promise<CanvasSessionInfo[]> {
  return invoke('canvas_sessions_list');
}

export function canvasDocumentsList(): Promise<CanvasDocumentInfo[]> {
  return invoke('canvas_documents_list');
}

// ── Desktop-managed user data ──

export interface SkillSyncInfo {
  name: string;
  desc: string;
  descEn: string;
  trigger: string;
  enabled: boolean;
}

export interface McpSyncInfo {
  name: string;
  url: string;
}

export function syncSkills(skills: SkillSyncInfo[]): Promise<string> {
  return invoke('settings_sync_skills', { skills });
}

export function syncMcps(mcps: McpSyncInfo[]): Promise<string> {
  return invoke('settings_sync_mcps', { mcps });
}

export function clearUserData(): Promise<string> {
  return invoke('settings_clear_user_data');
}

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

// ── Scan local skills ──

export function scanLocalSkills(customPath?: string): Promise<SkillConfigV2[]> {
  return invoke('skills_scan_local', { customPath: customPath ?? null });
}
