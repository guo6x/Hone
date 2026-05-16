/**
 * Tauri-aware data hook. Uses IPC when running inside Tauri, falls back to mock data in browser.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from './api';
import type { MachineInfo, GatewayConfig, GatewayStatus, DiscoveredGateway } from './types';
import {
  type MachineInfo as MockMachine,
  type SessionInfo,
  type ScheduleInfo,
  type StatusBarData,
  type GatewayStatus as MockGatewayStatus,
} from '../data/mock';

// ── Detection ──

let _isTauri: boolean | null = null;
export function isTauri(): boolean {
  if (_isTauri === null) {
    _isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  }
  return _isTauri;
}

// ── Gateway hook ──

interface GatewayState {
  status: GatewayStatus | MockGatewayStatus;
  uptime: number | null;
  version: string;
}

export function useGateway() {
  const [gw, setGw] = useState<GatewayState>(() => ({
    status: 'Stopped' as const,
    uptime: null,
    version: '—',
  }));
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const status = await api.gatewayStatus();
      const uptime = await api.gatewayUptime();
      let statusStr: MockGatewayStatus['status'];
      if (status === 'Running') statusStr = 'online';
      else if (status === 'Starting') statusStr = 'starting';
      else if (status === 'Stopping') statusStr = 'stopping';
      else if (typeof status === 'object' && 'Error' in status) statusStr = 'offline';
      else statusStr = 'offline';

      setGw(prev => ({
        ...prev,
        status: { status: statusStr, uptime: prev.version, version: prev.version } as MockGatewayStatus,
        uptime,
      }));
    } catch {
      // use mock
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const start = useCallback(async (honePath: string, relayUrl?: string) => {
    setLoading(true);
    try {
      if (isTauri()) {
        await api.gatewayStart(honePath, relayUrl);
      }
      setGw(prev => ({ ...prev, status: 'Running' as const }));
    } catch (e) {
      console.error('gateway start failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setLoading(true);
    try {
      if (isTauri()) {
        await api.gatewayStop();
      }
      setGw(prev => ({ ...prev, status: 'Stopped' as const }));
    } catch (e) {
      console.error('gateway stop failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  return { gw, loading, start, stop, refreshStatus: fetchStatus };
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
        status: m.status === 'Online' ? 'online' as const
          : m.status === 'Busy' ? 'busy' as const
          : 'offline' as const,
        sessions: m.sessions,
        os: m.os,
        cpu: m.cpu,
      })));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { fetchMachines(); }, [fetchMachines]);

  const addMachine = useCallback(async (info: Omit<MachineInfo, 'id'>) => {
    if (!isTauri()) return '';
    try {
      return await api.machineAdd(info);
    } catch (e) {
      setError(String(e));
      return '';
    }
  }, []);

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
    api.schedulesList()
      .then(setSchedules)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (s: ScheduleInfo[]) => {
    setSchedules(s);
    if (!isTauri()) return;
    try {
      await api.schedulesSave(s);
    } catch (e) {
      console.error('Failed to save schedules:', e);
    }
  }, []);

  return { schedules, save, loading };
}

export function useMockSessions(): [SessionInfo[]] {
  return [[]];
}

export function useMockSchedules(): [
  ScheduleInfo[],
  (s: ScheduleInfo[]) => void,
] {
  return useState<ScheduleInfo[]>([]);
}

export function useMockStatusBar(): StatusBarData {
  return { uptime: '—', latency: '—', tokensToday: '0', lastBackup: '—' };
}
