/**
 * Typed wrappers around @tauri-apps/api invoke().
 * Every function maps 1:1 to a Rust #[tauri::command] in commands.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  GatewayConfig,
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

// ── Settings ──

export function getConfig(): Promise<GatewayConfig> {
  return invoke('get_config');
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
