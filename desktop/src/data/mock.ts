// Type definitions for Hone
// No mock data — all data comes from Tauri IPC or starts empty.

export interface MachineInfo {
  id: string;
  name: string;
  host: string;
  /** SSH port (defaults to 22). Present for SSH-connected machines. */
  port?: number;
  /** Connection method: 'direct' | 'ssh' | 'tunnel'. */
  method?: string;
  status: 'online' | 'busy' | 'offline';
  sessions: number;
  os: string;
  cpu: string;
  /** ISO timestamp of last successful contact, or null if never seen. */
  lastSeen?: string | null;
  /** ISO timestamp of when the machine was added to the registry. */
  addedAt?: string;
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
  /** OpenAI-compatible endpoint. Empty = use provider default. */
  baseUrl?: string;
  /** Display name when provider === 'custom'. */
  customProviderName?: string;
  /** Sampling temperature 0.0–2.0. */
  temperature?: string;
  /** Max output tokens. Empty = provider default. */
  maxTokens?: string;
  gatewayAutoStart: boolean;
  relayUrl: string;
  localPort: string;
  workspaceDir: string;
  logRetention: string;
  browserEnabled: boolean;
  guiModelUrl: string;
  browserHeadless: boolean;
  browserMaxSteps: string;
  buddySpecies?: string;
  guiModelName?: string;
  guiModelKey?: string;
  providers?: ProviderProfile[];
}

export interface GatewayMessage {
  id: string;
  from: 'gateway' | 'user' | 'system';
  textKey?: string;
  text?: string;
  time: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: GatewayMessage[];
  createdAt: number;
  updatedAt: number;
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

// ── 2026 modernized types ──

export interface ProviderProfile {
  id: string;
  name: string;
  kind: 'deepseek' | 'openai' | 'openrouter' | 'custom';
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
  isDefault: boolean;
  fetchedModels?: string[];
  lastFetchError?: string;
}

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: { author?: string; version?: string };
  allowedTools?: string[];
  instructions: string;
  enabled: boolean;
  trigger?: string;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  tools?: number;
  error?: string;
}

// ── Empty defaults (no mock data) ──

export const machines: MachineInfo[] = [];
export const sessions: SessionInfo[] = [];
export const schedulesData: ScheduleInfo[] = [];
export const aiSuggestions: AiSuggestion[] = [];
export const canvasSessions: CanvasSession[] = [];
export const gatewayMessages: GatewayMessage[] = [];
export const chatSessions: ChatSession[] = [];
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
