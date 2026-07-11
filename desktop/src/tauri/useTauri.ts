/**
 * Tauri-aware data hook. Uses IPC when running inside Tauri, falls back to mock data in browser.
 */
import { useState, useEffect, useCallback } from 'react';
import * as api from './api';
import type { MachineInfo, GatewayConfig, GatewayConnectionInfo, GatewayStatus, DiscoveredGateway } from './types';
import {
  type MachineInfo as MockMachine,
  type ScheduleInfo,
  type GatewayStatus as MockGatewayStatus,
} from '../data/mock';

// ── Detection ──

let _isTauri: boolean | null = null;
export function isTauri(): boolean {
  if (_isTauri === null) {
    // Tauri v2: __TAURI_INTERNALS__ is always injected (even without withGlobalTauri).
    // Tauri v1 / withGlobalTauri=true: __TAURI__ is also present.
    _isTauri = typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  }
  return _isTauri;
}

// ── Gateway hook ──

interface GatewayState {
  status: GatewayStatus | MockGatewayStatus;
  uptime: number | null;
  version: string;
  /** When the Rust side reports `Error(String)`, the message is kept here so
   *  the UI can show *why* the gateway is offline instead of just "offline". */
  errorMessage: string | null;
}

export function useGateway() {
  const [gw, setGw] = useState<GatewayState>(() => ({
    status: 'Stopped' as const,
    uptime: null,
    version: '—',
    errorMessage: null,
  }));
  const [loading, setLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const status = await api.gatewayStatus();
      const uptime = await api.gatewayUptime();
      let statusStr: MockGatewayStatus['status'];
      let errMsg: string | null = null;
      if (status === 'Running') statusStr = 'online';
      else if (status === 'Starting') statusStr = 'starting';
      else if (status === 'Stopping') statusStr = 'stopping';
      else if (typeof status === 'object' && 'Error' in status) {
        statusStr = 'offline';
        errMsg = status.Error; // preserve the real failure reason
      }
      else statusStr = 'offline';

      setGw(prev => ({
        ...prev,
        status: { status: statusStr, uptime: uptime != null ? String(uptime) : '—', version: prev.version } as MockGatewayStatus,
        uptime,
        errorMessage: errMsg,
      }));
    } catch {
      // use mock
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const start = useCallback(async (honePath: string, relayUrl?: string) => {
    setLoading(true);
    setStartError(null);
    try {
      if (isTauri()) {
        await api.gatewayStart(honePath, relayUrl);
        // Don't optimistically flip to "Running" — the daemon takes a few
        // seconds to boot (Node cold start + cli.js load + relay handshake).
        // Poll the real status so the UI reflects actual progress instead of
        // pretending to be ready while the daemon is still coming up.
        setGw(prev => ({ ...prev, status: 'Starting' as const, errorMessage: null }));
        const pollStart = Date.now();
        const POLL_TIMEOUT_MS = 30_000;
        const POLL_INTERVAL_MS = 400;
        while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const status = await api.gatewayStatus();
            const uptime = await api.gatewayUptime();
            if (status === 'Running') {
              setGw(prev => ({
                ...prev,
                status: { status: 'online', uptime: uptime != null ? String(uptime) : '—', version: prev.version } as MockGatewayStatus,
                uptime,
                errorMessage: null,
              }));
              break;
            }
            if (typeof status === 'object' && 'Error' in status) {
              // Daemon reported an error — surface it immediately instead of
              // polling for 30s against a dead process.
              setGw(prev => ({
                ...prev,
                status: { status: 'offline', uptime: '—', version: prev.version } as MockGatewayStatus,
                errorMessage: status.Error,
              }));
              break;
            }
            // Still Starting — keep polling.
          } catch {
            // status query failed; keep polling
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('gateway start failed:', msg);
      setStartError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setLoading(true);
    setStartError(null);
    try {
      if (isTauri()) {
        await api.gatewayStop();
      }
      setGw(prev => ({ ...prev, status: 'Stopped' as const }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('gateway stop failed:', msg);
      setStartError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  return { gw, loading, start, stop, refreshStatus: fetchStatus, startError };
}

// ── Machines hook ──

export function useMachines() {
  const [machines, setMachines] = useState<MockMachine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchMachines = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const list = await api.machinesList();
      setMachines(list.map(m => ({
        id: m.id,
        name: m.name,
        host: m.host,
        port: m.port,
        // ConnectionMethod is a Rust enum serialized as a tagged union
        // ({ Local: {...} } | { Ssh: {...} } | { Tunnel: {...} }).
        // MachineInfo.method is a plain string, so flatten to a label.
        method: m.method
          ? ('Local' in m.method ? 'local'
            : 'Ssh' in m.method ? 'ssh'
            : 'Tunnel' in m.method ? 'tunnel'
            : undefined)
          : undefined,
        status: m.status === 'Online' ? 'online' as const
          : m.status === 'Busy' ? 'busy' as const
          : 'offline' as const,
        sessions: m.sessions,
        os: m.os,
        cpu: m.cpu,
        lastSeen: m.last_seen,
        addedAt: m.added_at,
      })));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { fetchMachines(); }, [fetchMachines]);

  const addMachine = useCallback(async (info: Omit<MachineInfo, 'id'>) => {
    if (!isTauri()) return '';
    try {
      const id = await api.machineAdd(info);
      await fetchMachines();
      return id;
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, [fetchMachines]);

  const removeMachine = useCallback(async (id: string) => {
    if (!isTauri()) return;
    try {
      await api.machineRemove(id);
      await fetchMachines();
    } catch (e) {
      setError(String(e));
    }
  }, [fetchMachines]);

  return { machines, setMachines, error, addMachine, removeMachine, refreshMachines: fetchMachines };
}

// ── Discovery hook ──

export function useDiscovery() {
  const [gateways, setGateways] = useState<DiscoveredGateway[]>([]);
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async () => {
    if (!isTauri()) return;
    setScanning(true);
    try {
      const list = await api.discoverGateways();
      setGateways(list);
    } catch (e) {
      console.error('discovery failed:', e);
    } finally {
      setScanning(false);
    }
  }, []);

  return { gateways, scanning, scan };
}

// ── Hone path hook ──

export function useHonePath() {
  const [honePath, setHonePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    api.getHonePath()
      .then(p => { if (!cancelled) setHonePath(p); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const updatePath = useCallback(async (newPath: string) => {
    if (!isTauri()) return;
    await api.setHonePath(newPath);
    setHonePath(newPath);
  }, []);

  return { honePath, loading, updatePath };
}

// ── Settings/config hook ──

export function useTauriConfig() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);

  const fetchConfig = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const c = await api.getConfig();
      setConfig(c);
    } catch (e) {
      console.error('get_config failed:', e);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const save = useCallback(async (c: GatewayConfig, honePath: string) => {
    if (!isTauri()) return;
    try {
      await api.saveConfig(c, honePath);
    } catch (e) {
      console.error('save_config failed:', e);
    }
  }, []);

  return { config, save, refreshConfig: fetchConfig };
}

export function useGatewayConnectionInfo() {
  const [info, setInfo] = useState<GatewayConnectionInfo | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setInfo(await api.gatewayConnectionInfo());
    } catch (error) {
      console.error('gateway_connection_info failed:', error);
      setInfo(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const rotatePairing = useCallback(async () => {
    if (!isTauri()) return null;
    const next = await api.mobilePairingRotate();
    setInfo(next);
    return next;
  }, []);

  return { info, refresh, rotatePairing };
}

// ── Empty defaults for components that don't need live IPC yet ──

// ── Schedules (persisted via Tauri IPC) ──

export function useSchedules(): {
  schedules: ScheduleInfo[];
  save: (s: ScheduleInfo[]) => Promise<void>;
  loading: boolean;
} {
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.schedulesList();
        if (!cancelled) setSchedules(next);
      } catch {
        // Keep the last known schedule list during a transient IPC failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    // The Gateway persists run metadata in the same schedule store. Polling
    // keeps the management view in sync without maintaining a second engine.
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const save = useCallback(async (s: ScheduleInfo[]) => {
    const prev = schedules;
    setSchedules(s);
    if (!isTauri()) return;
    try {
      await api.schedulesSave(s);
    } catch (e) {
      console.error('Failed to save schedules:', e);
      setSchedules(prev); // Rollback
    }
  }, [schedules]);

  return { schedules, save, loading };
}
