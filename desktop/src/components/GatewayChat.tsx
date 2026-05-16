import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Lang, LANG } from '../i18n/translations';
import { type GatewayMessage, type GatewayStatus } from '../data/mock';
import { useGateway } from '../tauri/useTauri';

interface Props {
  lang: Lang;
  theme: string;
  honePath?: string;
  relayUrl?: string;
}

function formatTime(): string {
  return `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
}

const GatewayChat: React.FC<Props> = ({ lang, honePath = 'hone', relayUrl }) => {
  const t = LANG[lang];
  const { start: ipcStart, stop: ipcStop } = useGateway();
  const [status, setStatus] = useState<GatewayStatus>({
    status: 'offline',
    uptime: '—',
    version: '—',
  });
  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // WebSocket connection to Relay
  const wsRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef<string>('');
  const registeredRef = useRef(false);

  // Auto-reconnect state
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalStopRef = useRef(false);
  const MAX_RECONNECT_ATTEMPTS = 10;
  const BASE_RECONNECT_DELAY_MS = 2000;

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // -- Auto-reconnect helpers --

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalStopRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setStatus((prev) => ({ ...prev, status: 'offline', uptime: '—' }));
      return;
    }

    reconnectAttemptsRef.current++;
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current - 1),
      30_000,
    );

    clearReconnectTimer();
    setStatus((prev) => ({ ...prev, status: 'reconnecting' }));

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      // Trigger WebSocket creation via status change
      setStatus((prev) => ({ ...prev, status: 'starting' }));
    }, delay);
  }, [clearReconnectTimer]);

  // Clear reconnect timer on unmount
  useEffect(() => {
    return () => clearReconnectTimer();
  }, [clearReconnectTimer]);

  // -- WebSocket lifecycle --

  // Connect WebSocket when status changes to 'starting'
  useEffect(() => {
    if (status.status !== 'starting' || !relayUrl || wsRef.current) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      // Connection failed outright — retry if not intentional
      wsRef.current = null;
      scheduleReconnect();
      return;
    }
    wsRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'register',
        role: 'client',
        machineId: 'desktop-' + Date.now(),
        machineName: 'Desktop',
        pairingCode: 'hone-desktop-auto',
      }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        const now = formatTime();

        switch (msg.type) {
          case 'pairing_required':
            break;
          case 'registered':
            clientIdRef.current = msg.clientId || '';
            registeredRef.current = true;
            reconnectAttemptsRef.current = 0;
            intentionalStopRef.current = false;
            setStatus((prev) => ({ ...prev, status: 'online', uptime: '0d 0h 0m' }));
            if (messages.length === 0) {
              setMessages([
                { id: 'gw1', from: 'gateway', text: t.gwWelcome, time: now },
                { id: 'gw2', from: 'gateway', text: t.gwMsg1, time: formatTime() },
              ]);
            }
            break;
          case 'message':
            if (msg.from === 'gateway' && msg.payload?.text) {
              setMessages((prev) => [...prev, {
                id: 'g' + Date.now(),
                from: 'gateway',
                text: msg.payload.text,
                time: now,
              }]);
              setStatus((prev) => ({ ...prev, status: 'online' }));
            }
            break;
          case 'task_complete':
            if (msg.result) {
              setMessages((prev) => [...prev, {
                id: 'g' + Date.now(),
                from: 'gateway',
                text: typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result),
                time: now,
              }]);
              setStatus((prev) => ({ ...prev, status: 'online' }));
            }
            break;
          case 'notification':
            if (msg.message) {
              setMessages((prev) => [...prev, {
                id: 'g' + Date.now(),
                from: 'gateway',
                text: msg.message,
                time: now,
              }]);
            }
            break;
        }
      } catch { /* ignore parse errors */ }
    };

    socket.onclose = () => {
      wsRef.current = null;
      clientIdRef.current = '';
      registeredRef.current = false;
      // If gateway was running and this wasn't intentional → reconnect
      setStatus((prev) => {
        if ((prev.status === 'online' || prev.status === 'thinking') && !intentionalStopRef.current) {
          scheduleReconnect();
          return prev; // keep current status until reconnect attempt
        }
        return { ...prev, status: 'offline', uptime: '—' };
      });
    };

    socket.onerror = () => {
      // onclose will fire after this
    };
  }, [status.status, relayUrl, scheduleReconnect]);

  // Close WebSocket on unmount
  useEffect(() => {
    return () => {
      intentionalStopRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        clientIdRef.current = '';
        registeredRef.current = false;
      }
    };
  }, [clearReconnectTimer]);

  // Close WebSocket when gateway intentionally stops
  useEffect(() => {
    if ((status.status === 'offline' || status.status === 'stopping') && wsRef.current) {
      intentionalStopRef.current = true;
      clearReconnectTimer();
      wsRef.current.close();
      wsRef.current = null;
      clientIdRef.current = '';
      registeredRef.current = false;
    }
  }, [status.status, clearReconnectTimer]);

  const getStatusText = (s: GatewayStatus['status']): string => {
    switch (s) {
      case 'online': return t.gwOnline;
      case 'offline': return t.gwOffline;
      case 'starting': return t.gwStarting;
      case 'stopping': return t.gwStopping;
      case 'thinking': return t.gwThinking;
      case 'reconnecting': return lang === 'zh' ? '重连中…' : 'Reconnecting…';
    }
  };

  const handlePowerClick = async () => {
    if (status.status === 'online' || status.status === 'thinking') {
      setStatus({ ...status, status: 'stopping' });
      try { await ipcStop(); } catch {}
      setTimeout(() => {
        setStatus((prev) => prev.status === 'stopping' ? { ...prev, status: 'offline', uptime: '—' } : prev);
      }, 3000);
    } else if (status.status === 'reconnecting' || status.status === 'starting') {
      // Cancel reconnect/start and go to offline
      intentionalStopRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatus({ ...status, status: 'offline', uptime: '—' });
    } else if (status.status === 'offline') {
      intentionalStopRef.current = false;
      reconnectAttemptsRef.current = 0;
      setStatus({ ...status, status: 'starting' });
      try { await ipcStart(honePath, relayUrl); } catch {
        setStatus({ ...status, status: 'offline' });
      }
    }
  };

  /** Send text through the WebSocket to the relay → gateway daemon */
  const sendViaWebSocket = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && registeredRef.current) {
      setStatus((prev) => ({ ...prev, status: 'thinking' }));
      ws.send(JSON.stringify({
        type: 'message',
        target: 'gateway',
        payload: { text },
      }));
      return true;
    }
    return false;
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || status.status === 'offline' || status.status === 'stopping') return;
    const now = formatTime();
    const userMsg: GatewayMessage = {
      id: `u${Date.now()}`,
      from: 'user',
      text,
      time: now,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    if (!sendViaWebSocket(text)) {
      // Fallback: no WebSocket — message recorded locally
      setMessages((prev) => [...prev, {
        id: 'sys' + Date.now(),
        from: 'system',
        text: lang === 'zh'
          ? `Gateway 未连接中继 — 消息未发送。请先启动 Gateway。`
          : `Gateway not connected to relay — message not sent. Start Gateway first.`,
        time: formatTime(),
      }]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickAction = (action: string) => {
    setChatSearch('');
    if (status.status !== 'online') return;

    const now = formatTime();
    const userMsg: GatewayMessage = {
      id: `u${Date.now()}`,
      from: 'user',
      text: action,
      time: now,
    };
    setMessages((prev) => [...prev, userMsg]);

    if (!sendViaWebSocket(action)) {
      setMessages((prev) => [...prev, {
        id: 'sys' + Date.now(),
        from: 'system',
        text: lang === 'zh' ? 'Gateway 离线 — 无法执行快捷操作。请先启动 Gateway。' : 'Gateway offline — cannot execute quick action. Start Gateway first.',
        time: formatTime(),
      }]);
      setStatus((prev) => ({ ...prev, status: 'online' }));
    }
  };

  const getMessageText = (msg: GatewayMessage): string => {
    if (msg.text) return msg.text;
    if (msg.textKey) {
      const key = msg.textKey as keyof typeof t;
      return (t as unknown as Record<string, string>)[key] ?? msg.textKey;
    }
    return '';
  };

  const filteredMessages = chatSearch
    ? messages.filter((m) => getMessageText(m).toLowerCase().includes(chatSearch.toLowerCase()))
    : messages;

  const inputDisabled = status.status === 'offline' || status.status === 'stopping' || status.status === 'reconnecting';

  const powerColors: Record<string, { bg: string; glow: string }> = {
    online: { bg: 'var(--hone-danger, #F45858)', glow: '0 0 6px rgba(244,88,88,0.4)' },
    offline: { bg: 'var(--hone-success, #2ECC80)', glow: '0 0 6px rgba(46,204,128,0.4)' },
    starting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    stopping: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    reconnecting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.6)' },
    thinking: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
  };
  const pc = powerColors[status.status] ?? powerColors.offline;

  const styles: Record<string, any> = {
    root: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--hone-bg, #0C0E12)', color: 'var(--hone-text, #E4E8F0)' },
    header: {
      display: 'flex', alignItems: 'center', height: 38, padding: '0 12px', gap: 10,
      borderBottom: '1px solid var(--hone-border, #252A36)', flexShrink: 0,
    },
    powerBtn: {
      width: 28, height: 28, borderRadius: '50%', border: 'none', background: pc.bg,
      boxShadow: pc.glow, cursor: 'pointer', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 14, color: '#fff', flexShrink: 0,
      transition: 'box-shadow 0.2s',
    },
    statusDot: {
      width: 7, height: 7, borderRadius: '50%',
      background: status.status === 'online' ? 'var(--hone-success, #2ECC80)'
        : status.status === 'offline' ? '#6B7285'
        : status.status === 'reconnecting' ? '#F0A030'
        : 'var(--hone-accent, #D4A853)',
      flexShrink: 0,
      animation: status.status === 'reconnecting' ? 'pulse 0.8s ease-in-out infinite' : undefined,
    },
    gwLabel: { fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' as const },
    statusText: { fontSize: 11, color: 'var(--hone-muted, #6B7285)' },
    searchInput: {
      marginLeft: 'auto', background: 'var(--hone-surfaceRaised, #1A1E26)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 4,
      padding: '3px 8px', fontSize: 11, color: 'var(--hone-text, #E4E8F0)',
      outline: 'none', width: 160, boxSizing: 'border-box' as const,
    },
    version: { fontSize: 10, color: 'var(--hone-muted, #6B7285)', fontFamily: '"JetBrains Mono", monospace', whiteSpace: 'nowrap' as const },
    messagesArea: {
      flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
    },
    msgRow: (from: string): React.CSSProperties => ({
      display: 'flex', gap: 8, alignItems: 'flex-end',
      flexDirection: from === 'user' ? 'row-reverse' : 'row',
    }),
    avatar: (from: string): React.CSSProperties => ({
      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, background: from === 'user' ? 'var(--hone-accentMuted, #24201A)' : 'var(--hone-surfaceOverlay, #222733)',
    }),
    bubble: (from: string): React.CSSProperties => ({
      maxWidth: '70%', padding: '8px 12px', fontSize: 13, lineHeight: 1.5,
      borderRadius: from === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
      background: from === 'user' ? 'var(--hone-accent, #D4A853)'
        : from === 'system' ? 'var(--hone-dangerMuted, #3A1A1A)'
        : 'var(--hone-surfaceRaised, #1A1E26)',
      color: from === 'user' ? '#0C0E12'
        : from === 'system' ? 'var(--hone-danger, #F45858)'
        : 'var(--hone-text, #E4E8F0)',
      border: from === 'user' ? '1px solid var(--hone-accentHover, #C49B40)'
        : from === 'system' ? '1px solid var(--hone-danger, #F45858)'
        : '1px solid var(--hone-border, #252A36)',
    }),
    msgTime: {
      fontSize: 9, textAlign: 'right' as const, fontFamily: '"JetBrains Mono", monospace',
      marginTop: 4, opacity: 0.6,
    },
    noResults: { textAlign: 'center' as const, color: 'var(--hone-muted, #6B7285)', fontSize: 13, paddingTop: 24 },
    quickRow: {
      display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto' as const,
      borderTop: '1px solid var(--hone-border, #252A36)', flexShrink: 0,
    },
    pill: {
      whiteSpace: 'nowrap' as const, padding: '4px 12px', borderRadius: 20,
      border: '1px solid var(--hone-border, #252A36)', fontSize: 11,
      background: 'var(--hone-surfaceRaised, #1A1E26)', color: 'var(--hone-text, #E4E8F0)',
      cursor: 'pointer', flexShrink: 0,
    },
    inputRow: {
      display: 'flex', gap: 8, padding: '8px 12px',
      borderTop: '1px solid var(--hone-border, #252A36)',
      background: 'var(--hone-surface, #13161C)', flexShrink: 0,
    },
    textInput: {
      flex: 1, background: 'var(--hone-surfaceRaised, #1A1E26)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 6,
      padding: '6px 12px', fontSize: 13, color: 'var(--hone-text, #E4E8F0)',
      outline: 'none', boxSizing: 'border-box' as const,
    },
    sendBtn: {
      background: inputDisabled ? 'var(--hone-muted, #6B7285)' : 'var(--hone-accent, #D4A853)',
      color: '#0C0E12', border: 'none', borderRadius: 6,
      padding: '6px 16px', fontSize: 13, fontWeight: 500, cursor: inputDisabled ? 'not-allowed' : 'pointer',
    },
  };

  const getPowerSymbol = (): string => {
    switch (status.status) {
      case 'online': return '\u25A0';
      case 'offline': return '\u25B6';
      case 'starting':
      case 'stopping':
      case 'reconnecting':
        return '\u23F3';
      default: return '\u25B6';
    }
  };

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <button
          style={{
            ...styles.powerBtn,
            animation: status.status === 'starting' || status.status === 'stopping' || status.status === 'reconnecting' ? 'pulse 1s ease-in-out infinite' : undefined,
          }}
          onClick={handlePowerClick}
          title={status.status === 'online' ? t.gwStop : t.gwStart}
        >
          {getPowerSymbol()}
        </button>
        <div style={styles.statusDot} />
        <span style={styles.gwLabel}>{t.gwTitle}</span>
        <span style={styles.statusText}>{getStatusText(status.status)}</span>
        <input
          style={styles.searchInput}
          placeholder={t.gwSearch}
          value={chatSearch}
          onChange={(e) => setChatSearch(e.target.value)}
        />
        <span style={styles.version}>{status.version}</span>
      </div>

      {/* Messages */}
      <div style={styles.messagesArea}>
        {filteredMessages.length === 0 ? (
          <div style={styles.noResults}>{'没有匹配的对话'}</div>
        ) : (
          filteredMessages.map((msg) => (
            <div key={msg.id} style={styles.msgRow(msg.from)}>
              <div style={styles.avatar(msg.from)}>
                {msg.from === 'gateway' ? '\uD83E\uDD16' : msg.from === 'system' ? '\u2139\uFE0F' : '\uD83D\uDC64'}
              </div>
              <div style={styles.bubble(msg.from)}>
                <div>{getMessageText(msg)}</div>
                <div style={styles.msgTime}>{msg.time}</div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Quick actions */}
      <div style={styles.quickRow}>
        <button style={styles.pill} onClick={() => handleQuickAction(`\u26A1 ${t.gwQuickDispatch}`)}>
          {'\u26A1 '}{t.gwQuickDispatch}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`\uD83D\uDCCA ${t.gwQuickStatus}`)}>
          {'\uD83D\uDCCA '}{t.gwQuickStatus}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`\uD83D\uDCC5 ${t.gwQuickSchedule}`)}>
          {'\uD83D\uDCC5 '}{t.gwQuickSchedule}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`\uD83C\uDFA8 ${t.gwQuickCanvas}`)}>
          {'\uD83C\uDFA8 '}{t.gwQuickCanvas}
        </button>
      </div>

      {/* Input row */}
      <div style={styles.inputRow}>
        <input
          style={styles.textInput}
          placeholder={t.gwPlaceholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={inputDisabled}
        />
        <button style={styles.sendBtn} onClick={handleSend} disabled={inputDisabled}>
          {t.gwSend}
        </button>
      </div>

      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
};

export default GatewayChat;
