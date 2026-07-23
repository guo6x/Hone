/**
 * Global, app-lifetime authenticated connection to the local Gateway.
 *
 * Mounted once in App.tsx so all tabs (Dashboard, GatewayChat, WebTaskRunner)
 * share a single connection. Each tab subscribes to events via the `subscribe`
 * callback and reads connection state via `status` / `messages`.
 *
 * Connection lifecycle:
 *   - Auto-connect on mount after receiving a local capability token from Tauri
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
  /** Relay URL is retained for diagnostics; desktop traffic uses localhost. */
  relayUrl?: string;
  /** Enable/disable the connection (allows pausing without unmount). */
  enabled?: boolean;
  /** Local daemon WebSocket port (default 18789). */
  localPort?: number;
  /** Per-install capability required by the local Gateway handshake. */
  localToken?: string;
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

const MAX_RECONNECT_ATTEMPTS = 60; // 持续重试60次（约2分钟），覆盖 daemon 冷启动
const BASE_RECONNECT_DELAY_MS = 1500;
const PING_INTERVAL_MS = 15_000;

export function useGatewayConnection(
  opts: UseGatewayConnectionOptions,
): UseGatewayConnectionReturn {
  const { relayUrl, enabled = true, localPort: optsLocalPort, localToken } = opts;

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
    // NOTE: we intentionally do NOT check `enabled` here. `enabled` only gates
    // the auto-connect in useEffect. Manual reconnect() calls (e.g. after the
    // daemon finishes booting) must always attempt a connection — otherwise
    // reconnect() is silently dropped when the daemonOnline poll hasn't flipped
    // enabled=true yet (up to 1s lag), and the UI stays "reconnecting" forever.
    if (!localToken) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return; // CONNECTING or OPEN

    setStatus(prev => (prev === 'online' ? prev : 'starting'));
    setError(null);

    // Prefer a direct local connection to the gateway daemon (ws://127.0.0.1:PORT)
    // over the relay. The daemon listens on 127.0.0.1:HONE_GATEWAY_PORT and
    // accepts same-machine clients — this bypasses the relay entirely, which is
    // critical when the relay (Cloudflare Workers) is unreachable due to network
    // restrictions or proxy issues.
    //
    // 使用 127.0.0.1 而不是 localhost：Node.js WebSocketServer 绑定 localhost
    // 时可能只监听 ::1（IPv6），而 WebView2 解析 localhost 可能得到 127.0.0.1
    // （IPv4），导致 "WS error: unknown" 连接失败。Tauri CSP 已允许
    // ws://127.0.0.1:*，因此固定使用 IPv4 回环地址。
    const port = optsLocalPort || 18789;
    const targetUrl = `ws://127.0.0.1:${port}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(targetUrl);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    // Connection timeout: 3s is enough for local connections (ECONNREFUSED
    // is instant; a successful local connect is sub-millisecond). If the
    // daemon hasn't started its local WS server yet, we fail fast and retry.
    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch {}
      }
    }, 3000);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      ws.send(JSON.stringify({
        type: 'register',
        role: 'desktop',
        token: localToken,
        clientId: clientIdRef.current,
        machineId: 'desktop-' + clientIdRef.current,
        machineName: 'Desktop',
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
        case 'browser_task_result':
          // Returning to online from thinking state
          setStatus(prev => (prev === 'thinking' ? 'online' : prev));
          break;
        case 'task_started':
        case 'task_dispatched':
        case 'browser_task_started':
          // Gateway picked up work — flip to thinking so the UI reflects activity.
          setStatus(prev => (prev === 'online' ? 'thinking' : prev));
          break;
        case 'pairing_required':
          // Relay says we need to pair. Drop to offline so the user sees a
          // problem instead of being stuck in a fake "online" state.
          setStatus('offline');
          break;
        case 'gateway_disconnected':
          // The gateway daemon on the other side went away.
          setStatus(prev => (prev === 'online' || prev === 'thinking') ? 'reconnecting' : prev);
          break;
      }

      // Fan-out to subscribers
      listenersRef.current.forEach(cb => {
        try { cb(msg); } catch (err) { console.error('[useGatewayConnection] listener error', err); }
      });
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      wsRef.current = null;
      registeredRef.current = false;
      clearPing();
      if (intentionalStopRef.current) {
        setStatus('offline');
      } else {
        scheduleReconnect();
      }
    };

    ws.onerror = (event: any) => {
      // Surface the real error so the UI can show WHY the connection failed
      // instead of silently looping between "starting" and "reconnecting".
      // In Tauri WebView2, CSP violations produce a SecurityError here.
      const reason = event?.message || event?.code || 'unknown';
      setError(`WS error: ${reason} (url=${targetUrl})`);
    };
  }, [relayUrl, optsLocalPort, localToken]);

  function scheduleReconnect() {
    if (intentionalStopRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('offline');
      // Surface a clear reason so the UI can show "relay unreachable" instead
      // of just silently flipping to offline after a long retry storm.
      setError('Local Gateway unreachable — 检查桌面端 Gateway 是否正在运行');
      return;
    }
    reconnectAttemptsRef.current++;
    // 前 15 次用固定 400ms 间隔快速重试，覆盖 daemon 冷启动（Node.js
    // 启动 + cli.js 加载 + 端口监听通常需要 2-5 秒）。Rust 端在 spawn
    // node 后 250ms 就把状态设为 Running，但此时端口可能还没开始监听，
    // 所以我们需要快速重试直到端口真正可用。之后用指数退避覆盖网络问题。
    const delay = reconnectAttemptsRef.current <= 15
      ? 400
      : Math.min(
          BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 16),
          10_000,
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
    if (!enabled || !localToken) {
      setStatus('offline');
      return;
    }
    intentionalStopRef.current = false;
    // Reset the retry counter so a re-enable (daemon just came online) starts
    // fresh. Without this, if the counter was exhausted during a previous
    // disabled window, scheduleReconnect() would immediately bail to offline
    // even though the daemon is now ready.
    reconnectAttemptsRef.current = 0;
    connect();

    // 当窗口从后台切回前台时，如果当前是 offline / reconnecting 状态，
    // 重置重试计数并立即触发重连。这解决了"达到 MAX_RECONNECT_ATTEMPTS
    // 后永久 offline、用户切回窗口也不重试"的体验缺陷。
    // 仅在 visible 且未连接时触发，避免无意义的连接风暴。
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (intentionalStopRef.current) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) return;
      // 已经达到 MAX_RECONNECT_ATTEMPTS 或处于 offline/reconnecting，重置并重试
      reconnectAttemptsRef.current = 0;
      intentionalStopRef.current = false;
      clearReconnect();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      connect();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      intentionalStopRef.current = true;
      clearReconnect();
      clearPing();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      registeredRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, enabled, localToken]);

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
