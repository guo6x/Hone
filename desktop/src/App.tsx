import { useState, useCallback, useEffect } from 'react';
import { LANG, type Lang } from './i18n/translations';
import { useTheme, type ThemeName } from './hooks/useTheme';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import GatewayChat from './components/GatewayChat';
import ScheduleManager from './components/ScheduleManager';
import CanvasViewer from './components/CanvasViewer';
import CliWorkspace from './components/CliWorkspace';
import WatchPanel from './components/WatchPanel';
import { SettingsPage } from './components/SettingsPage';
import StatusBar from './components/StatusBar';
import HoneBuddy, { BuddyState } from './components/HoneBuddy';
import { DevicePairingModal } from './components/DevicePairingModal';
import { useMachines, useDiscovery, useSchedules, isTauri, useTauriConfig, useGateway, useHonePath } from './tauri/useTauri';
import { useGatewayConnection } from './hooks/useGatewayConnection';
import type { DiscoveredGateway } from './tauri/types';
import {
  type MachineInfo,
  type SessionInfo,
  type ScheduleInfo,
  type AiSuggestion,
  type SettingsData,
  type StatusBarData,
} from './data/mock';

type ViewName = 'dashboard' | 'gateway' | 'workspace' | 'watch' | 'schedule' | 'canvas' | 'settings';
type PageState = 'loaded' | 'loading' | 'error';

export default function App() {
  const [lang, setLang] = useState<Lang>('zh');
  const { theme, setTheme, cycleTheme } = useTheme();
  const t = LANG[lang];

  // Tauri IPC hooks (falls back to mock when not in Tauri)
  const { machines, addMachine, removeMachine } = useMachines();
  const { gateways: discoveredGateways, scanning, scan } = useDiscovery();
  const { start: ipcGatewayStart } = useGateway();
  const { honePath: detectedHonePath } = useHonePath();

  // ── Auto-discovered local CLI instances (same-machine, no pairing needed) ─
  // Each `hone` CLI process drops ~/.hone/instances/<pid>.json on startup;
  // Tauri scans the dir, prunes dead PIDs, returns alive ones. Refreshed every 5s
  // so opening/closing a CLI shows up live.
  const [localCliMachines, setLocalCliMachines] = useState<MachineInfo[]>([]);
  // Keep the raw CLI instance data alongside the mapped MachineInfo so the
  // dashboard can render rich per-CLI cards (pid, mode, cwd, uptime).
  const [cliInstances, setCliInstances] = useState<any[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const { localCliInstancesList } = await import('./tauri/api');
        const list = await localCliInstancesList();
        if (cancelled) return;
        setCliInstances(list);
        const mapped: MachineInfo[] = list.map(inst => {
          // Take the last path segment as a short label
          const cwdParts = inst.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
          const folder = cwdParts[cwdParts.length - 1] || inst.cwd;
          return {
            id: `local-cli-${inst.pid}`,
            name: inst.mode === 'gateway' ? `${inst.machine_name} · Gateway`
                : inst.mode === 'pair' ? `${inst.machine_name} · Pair`
                : `${inst.machine_name} · ${folder}`,
            host: '127.0.0.1',
            status: 'online' as const,
            sessions: 0,
            os: inst.os,
            cpu: `pid ${inst.pid}`,
          };
        });
        setLocalCliMachines(mapped);
      } catch {}
    };
    refresh();
    const tt = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(tt); };
  }, []);

  // Combined: persistently added machines + auto-discovered local CLI processes
  const allMachines = [...machines, ...localCliMachines];

  // Dashboard state
  const [activeMachine, setActiveMachine] = useState<string | null>(null);
  useEffect(() => {
    if (allMachines.length > 0 && !activeMachine) {
      setActiveMachine(allMachines[0].id);
    }
  }, [allMachines, activeMachine]);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('elapsed');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [pageState, setPageState] = useState<PageState>('loaded');

  // View
  const [activeView, setActiveView] = useState<ViewName>('dashboard');

  // Lifted workspaces state for CliWorkspace and click-to-open PTY terminal
  const [workspaces, setWorkspaces] = useState<any[]>(() => {
    try {
      const raw = localStorage.getItem('hone-workspaces-v2');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [activeWsId, setActiveWsId] = useState<string | null>(() => workspaces[0]?.id || null);

  useEffect(() => {
    try {
      localStorage.setItem('hone-workspaces-v2', JSON.stringify(workspaces));
    } catch {}
  }, [workspaces]);

  const openWorkspace = useCallback((cwd: string) => {
    let ws = workspaces.find(w => w.cwd === cwd);
    if (!ws) {
      ws = {
        id: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        cwd: cwd,
        label: cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || cwd,
      };
      setWorkspaces(prev => [...prev, ws!]);
    }
    setActiveWsId(ws.id);
    setActiveView('workspace');
  }, [workspaces]);

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
      model: 'deepseek-chat',
      baseUrl: '',
      customProviderName: '',
      temperature: '',
      maxTokens: '',
      ...GATEWAY_DEFAULTS,
      workspaceDir: '', // Will be updated by Tauri config or manual user setting
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
        const parsed = JSON.parse(saved);
        const keys: (keyof SettingsData)[] = [
          'provider', 'apiKey', 'model', 'baseUrl', 'customProviderName',
          'temperature', 'maxTokens', 'workspaceDir', 'logRetention',
          'browserEnabled', 'guiModelUrl', 'browserHeadless', 'browserMaxSteps',
          'buddySpecies',
        ];
        for (const k of keys) {
          if (parsed[k] !== undefined) (defaults as any)[k] = parsed[k];
        }
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
        // workspaceDir is where dist/cli.js lives. Prefer the user's saved value,
        // otherwise fall back to the auto-detected hone project path.
        workspaceDir: prev.workspaceDir || detectedHonePath || '',
      }));
    }
  }, [tauriConfig, detectedHonePath]);

  // Auto-start Gateway daemon after config and hone path resolve
  useEffect(() => {
    if (!tauriConfig) return;
    if (!isTauri()) return;

    const autoStart = tauriConfig.auto_start ?? true;
    if (!autoStart) return;

    const honePath = settings.workspaceDir || detectedHonePath || '';
    if (!honePath) return;

    const relayUrl = tauriConfig.relay_url || 'wss://hone-relay.marsailleippi79.workers.dev/connect/default';
    ipcGatewayStart(honePath, relayUrl).catch(e => {
      console.error("Auto-start gateway failed:", e);
    });
  }, [tauriConfig, detectedHonePath, settings.workspaceDir]);

  // Persist: all settings → Tauri (authoritative), localStorage as fallback
  const persistSettings = useCallback((next: SettingsData) => {
    // localStorage fallback for browser-only mode
    try {
      localStorage.setItem('hone-settings-extra', JSON.stringify({
        provider: next.provider,
        apiKey: next.apiKey,
        model: next.model,
        baseUrl: next.baseUrl,
        customProviderName: next.customProviderName,
        temperature: next.temperature,
        maxTokens: next.maxTokens,
        workspaceDir: next.workspaceDir,
        logRetention: next.logRetention,
        browserEnabled: next.browserEnabled,
        guiModelUrl: next.guiModelUrl,
        guiModelName: (next as any).guiModelName || '',
        guiModelKey: (next as any).guiModelKey || '',
        browserHeadless: next.browserHeadless,
        browserMaxSteps: next.browserMaxSteps,
        buddySpecies: next.buddySpecies,
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
        base_url: next.baseUrl || '',
        custom_name: next.customProviderName || '',
        temperature: parseFloat(next.temperature || '') || 0,
        max_tokens: parseInt(next.maxTokens || '', 10) || 0,
        browser_enabled: next.browserEnabled,
        gui_model_url: next.guiModelUrl,
        gui_model_name: (next as any).guiModelName || '',
        gui_model_key: (next as any).guiModelKey || '',
        browser_headless: next.browserHeadless,
        browser_max_steps: parseInt(next.browserMaxSteps, 10) || 15,
      } as any, next.workspaceDir || '');
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

  // ── Global gateway WebSocket connection (shared across all tabs) ────────
  const connection = useGatewayConnection({
    relayUrl: settings.relayUrl,
    enabled: !!settings.relayUrl,
  });

  // ── Active sessions derived from task events ────────────────────────────
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // ── StatusBar tokensToday: increments with each task complete ──────────
  const [tokensToday, setTokensToday] = useState<number>(0);

  // Subscribe to gateway events to maintain sessions / suggestions
  useEffect(() => {
    const unsub = connection.subscribe((msg) => {
      switch (msg.type) {
        case 'schedule_suggestion': {
          // Convert daemon-side suggestion into AiSuggestion for the UI
          const id = String((msg as any).id || `sg_${Date.now()}`);
          const text = String((msg as any).text || '');
          setSuggestions(prev => {
            if (prev.find(s => s.id === id)) return prev;
            const ai: AiSuggestion = {
              id,
              pattern: text,
              patternEn: text,
              acceptLabel: '采用',
              acceptLabelEn: 'Accept',
              dismissLabel: '忽略',
              dismissLabelEn: 'Dismiss',
            };
            return [...prev, ai];
          });
          break;
        }
        case 'task_dispatched': {
          const id = String((msg as any).taskId || `t_${Date.now()}`);
          const task = String((msg as any).task || '');
          // Routing priority: msg-provided machineId/clientId > active machine > "gateway" sentinel.
          // Never silently attribute to allMachines[0] — that was a real bug when more than
          // one machine was connected.
          const msgMachineId = String((msg as any).machineId || (msg as any).clientId || '');
          setSessions(prev => {
            if (prev.find(s => s.id === id)) return prev;
            const target = msgMachineId
              ? allMachines.find(m => m.id === msgMachineId)
              : (activeMachine ? allMachines.find(m => m.id === activeMachine) : undefined);
            const machineId = target?.id || msgMachineId || activeMachine || 'gateway';
            const machineName = target?.name || (msgMachineId ? `Machine ${msgMachineId.slice(0, 8)}` : 'Gateway');
            const next: SessionInfo = {
              id,
              machineId,
              machineName,
              status: 'live',
              task,
              tokensUsed: '0',
              elapsed: '0s',
              sessionId: id,
            };
            return [next, ...prev].slice(0, 50);
          });
          break;
        }
        case 'task_complete': {
          const id = String((msg as any).taskId || '');
          setSessions(prev => prev.map(s => {
            if (id && s.id !== id) return s;
            if (!id && s.status !== 'live') return s;
            return { ...s, status: 'done' as const };
          }));
          // Rough cumulative token estimate: result length / 4 chars per token.
          const result = (msg as any).result;
          const resultLen = typeof result === 'string'
            ? result.length
            : (result ? JSON.stringify(result).length : 0);
          if (resultLen > 0) {
            setTokensToday(prev => prev + Math.ceil(resultLen / 4));
          }
          break;
        }
        case 'browser_task_started': {
          const id = `web_${Date.now()}`;
          const task = String((msg as any).task || '');
          // Browser tasks always run on the gateway machine itself, but still respect
          // any explicit machineId in the message for future remote-gateway scenarios.
          const msgMachineId = String((msg as any).machineId || '');
          const target = msgMachineId
            ? allMachines.find(m => m.id === msgMachineId)
            : (activeMachine ? allMachines.find(m => m.id === activeMachine) : undefined);
          const machineId = target?.id || msgMachineId || activeMachine || 'gateway';
          const machineName = target?.name || (msgMachineId ? `Machine ${msgMachineId.slice(0, 8)}` : 'Gateway');
          const next: SessionInfo = {
            id,
            machineId,
            machineName,
            status: 'live',
            task: `web: ${task}`,
            tokensUsed: '0',
            elapsed: '0s',
            sessionId: id,
          };
          setSessions(prev => [next, ...prev].slice(0, 50));
          break;
        }
        case 'browser_task_result': {
          setSessions(prev => prev.map(s =>
            s.task.startsWith('web:') && s.status === 'live'
              ? { ...s, status: 'done' as const }
              : s,
          ));
          break;
        }
        case 'schedule_triggered': {
          // Cron / interval fire — append as a completed session entry so the
          // dashboard timeline shows what fired and when.
          const id = String((msg as any).scheduleId || `sch_${Date.now()}`);
          const text = String((msg as any).text || (msg as any).task || '');
          const result = (msg as any).result;
          // Schedules run on the gateway. Honor any explicit machineId; fall back to
          // active machine; sentinel last. No silent attribution to allMachines[0].
          const msgMachineId = String((msg as any).machineId || '');
          const target = msgMachineId
            ? allMachines.find(m => m.id === msgMachineId)
            : (activeMachine ? allMachines.find(m => m.id === activeMachine) : undefined);
          const machineId = target?.id || msgMachineId || activeMachine || 'gateway';
          const machineName = target?.name || (msgMachineId ? `Machine ${msgMachineId.slice(0, 8)}` : 'Gateway');
          const next: SessionInfo = {
            id: `${id}_${Date.now()}`,
            machineId,
            machineName,
            status: 'done',
            task: `⏰ ${text}`,
            tokensUsed: '0',
            elapsed: '—',
            sessionId: id,
          };
          setSessions(prev => [next, ...prev].slice(0, 50));
          if (result) {
            const len = typeof result === 'string' ? result.length : JSON.stringify(result).length;
            setTokensToday(prev => prev + Math.ceil(len / 4));
          }
          // Buddy pops up to actively announce the schedule fire.
          handleBuddyEvent('suggestion', {
            text: lang === 'zh' ? `⏰ 日程触发: ${text}` : `⏰ Triggered: ${text}`,
          });
          break;
        }
        case 'schedule_auto_created': {
          // Agent created and enabled a schedule on its own. Surface as a suggestion
          // so the user knows what happened and can correct if wrong.
          const m = msg as any;
          const sugId = `auto_${String(m.scheduleId)}`;
          setSuggestions(prev => {
            if (prev.find(s => s.id === sugId)) return prev;
            return [...prev, {
              id: sugId,
              pattern: `🤖 Agent 已自动创建并启用日程: "${m.text}" (${m.cron})`,
              patternEn: `🤖 Agent auto-created schedule: "${m.text}" (${m.cron})`,
              acceptLabel: '好',
              acceptLabelEn: 'OK',
              dismissLabel: '不需要，删掉',
              dismissLabelEn: 'Remove it',
            }];
          });
          handleBuddyEvent('suggestion', {
            text: lang === 'zh' ? `🤖 我建了个日程: ${m.text}` : `🤖 I set up a schedule: ${m.text}`,
          });
          break;
        }
        case 'tracked_item_signal': {
          const m = msg as any;
          const sigText = m.signal === 'sell' ? '止损/止盈'
            : m.signal === 'buy' ? '买入信号'
            : m.signal === 'alert' ? '异动' : m.signal;
          const title = m.displayName || m.identifier;
          const body = m.autoExecuted
            ? `已自动 ${m.signal === 'sell' ? '卖出' : '执行'}: ${title} @ ${m.quote?.current}`
            : `${title}: ${sigText} (${m.quote?.change_pct?.toFixed(2)}%)`;
          // Fire OS notification (tauri-plugin-notification)
          if (isTauri()) {
            import('@tauri-apps/plugin-notification').then(async ({ sendNotification, isPermissionGranted, requestPermission }) => {
              let granted = await isPermissionGranted();
              if (!granted) {
                const perm = await requestPermission();
                granted = perm === 'granted';
              }
              if (granted) sendNotification({ title: '⚠ Hone 盯盘', body });
            }).catch(() => {});
          }
          handleBuddyEvent(m.signal === 'sell' ? 'error' : 'suggestion', { text: body });
          break;
        }
        case 'schedule_proposed': {
          // Agent proposes a schedule (created but disabled, waiting for user to enable).
          const m = msg as any;
          const sugId = `prop_${String(m.scheduleId)}`;
          setSuggestions(prev => {
            if (prev.find(s => s.id === sugId)) return prev;
            return [...prev, {
              id: sugId,
              pattern: `💡 Agent 建议日程（已创建但未启用）: "${m.text}" (${m.cron})`,
              patternEn: `💡 Agent proposed a schedule (created but disabled): "${m.text}" (${m.cron})`,
              acceptLabel: '启用',
              acceptLabelEn: 'Enable',
              dismissLabel: '删掉',
              dismissLabelEn: 'Delete',
            }];
          });
          handleBuddyEvent('suggestion', {
            text: lang === 'zh' ? `💡 我提议一个日程: ${m.text}` : `💡 I propose: ${m.text}`,
          });
          break;
        }
      }
    });
    return unsub;
  }, [connection, allMachines]);

  // ── StatusBar live data ─────────────────────────────────────────────────
  const [gatewayUptimeSec, setGatewayUptimeSec] = useState<number | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const { gatewayUptime } = await import('./tauri/api');
        const up = await gatewayUptime();
        if (!cancelled) setGatewayUptimeSec(up);
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  function formatUptime(secs: number | null): string {
    if (secs == null || secs < 0) return '—';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  const statusBarData: StatusBarData = {
    uptime: formatUptime(gatewayUptimeSec),
    latency: connection.latencyMs >= 0 ? `${connection.latencyMs}ms` : '—',
    tokensToday: tokensToday.toLocaleString(),
    lastBackup: lang === 'zh' ? '本地持久化' : 'Local',
  };

  // Buddy state
  const [buddyState, setBuddyState] = useState<BuddyState>('idle');
  const [buddyText, setBuddyText] = useState<string | undefined>();

  const handleBuddyEvent = useCallback((event: string, payload?: any) => {
    console.log('[App] Buddy Event:', event, payload);
    switch (event) {
      case 'thinking':
        setBuddyState('thinking');
        setBuddyText(payload?.text || '正在思考...');
        break;
      case 'working':
        setBuddyState('working');
        setBuddyText(payload?.text || '正在工作...');
        break;
      case 'success':
        setBuddyState('success');
        setBuddyText(payload?.text || '搞定！');
        setTimeout(() => setBuddyState('idle'), 3000);
        break;
      case 'error':
        setBuddyState('error');
        setBuddyText(payload?.text || '出错了');
        setTimeout(() => setBuddyState('idle'), 5000);
        break;
      case 'suggestion':
        setBuddyState('suggestion');
        setBuddyText(payload?.text || '我有一个建议');
        break;
      case 'idle':
        setBuddyState('idle');
        break;
      case 'message':
        // Reaction to gateway messages
        if (buddyState === 'idle') {
          setBuddyState('thinking');
          setTimeout(() => setBuddyState('idle'), 1000);
        }
        break;
    }
  }, [buddyState]);

  return (
    <div style={styles.appShell}>
      <div style={styles.topBar}>
        <span style={styles.topBarBrand}>Hone</span>
        <span style={styles.topBarVersion}>v0.3.0-alpha</span>
      </div>

      {isTauri() && !settings.workspaceDir && !detectedHonePath && (
        <div style={{
          background: 'rgba(244, 88, 88, 0.1)',
          borderBottom: '1px solid var(--hone-danger, #F45858)',
          padding: '8px 16px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '12px',
          color: '#F45858',
          fontSize: '13px',
          fontWeight: 500,
          flexShrink: 0,
        }}>
          <span>
            {lang === 'zh'
              ? '⚠️ 未找到 Hone CLI，请在设置中指定工作目录'
              : '⚠️ Hone CLI not found. Please specify the workspace directory in Settings.'}
          </span>
          <button
            onClick={() => setActiveView('settings')}
            style={{
              background: 'var(--hone-danger, #F45858)',
              color: '#FFF',
              border: 'none',
              borderRadius: '4px',
              padding: '2px 10px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            {lang === 'zh' ? '前去设置' : 'Go to Settings'}
          </button>
        </div>
      )}

      <div style={styles.body}>
        <Sidebar
          machines={allMachines}
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
            {(['dashboard', 'gateway', 'workspace', 'watch', 'schedule', 'canvas', 'settings'] as ViewName[]).map(v => (
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
            ) : (allMachines.length > 0 || sessions.length > 0) ? (
              <Dashboard
                lang={lang}
                machines={allMachines}
                sessions={sessions}
                cliInstances={cliInstances}
                filter={filter}
                setFilter={setFilter}
                sortBy={sortBy}
                setSortBy={setSortBy}
                sortDir={sortDir}
                setSortDir={setSortDir}
                search={search}
                setSearch={setSearch}
                onOpenWorkspace={openWorkspace}
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
              connection={connection}
              onBuddyEvent={handleBuddyEvent}
              apiKeyConfigured={!!settings.apiKey?.trim()}
              onGoToSettings={() => setActiveView('settings')}
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
              connection={connection}
            />
          )}

          {activeView === 'settings' && (
            <SettingsPage
              settings={settings}
              setSettings={updateSettings}
              lang={lang}
              theme={theme}
              setTheme={setTheme}
              hydrated={!!tauriConfig}
            />
          )}

          {activeView === 'canvas' && (
            <CanvasViewer lang={lang} connection={connection} />
          )}

          {activeView === 'workspace' && (
            <CliWorkspace
              lang={lang}
              workspaces={workspaces}
              setWorkspaces={setWorkspaces}
              activeId={activeWsId}
              setActiveId={setActiveWsId}
            />
          )}

          {activeView === 'watch' && (
            <WatchPanel lang={lang} connection={connection} />
          )}

          <StatusBar lang={lang} statusBar={statusBarData} />

          {pairingModal && (
            <DevicePairingModal
              lang={lang}
              onClose={() => setPairingModal(false)}
              onPaired={async (info: { name: string; method: string; host: string; port: number; code: string; username?: string }) => {
                if (isTauri() && info) {
                  try {
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
                  } catch (e) {
                    console.error('Failed to add machine:', e);
                  }
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

          <HoneBuddy
            state={buddyState}
            text={buddyText}
            species={settings.buddySpecies as any || 'robot'}
            onAction={(action, data) => {
              if (action === 'pet') {
                setBuddyState('success');
                setBuddyText('摸摸头~');
                setTimeout(() => setBuddyState('idle'), 2000);
              } else if (action === 'open_bubble') {
                // Route based on what kind of event triggered the bubble.
                const text = String(data?.text || '');
                if (data?.state === 'error') {
                  setActiveView('gateway');
                } else if (data?.state === 'suggestion') {
                  // Schedule-related → schedule tab; otherwise stay on chat
                  if (/日程|schedule|⏰|🤖|💡/.test(text)) {
                    setActiveView('schedule');
                  } else {
                    setActiveView('gateway');
                  }
                }
              }
            }}
          />
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
