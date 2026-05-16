// Type definitions for Hone Desktop
// No mock data — all data comes from Tauri IPC or starts empty.

export interface MachineInfo {
  id: string;
  name: string;
  host: string;
  status: 'online' | 'busy' | 'offline';
  sessions: number;
  os: string;
  cpu: string;
}

export interface SessionInfo {
  id: string;
  machineId: string;
  machineName: string;
  status: 'live' | 'idle' | 'done';
  task: string;
  tokensUsed: string;
  elapsed: string;
  sessionId: string;
}

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

export interface AiSuggestion {
  id: string;
  pattern: string;
  patternEn: string;
  acceptLabel: string;
  acceptLabelEn: string;
  dismissLabel: string;
  dismissLabelEn: string;
}

export interface CanvasSession {
  id: string;
  name: string;
  host: string;
}

export interface SettingsData {
  provider: string;
  apiKey: string;
  model: string;
  gatewayAutoStart: boolean;
  relayUrl: string;
  localPort: string;
  workspaceDir: string;
  logRetention: string;
  browserEnabled: boolean;
  guiModelUrl: string;
  browserHeadless: boolean;
  browserMaxSteps: string;
}

export interface GatewayMessage {
  id: string;
  from: 'gateway' | 'user' | 'system';
  textKey?: string;
  text?: string;
  time: string;
}

export interface GatewayStatus {
  status: 'online' | 'offline' | 'thinking' | 'starting' | 'stopping' | 'reconnecting';
  uptime: string;
  version: string;
}

export interface StatusBarData {
  uptime: string;
  latency: string;
  tokensToday: string;
  lastBackup: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  desc: string;
  descEn: string;
  trigger: string;
  enabled: boolean;
}

export interface McpInfo {
  id: string;
  name: string;
  url: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: number;
  config: string;
}

// ── Empty defaults (no mock data) ──

export const machines: MachineInfo[] = [];
export const sessions: SessionInfo[] = [];
export const schedulesData: ScheduleInfo[] = [];
export const aiSuggestions: AiSuggestion[] = [];
export const canvasSessions: CanvasSession[] = [];
export const gatewayMessages: GatewayMessage[] = [];
export const skillsMock: SkillInfo[] = [];
export const mcpMock: McpInfo[] = [];

export const statusBarData: StatusBarData = {
  uptime: '—',
  latency: '—',
  tokensToday: '0',
  lastBackup: '—',
};

export const gatewayStatusData: GatewayStatus = {
  status: 'offline',
  uptime: '—',
  version: '—',
};

export const canvasDemoHTML = '';
