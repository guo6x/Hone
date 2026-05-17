/**
 * Global, app-lifetime WebSocket connection to the relay → gateway.
 *
 * Mounted once in App.tsx so all tabs (Dashboard, GatewayChat, WebTaskRunner)
 * share a single connection. Each tab subscribes to events via the `subscribe`
 * callback and reads connection state via `status` / `messages`.
 *
 * Connection lifecycle:
 *   - Auto-connect on mount (if relayUrl provided)
 *   - Auto-reconnect with exponential backoff up to MAX_RECONNECT_ATTEMPTS
 *   - Sends 'register' role=client with a stable clientId per app session
 */
import { useEffect, useRef, useState, useCallback } from 'react';

export type ConnectionStatus =
  | 'starting'
  | 'online'
  | 'offline'
  | 'thinking'
  | 'reconnecting'
  | 'stopping';

export interface RelayMessage {
  type: string;
  [k: string]: unknown;
}

export type RelayEventListener = (msg: RelayMessage) => void;

interface UseGatewayConnectionOptions {
  relayUrl?: string;
  /** Enable/disable the connection (allows pausing without unmount). */
  enabled?: boolean;
}

interface UseGatewayConnectionReturn {
  status: ConnectionStatus;
  /** Stable client ID for this app session. */
  clientId: string;
  /** Latest measured round-trip latency in ms (-1 if unknown). */
  latencyMs: number;
  /** Send a JSON message. Returns false if connection isn't ready. */
  send: (msg: Record<string, unknown>) => boolean;
  /** Send a plain chat message to the gateway. */
  sendChat: (text: string) => boolean;
  /** Subscribe to incoming relay messages. Returns unsubscribe fn. */
  subscribe: (cb: RelayEventListener) => () => void;
  /** Manually trigger a reconnect attempt. */
  reconnect: () => void;
  /** Last server-reported error, if any. */
  error: string | null;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 15_000;

export function useGatewayConnection(
  opts: UseGatewayConnectionOptions,
): UseGatewayConnectionReturn {
  const { relayUrl, enabled = true } = opts;

  const [status, setStatus] = useState<ConnectionStatus>('starting');
  const [latencyMs, setLatencyMs] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef<string>(`desktop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const registeredRef = useRef(false);
  const listenersRef = useRef<Set<RelayEventListener>>(new Set());
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPingSentAtRef = useRef<number>(0);

  const subscribe = useCallback((cb: RelayEventListener) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const send = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendChat = useCallback((text: string): boolean => {
    if (!registeredRef.current) return false;
    const ok = send({
      type: 'message',
      target: 'gateway',
      clientId: clientIdRef.current,
      payload: { text },
    });
    if (ok) setStatus('thinking');
    return ok;
  }, [send]);

  const clearReconnect = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const clearPing = () => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!relayUrl || !enabled) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return; // CONNECTING or OPEN

    setStatus(prev => (prev === 'online' ? prev : 'starting'));
    setError(null);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register',
        role: 'client',
        clientId: clientIdRef.current,
        machineId: 'desktop-' + clientIdRef.current,
        machineName: 'Desktop',
        pairingCode: 'hone-desktop-auto',
      }));

      // Heartbeat ping for latency measurement
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        lastPingSentAtRef.current = Date.now();
        try {
          ws.send(JSON.stringify({
            type: 'ping',
            clientId: clientIdRef.current,
            ts: lastPingSentAtRef.current,
          }));
        } catch {}
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // Built-in handling for connection-state messages
      switch (msg.type) {
        case 'registered':
          registeredRef.current = true;
          reconnectAttemptsRef.current = 0;
          intentionalStopRef.current = false;
          setStatus('online');
          break;
        case 'pong':
          if (typeof msg.ts === 'number') {
            setLatencyMs(Date.now() - msg.ts);
          } else if (lastPingSentAtRef.current > 0) {
            setLatencyMs(Date.now() - lastPingSentAtRef.current);
          }
          break;
        case 'message':
        case 'task_complete':
          // Returning to online from thinking state
          setStatus(prev => (prev === 'thinking' ? 'online' : prev));
          break;
      }

      // Fan-out to subscribers
      listenersRef.current.forEach(cb => {
        try { cb(msg); } catch (err) { console.error('[useGatewayConnection] listener error', err); }
      });
    };

    ws.onclose = () => {
      wsRef.current = null;
      registeredRef.current = false;
      clearPing();
      if (intentionalStopRef.current) {
        setStatus('offline');
      } else {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror
    };
  }, [relayUrl, enabled]);

  function scheduleReconnect() {
    if (intentionalStopRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('offline');
      return;
    }
    reconnectAttemptsRef.current++;
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 1),
      30_000,
    );
    setStatus('reconnecting');
    clearReconnect();
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }

  const reconnect = useCallback(() => {
    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;
    clearReconnect();
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  // Mount: connect; Unmount: tear down
  useEffect(() => {
    if (!enabled || !relayUrl) {
      setStatus('offline');
      return;
    }
    intentionalStopRef.current = false;
    connect();
    return () => {
      intentionalStopRef.current = true;
      clearReconnect();
      clearPing();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      registeredRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, enabled]);

  return {
    status,
    clientId: clientIdRef.current,
    latencyMs,
    send,
    sendChat,
    subscribe,
    reconnect,
    error,
  };
}
