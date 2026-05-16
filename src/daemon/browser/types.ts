/**
 * Browser automation types for Hone Gateway.
 * Playwright + vision-based GUI agent model integration.
 */

export interface BrowserConfig {
  enabled: boolean
  headless: boolean
  guiModelUrl: string        // e.g. "http://localhost:8000/v1/chat/completions"
  guiModelName: string        // e.g. "ui-tars-7b"
  maxSteps: number            // max agent loop iterations (default: 15)
  screenshotQuality: number   // JPEG quality 1-100 (default: 75)
  dataDir: string             // ~/.hone/browser
  defaultTimeout: number      // ms (default: 30000)
}

export interface BrowserState {
  url: string
  title: string
  screenshotBase64: string
  domText: string             // extracted visible text for DOM fallback
}

export interface GUIAction {
  action: 'click' | 'type' | 'scroll' | 'press' | 'navigate' | 'wait' | 'done' | 'fail'
  selector?: string           // CSS selector
  text?: string               // For type action
  key?: string                // For press action
  url?: string                // For navigate action
  coordinates?: { x: number; y: number }
  waitMs?: number
  reason?: string             // Agent's reasoning
}

export interface GUITask {
  id: string
  profileName: string         // which browser profile to use
  task: string                // natural language: "Post a tweet saying hello"
  startUrl?: string           // optional starting URL
  riskLevel: 'low' | 'medium' | 'high'
  maxSteps?: number
  credentials?: CredentialRef[] // credentials to inject
}

export interface GUITaskResult {
  taskId: string
  status: 'success' | 'failed' | 'timeout' | 'cancelled'
  steps: GUIStep[]
  finalUrl?: string
  extractedData?: Record<string, unknown>
  error?: string
  durationMs: number
}

export interface GUIStep {
  stepNumber: number
  action: GUIAction
  screenshotBase64?: string
  timestamp: string
  durationMs: number
}

export interface CredentialEntry {
  id: string
  service: string             // "twitter", "github", etc.
  username: string
  password: string            // encrypted at rest (base64 for now)
  notes: string
  createdAt: number
}

export interface CredentialRef {
  credentialId: string
  injectAs: 'username_password' | 'cookie' | 'token'
}

export interface BrowserProfile {
  name: string
  startUrl: string
  storageStatePath: string
  createdAt: number
}

/** BrowserAgent public interface */
export interface BrowserAgent {
  executeTask(task: GUITask): Promise<GUITaskResult>
  navigate(profileName: string, url: string): Promise<BrowserState>
  screenshot(profileName: string): Promise<string>
  extract(profileName: string, selector: string): Promise<string>
  listProfiles(): string[]
  shutdown(): Promise<void>
}
