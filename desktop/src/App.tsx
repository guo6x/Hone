import { useState, useCallback, useEffect } from 'react';
import { LANG, type Lang } from './i18n/translations';
import { useTheme, type ThemeName } from './hooks/useTheme';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import GatewayChat from './components/GatewayChat';
import ScheduleManager from './components/ScheduleManager';
import CanvasViewer from './components/CanvasViewer';
import WebTaskRunner from './components/WebTaskRunner';
import { SettingsPage } from './components/SettingsPage';
import StatusBar from './components/StatusBar';
import { DevicePairingModal } from './components/DevicePairingModal';
import { useMachines, useDiscovery, useSchedules, isTauri, useTauriConfig, useGateway } from './tauri/useTauri';
import type { DiscoveredGateway } from './tauri/types';
import {
  type MachineInfo,
  type SessionInfo,
  type ScheduleInfo,
  type AiSuggestion,
  type SettingsData,
} from './data/mock';

type ViewName = 'dashboard' | 'gateway' | 'schedule' | 'canvas' | 'webtask' | 'settings';
type PageState = 'loaded' | 'loading' | 'error';

export default function App() {
  const [lang, setLang] = useState<Lang>('zh');
  const { theme, setTheme, cycleTheme } = useTheme();
  const t = LANG[lang];

  // Tauri IPC hooks (falls back to mock when not in Tauri)
  const { machines, addMachine, removeMachine } = useMachines();
  const { gateways: discoveredGateways, scanning, scan } = useDiscovery();
  const { start: ipcGatewayStart } = useGateway();

  // Auto-start Gateway daemon on app launch
  useEffect(() => {
    const autoStart = settings.gatewayAutoStart;
    if (autoStart && isTauri()) {
      ipcGatewayStart(settings.workspaceDir || 'hone', settings.relayUrl);
    }
  }, []); // only on mount

  // Dashboard state
  const [activeMachine, setActiveMachine] = useState<string | null>(null);
  useEffect(() => {
    if (machines.length > 0 && !activeMachine) {
      setActiveMachine(machines[0].id);
    }
  }, [machines, activeMachine]);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('elapsed');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [pageState, setPageState] = useState<PageState>('loaded');

  // View
  const [activeView, setActiveView] = useState<ViewName>('dashboard');

  // Schedule state (persisted via Tauri IPC)
  const { schedules, save: saveSchedules } = useSchedules();
  const [scheduleFilter, setScheduleFilter] = useState('all');
  const [scheduleSearch, setScheduleSearch] = useState('');
  const [scheduleModal, setScheduleModal] = useState<{ open: boolean; editing: ScheduleInfo | null }>({ open: false, editing: null });
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);

  // Settings — Tauri backend is authoritative for GatewayConfig fields.
  // localStorage only stores non-GatewayConfig fields (provider, apiKey, model, etc.)
  const GATEWAY_DEFAULTS = {
    relayUrl: 'wss://hone-relay.marsailleippi79.workers.dev/connect/default',
    localPort: '18789',
    gatewayAutoStart: true,
  } as const;

  const { config: tauriConfig, save: saveTauriConfig } = useTauriConfig();

  const [settings, setSettings] = useState<SettingsData>(() => {
    const defaults: SettingsData = {
      provider: 'deepseek',
      apiKey: '',
      model: 'deepseek-v3',
      ...GATEWAY_DEFAULTS,
      workspaceDir: '',
      logRetention: '30',
      browserEnabled: false,
      guiModelUrl: '',
      browserHeadless: true,
      browserMaxSteps: '15',
    };
    // Load extra fields from localStorage (never GatewayConfig fields)
    try {
      const saved = localStorage.getItem('hone-settings-extra');
      if (saved) {
        const { provider, apiKey, model, workspaceDir, logRetention, browserEnabled, guiModelUrl, browserHeadless, browserMaxSteps } = JSON.parse(saved);
        if (provider) defaults.provider = provider;
        if (apiKey) defaults.apiKey = apiKey;
        if (model) defaults.model = model;
        if (workspaceDir) defaults.workspaceDir = workspaceDir;
        if (logRetention) defaults.logRetention = logRetention;
        if (browserEnabled !== undefined) defaults.browserEnabled = browserEnabled;
        if (guiModelUrl !== undefined) defaults.guiModelUrl = guiModelUrl;
        if (browserHeadless !== undefined) defaults.browserHeadless = browserHeadless;
        if (browserMaxSteps !== undefined) defaults.browserMaxSteps = browserMaxSteps;
      }
    } catch {}
    return defaults;
  });

  // Merge Tauri config (authoritative) into settings when it loads
  useEffect(() => {
    if (tauriConfig) {
      setSettings(prev => ({
        ...prev,
        // Tauri is the authority — never fall back to prev (which may be stale localStorage)
        relayUrl: tauriConfig.relay_url || GATEWAY_DEFAULTS.relayUrl,
        localPort: String(tauriConfig.local_port || GATEWAY_DEFAULTS.localPort),
        gatewayAutoStart: tauriConfig.auto_start ?? GATEWAY_DEFAULTS.gatewayAutoStart,
        workspaceDir: (tauriConfig as any).data_dir || prev.workspaceDir,
      }));
    }
  }, [tauriConfig]);

  // Persist: all settings → Tauri (authoritative), localStorage as fallback
  const persistSettings = useCallback((next: SettingsData) => {
    // localStorage fallback for browser-only mode
    try {
      localStorage.setItem('hone-settings-extra', JSON.stringify({
        provider: next.provider,
        apiKey: next.apiKey,
        model: next.model,
        workspaceDir: next.workspaceDir,
        logRetention: next.logRetention,
        browserEnabled: next.browserEnabled,
        guiModelUrl: next.guiModelUrl,
        browserHeadless: next.browserHeadless,
        browserMaxSteps: next.browserMaxSteps,
      }));
    } catch {}
    // Tauri (all fields including provider settings)
    if (isTauri()) {
      saveTauriConfig({
        relay_url: next.relayUrl,
        local_port: parseInt(next.localPort, 10) || 18789,
        auto_start: next.gatewayAutoStart,
        machine_name: (tauriConfig?.machine_name) || '',
        provider: next.provider,
        api_key: next.apiKey,
        model: next.model,
        browser_enabled: next.browserEnabled,
        gui_model_url: next.guiModelUrl,
        browser_headless: next.browserHeadless,
        browser_max_steps: parseInt(next.browserMaxSteps, 10) || 15,
      }, next.workspaceDir || '');
    }
  }, [saveTauriConfig, tauriConfig]);

  const updateSettings = useCallback((next: SettingsData) => {
    setSettings(next);
    persistSettings(next);
  }, [persistSettings]);

  // Pairing modal
  const [pairingModal, setPairingModal] = useState(false);

  const handleToggleSchedule = useCallback((id: string) => {
    const next = schedules.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
    saveSchedules(next);
  }, [schedules, saveSchedules]);

  const handleEditSchedule = useCallback((schedule: ScheduleInfo) => {
    setScheduleModal({ open: true, editing: schedule });
  }, []);

  const handleDeleteSchedule = useCallback((id: string) => {
    saveSchedules(schedules.filter(s => s.id !== id));
  }, [schedules, saveSchedules]);

  const handleAcceptSuggestion = useCallback((ai: AiSuggestion) => {
    setScheduleModal({ open: true, editing: null });
    setSuggestions(prev => prev.filter(s => s.id !== ai.id));
  }, []);

  const handleDismissSuggestion = useCallback((id: string) => {
    setSuggestions(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleSaveSchedule = useCallback((data: Partial<ScheduleInfo>) => {
    if (scheduleModal.editing) {
      const next = schedules.map(s => s.id === scheduleModal.editing!.id ? { ...s, ...data } : s);
      saveSchedules(next);
    } else {
      const newId = 'sc' + Date.now();
      const next = [...schedules, { ...data, id: newId, enabled: true, lastStatus: null, lastRun: null } as ScheduleInfo];
      saveSchedules(next);
    }
  }, [scheduleModal.editing]);

  return (
    <div style={styles.appShell}>
      <div style={styles.topBar}>
        <span style={styles.topBarBrand}>Hone</span>
        <span style={styles.topBarVersion}>v0.2.1-alpha</span>
      </div>

      <div style={styles.body}>
        <Sidebar
          machines={machines}
          activeMachine={activeMachine}
          setActiveMachine={setActiveMachine}
          lang={lang}
          setLang={setLang}
          theme={theme}
          cycleTheme={cycleTheme}
          onAddMachine={() => setPairingModal(true)}
        />

        <div style={styles.main}>
          <div style={styles.viewTabs}>
            {(['dashboard', 'gateway', 'schedule', 'canvas', 'webtask', 'settings'] as ViewName[]).map(v => (
              <button
                key={v}
                style={styles.viewTab(activeView === v)}
                onClick={() => setActiveView(v)}
              >
                {t[`tab${v.charAt(0).toUpperCase() + v.slice(1)}` as keyof typeof t]}
              </button>
            ))}
          </div>

          {activeView === 'dashboard' && (
            pageState === 'loading' ? (
              <Dashboard.Loading lang={lang} />
            ) : pageState === 'error' ? (
              <Dashboard.Error lang={lang} onRetry={() => setPageState('loaded')} />
            ) : machines.length > 0 ? (
              <Dashboard
                lang={lang}
                machines={machines}
                sessions={[]}
                filter={filter}
                setFilter={setFilter}
                sortBy={sortBy}
                setSortBy={setSortBy}
                sortDir={sortDir}
                setSortDir={setSortDir}
                search={search}
                setSearch={setSearch}
              />
            ) : (
              <Dashboard.Empty lang={lang} onAddMachine={() => setPairingModal(true)} />
            )
          )}

          {activeView === 'gateway' && (
            <GatewayChat
              lang={lang}
              theme={theme}
              honePath={settings.workspaceDir || ''}
              relayUrl={settings.relayUrl}
            />
          )}

          {activeView === 'schedule' && (
            <ScheduleManager
              schedules={schedules}
              onToggle={handleToggleSchedule}
              onEdit={handleEditSchedule}
              onDelete={handleDeleteSchedule}
              filter={scheduleFilter}
              setFilter={setScheduleFilter}
              search={scheduleSearch}
              setSearch={setScheduleSearch}
              onNew={() => setScheduleModal({ open: true, editing: null })}
              suggestions={suggestions}
              onAcceptSuggestion={handleAcceptSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              lang={lang}
            />
          )}

          {activeView === 'settings' && (
            <SettingsPage
              settings={settings}
              setSettings={updateSettings}
              lang={lang}
              theme={theme}
              setTheme={setTheme}
            />
          )}

          {activeView === 'canvas' && (
            <CanvasViewer
              lang={lang}
              sessions={[]}
            />
          )}

          {activeView === 'webtask' && (
            <WebTaskRunner
              lang={lang}
              relayUrl={settings.relayUrl}
            />
          )}

          <StatusBar lang={lang} statusBar={{ uptime: '—', latency: '—', tokensToday: '0', lastBackup: '—' }} />

          {pairingModal && (
            <DevicePairingModal
              lang={lang}
              onClose={() => setPairingModal(false)}
              onPaired={async (info: { name: string; method: string; host: string; port: number; code: string; username?: string }) => {
                if (isTauri() && info) {
                  const now = new Date().toISOString();
                  const method: { Local: { pairing_code: string } } | { Ssh: { host: string; port: number; username: string } } | { Tunnel: { host: string; port: number } } =
                    info.method === 'local'
                      ? { Local: { pairing_code: info.code || '' } }
                      : info.method === 'ssh'
                      ? { Ssh: { host: info.host, port: info.port, username: info.username || '' } }
                      : { Tunnel: { host: info.host, port: info.port } };
                  await addMachine({
                    name: info.name,
                    host: info.host,
                    port: info.port,
                    method,
                    status: 'Online' as const,
                    sessions: 0,
                    os: '',
                    cpu: '',
                    last_seen: now,
                    added_at: now,
                  });
                }
                setPairingModal(false);
              }}
              useTauri={isTauri()}
              discoveredGateways={discoveredGateways}
              onScan={scan}
              scanning={scanning}
            />
          )}

          {scheduleModal.open && (
            <ScheduleManager.Modal
              modal={scheduleModal}
              onClose={() => setScheduleModal({ open: false, editing: null })}
              onSave={handleSaveSchedule}
              lang={lang}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  appShell: {
    display: 'flex', flexDirection: 'column', height: '100vh',
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    overflow: 'hidden',
  },
  topBar: {
    height: 36, minHeight: 36, display: 'flex', alignItems: 'center',
    padding: '0 14px', gap: 6, background: 'var(--hone-surface)',
    borderBottom: '1px solid var(--hone-border)',
  },
  topBarBrand: {
    fontSize: 13, fontWeight: 700, color: 'var(--hone-accent)',
    letterSpacing: '-0.01em',
  },
  topBarVersion: {
    fontSize: 10, color: 'var(--hone-muted)',
  },
  body: {
    flex: 1, display: 'flex', overflow: 'hidden',
  },
  main: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  viewTabs: {
    display: 'flex', gap: 0, padding: '0 16px',
    background: 'var(--hone-surface)', flexShrink: 0,
    borderBottom: '1px solid var(--hone-border)',
  },
  viewTab: (active: boolean): React.CSSProperties => ({
    background: 'transparent', border: 'none',
    color: active ? 'var(--hone-accent)' : 'var(--hone-muted)',
    padding: '8px 16px', fontSize: 12, fontWeight: active ? 600 : 400,
    cursor: 'pointer', borderBottom: active ? '2px solid var(--hone-accent)' : '2px solid transparent',
    marginBottom: -1,
  }),
};
