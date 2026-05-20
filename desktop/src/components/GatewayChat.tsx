import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Lang, LANG } from '../i18n/translations';
import { type GatewayMessage } from '../data/mock';
import { useGateway } from '../tauri/useTauri';
import type { ConnectionStatus, RelayMessage } from '../hooks/useGatewayConnection';

interface Props {
  lang: Lang;
  theme: string;
  honePath?: string;
  relayUrl?: string;
  /** Shared connection state + actions from App-level useGatewayConnection. */
  connection: {
    status: ConnectionStatus;
    latencyMs: number;
    sendChat: (text: string) => boolean;
    subscribe: (cb: (msg: RelayMessage) => void) => () => void;
    reconnect: () => void;
  };
  onBuddyEvent?: (event: string, payload?: any) => void;
  /** True if user has saved an API key. When false, chat is blocked with a guidance banner. */
  apiKeyConfigured?: boolean;
  /** Jump to Settings tab from the warning banner. */
  onGoToSettings?: () => void;
}

function formatTime(): string {
  return `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
}

const GatewayChat: React.FC<Props> = ({ lang, honePath = 'hone', relayUrl, connection, onBuddyEvent, apiKeyConfigured = true, onGoToSettings }) => {
  const t = LANG[lang];
  const { start: ipcStart, stop: ipcStop } = useGateway();
  const { status, sendChat, subscribe, reconnect } = connection;
  const send = (connection as any).send as ((msg: Record<string, unknown>) => boolean) | undefined;

  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginProfile, setLoginProfile] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // Show a welcome banner the first time we go online
  const announcedOnceRef = useRef(false);
  useEffect(() => {
    if (status === 'online' && !announcedOnceRef.current) {
      announcedOnceRef.current = true;
      setMessages(prev => prev.length === 0 ? [
        { id: 'gw1', from: 'system', text: t.gwWelcome, time: formatTime() },
        { id: 'gw2', from: 'system', text: t.gwConnected, time: formatTime() },
      ] : prev);
    }
  }, [status, t.gwWelcome, t.gwConnected]);

  // Subscribe to relay events for chat-relevant messages.
  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      const now = formatTime();
      switch (msg.type) {
        case 'browser_login_started':
          setMessages(prev => [...prev, {
            id: 'sys' + Date.now(),
            from: 'system',
            text: lang === 'zh'
              ? `🌐 已打开浏览器，请在窗口里登录 ${(msg as any).profile}。登录完关掉窗口就行。`
              : `🌐 Browser opened for ${(msg as any).profile}. Log in, then close the window.`,
            time: now,
          }]);
          break;
        case 'browser_login_done':
          setMessages(prev => [...prev, {
            id: 'sys' + Date.now(),
            from: 'system',
            text: (msg as any).status === 'ok'
              ? (lang === 'zh' ? `✅ ${(msg as any).profile} 登录会话已保存。之后 agent 自动复用。` : `✅ ${(msg as any).profile} session saved. Agent will reuse it.`)
              : (lang === 'zh' ? `❌ 登录失败: ${(msg as any).error || ''}` : `❌ Login failed: ${(msg as any).error || ''}`),
            time: now,
          }]);
          break;
        case 'message':
          if (msg.from === 'gateway' && (msg as any).payload?.text) {
            setMessages((prev) => [...prev, {
              id: 'g' + Date.now(),
              from: 'gateway',
              text: (msg as any).payload.text,
              time: now,
            }]);
            onBuddyEvent?.('message', (msg as any).payload);
          }
          break;
        case 'buddy_event':
          onBuddyEvent?.((msg as any).event, (msg as any).payload);
          break;
        case 'task_started':
          onBuddyEvent?.('working', msg);
          break;
        case 'browser_task_started': {
          onBuddyEvent?.('working', msg);
          const task = String((msg as any).task || '');
          if (task) {
            setMessages((prev) => [...prev, {
              id: 'g' + Date.now(),
              from: 'gateway',
              text: lang === 'zh' ? `🌐 启动网页任务: ${task}` : `🌐 Starting web task: ${task}`,
              time: now,
            }]);
          }
          break;
        }
        case 'browser_task_result': {
          const m = msg as any;
          onBuddyEvent?.(m.status === 'success' ? 'success' : 'error', msg);
          const statusLabel = m.status === 'success'
            ? (lang === 'zh' ? '✓ 任务完成' : '✓ Done')
            : (lang === 'zh' ? '✗ 任务失败' : '✗ Failed');
          const parts: string[] = [statusLabel];
          if (m.finalUrl) parts.push(`→ ${m.finalUrl}`);
          if (typeof m.steps === 'number' && m.steps > 0) parts.push(`${m.steps} ${lang === 'zh' ? '步' : 'steps'}`);
          if (typeof m.durationMs === 'number') parts.push(`${(m.durationMs / 1000).toFixed(1)}s`);
          if (m.error) parts.push(`(${m.error})`);
          setMessages((prev) => [...prev, {
            id: 'g' + Date.now(),
            from: 'gateway',
            text: parts.join(' · '),
            time: now,
          }]);
          break;
        }
        case 'task_complete':
          onBuddyEvent?.('success', msg);
          if ((msg as any).result) {
            const r = (msg as any).result;
            setMessages((prev) => [...prev, {
              id: 'g' + Date.now(),
              from: 'gateway',
              text: typeof r === 'string' ? r : JSON.stringify(r),
              time: now,
            }]);
          }
          break;
        case 'notification':
          if ((msg as any).message) {
            setMessages((prev) => [...prev, {
              id: 'g' + Date.now(),
              from: 'gateway',
              text: (msg as any).message,
              time: now,
            }]);
          }
          break;
      }
    });
    return unsubscribe;
  }, [subscribe, onBuddyEvent, lang]);

  const getStatusText = (s: ConnectionStatus): string => {
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
    if (status === 'online' || status === 'thinking') {
      try { await ipcStop(); } catch {}
    } else if (status === 'offline' || status === 'reconnecting') {
      setErrorMsg(null);
      try {
        await ipcStart(honePath, relayUrl);
        reconnect();
      } catch (e: any) {
        setErrorMsg(e?.toString?.() ?? String(e));
      }
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || status === 'offline' || status === 'stopping') return;
    const now = formatTime();
    setMessages((prev) => [...prev, { id: `u${Date.now()}`, from: 'user', text, time: now }]);
    setInput('');

    if (!sendChat(text)) {
      setMessages((prev) => [...prev, {
        id: 'sys' + Date.now(),
        from: 'system',
        text: lang === 'zh'
          ? 'Gateway 未连接中继 — 消息未发送。请先启动 Gateway。'
          : 'Gateway not connected to relay — message not sent. Start Gateway first.',
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
    if (status !== 'online') return;
    const now = formatTime();
    setMessages((prev) => [...prev, { id: `u${Date.now()}`, from: 'user', text: action, time: now }]);
    if (!sendChat(action)) {
      setMessages((prev) => [...prev, {
        id: 'sys' + Date.now(),
        from: 'system',
        text: lang === 'zh' ? 'Gateway 离线 — 无法执行快捷操作。' : 'Gateway offline — cannot execute quick action.',
        time: formatTime(),
      }]);
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

  const inputDisabled = status === 'offline' || status === 'stopping' || status === 'reconnecting' || !apiKeyConfigured;

  const powerColors: Record<string, { bg: string; glow: string }> = {
    online: { bg: 'var(--hone-danger, #F45858)', glow: '0 0 6px rgba(244,88,88,0.4)' },
    offline: { bg: 'var(--hone-success, #2ECC80)', glow: '0 0 6px rgba(46,204,128,0.4)' },
    starting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    stopping: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    reconnecting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.6)' },
    thinking: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
  };
  const pc = powerColors[status] ?? powerColors.offline;

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
      background: status === 'online' ? 'var(--hone-success, #2ECC80)'
        : status === 'offline' ? '#6B7285'
        : status === 'reconnecting' ? '#F0A030'
        : 'var(--hone-accent, #D4A853)',
      flexShrink: 0,
      animation: status === 'reconnecting' ? 'pulse 0.8s ease-in-out infinite' : undefined,
    },
    gwLabel: { fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' as const },
    statusText: { fontSize: 11, color: 'var(--hone-muted, #6B7285)' },
    searchInput: {
      marginLeft: 'auto', background: 'var(--hone-surfaceRaised, #1A1E26)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 4,
      padding: '3px 8px', fontSize: 11, color: 'var(--hone-text, #E4E8F0)',
      outline: 'none', width: 160, boxSizing: 'border-box' as const,
    },
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
    switch (status) {
      case 'online': return '■';
      case 'offline': return '▶';
      case 'starting':
      case 'stopping':
      case 'reconnecting':
        return '⏳';
      default: return '▶';
    }
  };

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <button
          style={{
            ...styles.powerBtn,
            animation: status === 'starting' || status === 'stopping' || status === 'reconnecting' ? 'pulse 1s ease-in-out infinite' : undefined,
          }}
          onClick={handlePowerClick}
          title={status === 'online' ? t.gwStop : t.gwStart}
        >
          {getPowerSymbol()}
        </button>
        <div style={styles.statusDot} />
        <span style={styles.gwLabel}>{t.gwTitle}</span>
        <span style={styles.statusText}>{getStatusText(status)}</span>
        <input
          style={styles.searchInput}
          placeholder={t.gwSearch}
          value={chatSearch}
          onChange={(e) => setChatSearch(e.target.value)}
        />
      </div>

      {errorMsg && (
        <div style={{
          margin: '0 12px 12px', padding: '8px 12px', background: 'rgba(244, 88, 88, 0.1)',
          border: '1px solid var(--hone-danger)', borderRadius: 8, color: '#F45858', fontSize: 11, lineHeight: 1.4
        }}>
          <strong>{lang === 'zh' ? '启动失败: ' : 'Start Failed: '}</strong>
          {errorMsg}
        </div>
      )}

      {!apiKeyConfigured && (
        <div style={{
          margin: '12px 12px 0', padding: '12px 14px',
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid var(--hone-warning, #f59e0b)',
          borderRadius: 8, color: 'var(--hone-warning, #f59e0b)',
          fontSize: 12, lineHeight: 1.5,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>
            {lang === 'zh'
              ? '⚠ 还没配置大模型 API key。对话和网页任务都需要先配好才能用。'
              : '⚠ No LLM API key configured. Chat and web tasks both need this first.'}
          </span>
          {onGoToSettings && (
            <button
              onClick={onGoToSettings}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                borderRadius: 6, border: 'none',
                background: 'var(--hone-warning, #f59e0b)', color: '#fff',
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              {lang === 'zh' ? '前往设置 →' : 'Open Settings →'}
            </button>
          )}
        </div>
      )}

      {apiKeyConfigured && messages.length === 0 && status === 'online' && (
        <div style={{
          margin: '12px 12px 0', padding: '10px 14px',
          background: 'var(--hone-surface)', border: '1px solid var(--hone-border)',
          borderRadius: 8, fontSize: 12, color: 'var(--hone-muted)', lineHeight: 1.6,
        }}>
          {lang === 'zh'
            ? <>这是一个全能 agent，直接用自然语言告诉它你要做什么：<br/>
                • <code>查 Hacker News 今天最热的 3 条</code>（网页任务）<br/>
                • <code>每天早上 9 点提醒我看邮件</code>（日程）<br/>
                • <code>用 git status 看一下当前仓库状态</code>（CLI 任务）<br/>
                • 或者就普通聊天</>
            : <>This is an all-purpose agent. Just tell it what you want in natural language:<br/>
                • <code>fetch top 3 stories on Hacker News today</code> (web task)<br/>
                • <code>remind me to check email every morning at 9</code> (schedule)<br/>
                • <code>run git status to see the repo state</code> (CLI task)<br/>
                • or just chat</>}
        </div>
      )}

      <div style={styles.messagesArea}>
        {filteredMessages.length === 0 ? (
          <div style={styles.noResults}>{lang === 'zh' ? '没有匹配的对话' : 'No messages yet'}</div>
        ) : (
          filteredMessages.map((msg) => (
            <div key={msg.id} style={styles.msgRow(msg.from)}>
              <div style={styles.avatar(msg.from)}>
                {msg.from === 'gateway' ? '🤖' : msg.from === 'system' ? 'ℹ️' : '👤'}
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

      <div style={styles.quickRow}>
        <button style={styles.pill} onClick={() => handleQuickAction(`⚡ ${t.gwQuickDispatch}`)}>
          {'⚡ '}{t.gwQuickDispatch}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`📊 ${t.gwQuickStatus}`)}>
          {'📊 '}{t.gwQuickStatus}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`📅 ${t.gwQuickSchedule}`)}>
          {'📅 '}{t.gwQuickSchedule}
        </button>
        <button style={styles.pill} onClick={() => handleQuickAction(`🎨 ${t.gwQuickCanvas}`)}>
          {'🎨 '}{t.gwQuickCanvas}
        </button>
        <button style={styles.pill} onClick={() => setLoginModalOpen(true)}>
          {'🌐 '}{lang === 'zh' ? '浏览器登录' : 'Browser Login'}
        </button>
      </div>

      {loginModalOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setLoginModalOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'var(--hone-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            width: 460, maxWidth: 'calc(100vw - 40px)',
            borderRadius: 12, padding: 24,
            background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
            border: '1px solid var(--hone-border)',
          }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
              {lang === 'zh' ? '浏览器账号登录' : 'Browser Account Login'}
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--hone-muted)', lineHeight: 1.6 }}>
              {lang === 'zh'
                ? '打开一个非无头浏览器窗口让你手动登录。登录完关掉窗口，cookie/session 自动持久化，之后 agent 直接复用，不用重新登。'
                : 'Opens a visible browser window for you to log in manually. Close it when done; the agent reuses the session.'}
            </p>

            <label style={{ fontSize: 12, color: 'var(--hone-muted)', display: 'block', marginBottom: 4 }}>
              {lang === 'zh' ? 'Profile 名称（例如 xiaohongshu）' : 'Profile name (e.g. xiaohongshu)'}
            </label>
            <input
              type="text"
              value={loginProfile}
              onChange={e => setLoginProfile(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              placeholder="xiaohongshu"
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '8px 12px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--hone-border)',
                background: 'var(--hone-surface)', color: 'var(--hone-text)',
                outline: 'none', marginBottom: 12, fontFamily: 'monospace',
              }}
            />

            <label style={{ fontSize: 12, color: 'var(--hone-muted)', display: 'block', marginBottom: 4 }}>
              {lang === 'zh' ? '起始网址' : 'Start URL'}
            </label>
            <input
              type="text"
              value={loginUrl}
              onChange={e => setLoginUrl(e.target.value)}
              placeholder="https://xiaohongshu.com"
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '8px 12px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--hone-border)',
                background: 'var(--hone-surface)', color: 'var(--hone-text)',
                outline: 'none', marginBottom: 16,
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setLoginModalOpen(false)}
                style={{
                  padding: '7px 16px', fontSize: 13, borderRadius: 6,
                  background: 'transparent', color: 'var(--hone-text)',
                  border: '1px solid var(--hone-border)', cursor: 'pointer',
                }}
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  if (!loginProfile.trim()) return;
                  const ok = send && send({
                    type: 'browser_open_login',
                    profile: loginProfile.trim(),
                    url: loginUrl.trim() || undefined,
                  });
                  if (!ok) {
                    setMessages(prev => [...prev, {
                      id: 'sys' + Date.now(),
                      from: 'system',
                      text: lang === 'zh' ? 'Gateway 离线 — 无法打开浏览器' : 'Gateway offline — cannot open browser',
                      time: formatTime(),
                    }]);
                  }
                  setLoginModalOpen(false);
                  setLoginProfile('');
                  setLoginUrl('');
                }}
                disabled={!loginProfile.trim() || !send}
                style={{
                  padding: '7px 16px', fontSize: 13, borderRadius: 6,
                  background: 'var(--hone-accent)', color: '#0C0E12',
                  border: 'none', cursor: 'pointer', fontWeight: 600,
                  opacity: loginProfile.trim() && send ? 1 : 0.5,
                }}
              >
                {lang === 'zh' ? '打开浏览器登录' : 'Open Browser'}
              </button>
            </div>
          </div>
        </div>
      )}

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
