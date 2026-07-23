import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Lang, LANG } from '../i18n/translations';
import { type GatewayMessage, type ChatSession } from '../data/mock';
import { useGateway } from '../tauri/useTauri';
import type { ConnectionStatus, RelayMessage } from '../hooks/useGatewayConnection';
import MdText from './MdText';

interface Props {
  lang: Lang;
  theme: string;
  honePath?: string;
  relayUrl?: string;
  /** Shared connection state + actions from App-level useGatewayConnection. */
  connection: {
    status: ConnectionStatus;
    latencyMs: number;
    error: string | null;
    sendChat: (text: string) => boolean;
    send: (msg: Record<string, unknown>) => boolean;
    subscribe: (cb: (msg: RelayMessage) => void) => () => void;
    reconnect: () => void;
  };
  onBuddyEvent?: (event: string, payload?: any) => void;
  /** True if user has saved an API key. When false, chat is blocked with a guidance banner. */
  apiKeyConfigured?: boolean;
  /** Jump to Settings tab from the warning banner. */
  onGoToSettings?: () => void;
  /** Session list managed by App. */
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  onCreateSession: (title?: string) => string;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id?: string) => void;
  appendMessage: (msg: GatewayMessage) => void;
  nextId: (prefix: string) => string;
}

function formatTime(): string {
  return `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
}

const GatewayChat: React.FC<Props> = ({
  lang,
  honePath = '',
  relayUrl,
  connection,
  onBuddyEvent,
  apiKeyConfigured = true,
  onGoToSettings,
  sessions,
  activeSessionId,
  activeSession,
  onCreateSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  appendMessage,
  nextId,
}) => {
  const t = LANG[lang];
  const { start: ipcStart, stop: ipcStop, startError } = useGateway();
  const { status, sendChat, subscribe, reconnect } = connection;
  const send = connection.send;

  const [input, setInput] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginProfile, setLoginProfile] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    kind: 'task' | 'browser';
    id: string;
    description: string;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('hone-chat-sidebar-collapsed');
      return raw === 'true';
    } catch { return false; }
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem('hone-chat-sidebar-collapsed', String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);
  const onBuddyEventRef = useRef(onBuddyEvent);
  onBuddyEventRef.current = onBuddyEvent;

  const messages = activeSession?.messages || [];

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  // Track whether the user has manually scrolled up; only auto-scroll when
  // they are already near the bottom so long conversations stay readable.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolledUpRef.current = !nearBottom;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      scrollToBottom('smooth');
    }
  }, [messages, scrollToBottom]);

  // Show a welcome banner the first time we go online (for the active session)
  const announcedOnceRef = useRef(false);
  useEffect(() => {
    if (status === 'online' && !announcedOnceRef.current) {
      announcedOnceRef.current = true;
      if (messages.length === 0) {
        appendMessage({ id: 'gw1', from: 'system', text: t.gwWelcome, time: formatTime() });
        appendMessage({ id: 'gw2', from: 'system', text: t.gwConnected, time: formatTime() });
      }
    }
  }, [status, t.gwWelcome, t.gwConnected, messages.length, appendMessage]);

  // Reset announced flag when session changes so new sessions get welcome messages.
  useEffect(() => {
    announcedOnceRef.current = false;
    userScrolledUpRef.current = false;
    // Brief delay so messages render before scrolling on session switch.
    setTimeout(() => scrollToBottom('auto'), 0);
  }, [activeSessionId, scrollToBottom]);

  // Subscribe to relay events for chat-relevant messages.
  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      const now = formatTime();
      switch (msg.type) {
        case 'browser_login_started':
          appendMessage({
            id: nextId('sys'),
            from: 'system',
            text: lang === 'zh'
              ? `🌐 已打开浏览器，请在窗口里登录 ${(msg as any).profile}。登录完关掉窗口就行。`
              : `🌐 Browser opened for ${(msg as any).profile}. Log in, then close the window.`,
            time: now,
          });
          break;
        case 'browser_login_done':
          appendMessage({
            id: nextId('sys'),
            from: 'system',
            text: (msg as any).status === 'ok'
              ? (lang === 'zh' ? `✅ ${(msg as any).profile} 登录会话已保存。之后 agent 自动复用。` : `✅ ${(msg as any).profile} session saved. Agent will reuse it.`)
              : (lang === 'zh' ? `❌ 登录失败: ${(msg as any).error || ''}` : `❌ Login failed: ${(msg as any).error || ''}`),
            time: now,
          });
          break;
        case 'message': {
          const payloadText = (msg as any).payload?.text;
          const targetClient = (msg as any).target === 'client' || (msg as any).target === 'gateway';
          const fromGateway = msg.from === 'gateway' || targetClient;
          if (fromGateway && payloadText) {
            appendMessage({
              id: nextId('g'),
              from: 'gateway',
              text: payloadText,
              time: now,
            });
            onBuddyEventRef.current?.('message', (msg as any).payload);
          }
          break;
        }
        case 'buddy_event':
          onBuddyEventRef.current?.((msg as any).event, (msg as any).payload);
          break;
        case 'task_dispatched': {
          const dispatchedTask = String((msg as any).task || '');
          const label = dispatchedTask.length > 120 ? dispatchedTask.slice(0, 120) + '…' : dispatchedTask;
          appendMessage({
            id: nextId('g'),
            from: 'gateway',
            text: lang === 'zh'
              ? `🔄 我去检查一下…${label ? '\n' + label : ''}`
              : `🔄 Let me check…${label ? '\n' + label : ''}`,
            time: now,
          });
          onBuddyEventRef.current?.('working', msg);
          break;
        }
        case 'task_started':
          onBuddyEventRef.current?.('working', msg);
          break;
        case 'browser_task_started': {
          onBuddyEventRef.current?.('working', msg);
          const task = String((msg as any).task || '');
          if (task) {
            appendMessage({
              id: nextId('g'),
              from: 'gateway',
              text: lang === 'zh' ? `🌐 启动网页任务: ${task}` : `🌐 Starting web task: ${task}`,
              time: now,
            });
          }
          break;
        }
        case 'browser_task_result': {
          const m = msg as any;
          onBuddyEventRef.current?.(m.status === 'success' ? 'success' : 'error', msg);
          const statusLabel = m.status === 'success'
            ? (lang === 'zh' ? '✓ 任务完成' : '✓ Done')
            : (lang === 'zh' ? '✗ 任务失败' : '✗ Failed');
          const parts: string[] = [statusLabel];
          if (m.finalUrl) parts.push(`→ ${m.finalUrl}`);
          if (typeof m.steps === 'number' && m.steps > 0) parts.push(`${m.steps} ${lang === 'zh' ? '步' : 'steps'}`);
          if (typeof m.durationMs === 'number') parts.push(`${(m.durationMs / 1000).toFixed(1)}s`);
          if (m.error) parts.push(`(${m.error})`);
          appendMessage({
            id: nextId('g'),
            from: 'gateway',
            text: parts.join(' · '),
            time: now,
          });
          break;
        }
        case 'task_complete':
          onBuddyEventRef.current?.('success', msg);
          if ((msg as any).result) {
            const r = (msg as any).result;
            appendMessage({
              id: nextId('g'),
              from: 'gateway',
              text: typeof r === 'string' ? r : JSON.stringify(r),
              time: now,
            });
          }
          break;
        case 'confirmation_required': {
          const confirmId = String((msg as any).confirmId || '');
          if (confirmId) {
            setPendingConfirmation({
              kind: 'task',
              id: confirmId,
              description: String((msg as any).description || (lang === 'zh' ? '确认执行该任务？' : 'Confirm this task?')),
            });
          }
          break;
        }
        case 'browser_confirm_required': {
          const taskId = String((msg as any).taskId || '');
          if (taskId) {
            setPendingConfirmation({
              kind: 'browser',
              id: taskId,
              description: String((msg as any).description || (lang === 'zh' ? '确认网页操作？' : 'Confirm this browser action?')),
            });
          }
          break;
        }
        case 'task_cancelling':
          appendMessage({ id: nextId('sys'), from: 'system', text: lang === 'zh' ? '正在取消任务…' : 'Cancelling task…', time: now });
          break;
        case 'task_cancelled':
          appendMessage({ id: nextId('sys'), from: 'system', text: lang === 'zh' ? '任务已取消。' : 'Task cancelled.', time: now });
          break;
        case 'notification':
          if ((msg as any).message) {
            appendMessage({
              id: nextId('g'),
              from: 'gateway',
              text: (msg as any).message,
              time: now,
            });
          }
          break;
      }
    });
    return unsubscribe;
  }, [subscribe, lang, appendMessage, nextId]);

  const getStatusText = (s: ConnectionStatus): string => {
    if (booting) return lang === 'zh' ? '正在启动进程…' : 'Starting daemon…';
    switch (s) {
      case 'online': return t.gwOnline;
      case 'offline': return t.gwOffline;
      case 'starting': return t.gwStarting;
      case 'stopping': return t.gwStopping;
      case 'thinking': return t.gwThinking;
      case 'reconnecting': return lang === 'zh' ? '重连中…' : 'Reconnecting…';
    }
  };

  const effStatus: ConnectionStatus = booting ? 'starting' : status;

  const handlePowerClick = async () => {
    if (status === 'online' || status === 'thinking') {
      try { await ipcStop(); } catch {}
    } else if (status === 'offline' || status === 'reconnecting') {
      if (!honePath || !honePath.trim()) {
        setErrorMsg(lang === 'zh'
          ? '请先在设置中配置 hone 项目路径（包含 dist/cli.js 的目录）'
          : 'Please configure the hone project path in Settings first (the folder containing dist/cli.js).');
        return;
      }
      setErrorMsg(null);
      setBooting(true);
      appendMessage({
        id: nextId('sys'),
        from: 'system',
        text: lang === 'zh'
          ? '⏳ 正在启动 Hone 进程（Node 冷启动），通常需要 3-5 秒…'
          : '⏳ Starting Hone daemon (Node cold start), usually takes 3-5s…',
        time: formatTime(),
      });
      try {
        await ipcStart(honePath, relayUrl);
        reconnect();
      } catch (e: any) {
        setErrorMsg(e?.toString?.() ?? String(e));
      } finally {
        setBooting(false);
      }
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || status !== 'online') return;
    const now = formatTime();
    // appendMessage auto-creates a session if none is active, so we don't call
    // onCreateSession here — calling it would create an empty session via
    // setActiveChatSessionId (async), and the subsequent appendMessage would
    // still see the stale null activeSessionId and create ANOTHER session.
    appendMessage({ id: nextId('u'), from: 'user', text, time: now });
    setInput('');
    userScrolledUpRef.current = false;
    setTimeout(() => scrollToBottom('smooth'), 50);

    if (!sendChat(text)) {
      appendMessage({
        id: nextId('sys'),
        from: 'system',
        text: lang === 'zh'
          ? 'Hone 未连接 — 消息未发送。请先启动 Hone。'
          : 'Hone not connected — message not sent. Start Hone first.',
        time: formatTime(),
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const respondConfirmation = useCallback((approved: boolean) => {
    const pending = pendingConfirmation;
    if (!pending) return;
    const sent = send(pending.kind === 'browser'
      ? { type: 'browser_confirm', taskId: pending.id, approved }
      : { type: 'confirmation_response', confirmId: pending.id, approved });
    if (!sent) {
      appendMessage({
        id: nextId('sys'),
        from: 'system',
        text: lang === 'zh' ? '连接已断开，无法确认该操作。' : 'Connection lost; this action could not be confirmed.',
        time: formatTime(),
      });
      return;
    }
    setPendingConfirmation(null);
    appendMessage({
      id: nextId('sys'),
      from: 'system',
      text: approved
        ? (lang === 'zh' ? '已批准操作。' : 'Action approved.')
        : (lang === 'zh' ? '已拒绝操作。' : 'Action rejected.'),
      time: formatTime(),
    });
  }, [appendMessage, lang, nextId, pendingConfirmation, send]);

  const handleQuickAction = (action: string) => {
    setChatSearch('');
    if (status !== 'online') return;
    const now = formatTime();
    // onCreateSession 返回新会话 id（同步），无 activeSession 时必须先创建会话再 appendMessage。
    // 旧代码丢弃返回值并在 null session 上 appendMessage，会导致 appendMessage 内部
    // 再次自动创建会话，最终一条消息产生两个会话。
    const sessionId = activeSession || onCreateSession();
    // sessionId 已确认存在，可直接 append（appendMessage 会根据当前 activeSession 路由）
    void sessionId;
    appendMessage({ id: nextId('u'), from: 'user', text: action, time: now });
    if (!sendChat(action)) {
      appendMessage({
        id: nextId('sys'),
        from: 'system',
        text: lang === 'zh' ? 'Hone 离线 — 无法执行快捷操作。' : 'Hone offline — cannot execute quick action.',
        time: formatTime(),
      });
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

  const inputDisabled = booting || status === 'offline' || status === 'stopping' || status === 'reconnecting' || status === 'starting' || !apiKeyConfigured;

  const powerColors: Record<string, { bg: string; glow: string }> = {
    online: { bg: 'var(--hone-primary, #6366F1)', glow: '0 0 8px rgba(99,102,241,0.5)' },
    offline: { bg: 'var(--hone-success, #22C55E)', glow: '0 0 6px rgba(34,197,94,0.4)' },
    starting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    stopping: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
    reconnecting: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.6)' },
    thinking: { bg: 'var(--hone-accent, #D4A853)', glow: '0 0 6px rgba(212,168,83,0.4)' },
  };
  const pc = powerColors[effStatus] ?? powerColors.offline;

  const fmtDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const styles: Record<string, any> = {
    root: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--hone-bg, #0C0E12)', color: 'var(--hone-text, #E4E8F0)' },
    // Sidebar: session list
    sidebar: (collapsed: boolean): React.CSSProperties => ({
      width: collapsed ? 42 : 220, flexShrink: 0, display: 'flex', flexDirection: 'column' as const,
      borderRight: '1px solid var(--hone-border, #252A36)', background: 'var(--hone-surface, #13161C)',
      transition: 'width 0.2s ease', position: 'relative' as const, overflow: 'hidden' as const,
    }),
    sidebarHead: (collapsed: boolean): React.CSSProperties => ({
      padding: collapsed ? '10px 8px' : '10px 12px', display: 'flex', alignItems: 'center',
      justifyContent: collapsed ? 'center' : 'space-between',
      borderBottom: '1px solid var(--hone-border, #252A36)', gap: 8,
      flexShrink: 0, minHeight: 44, boxSizing: 'border-box' as const,
      position: 'relative' as const, zIndex: 2,
    }),
    sidebarTitle: { fontSize: 13, fontWeight: 600, flexShrink: 0, minWidth: 0 },
    headActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 'fit-content' as const },
    collapseBtn: {
      width: 26, height: 26, borderRadius: 6, border: '1px solid var(--hone-border, #252A36)',
      background: 'var(--hone-surfaceRaised, #1A1E26)', color: 'var(--hone-text, #E4E8F0)',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
      flexShrink: 0, flexGrow: 0,
    },
    newChatBtn: (collapsed: boolean): React.CSSProperties => ({
      fontSize: collapsed ? 16 : 12,
      padding: collapsed ? '4px 0' : '4px 10px',
      width: collapsed ? 26 : 'auto',
      minWidth: collapsed ? 26 : 72,
      height: collapsed ? 26 : 'auto',
      minHeight: collapsed ? 26 : 26,
      borderRadius: 6, border: 'none',
      background: 'linear-gradient(135deg, #6366F1, #4F46E5)', color: '#fff',
      cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, flexGrow: 0,
    }),
    sessionList: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
    sessionItem: (active: boolean): React.CSSProperties => ({
      padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--hone-border, #252A36)',
      background: active ? 'var(--hone-primaryMuted, #1E2030)' : 'transparent',
      color: active ? 'var(--hone-primary, #6366F1)' : 'var(--hone-text, #E4E8F0)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    }),
    sessionTitle: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1, minWidth: 0 },
    sessionMeta: { fontSize: 10, color: 'var(--hone-muted, #6B7285)', marginTop: 2 },
    sessionMenuBtn: {
      width: 20, height: 20, borderRadius: 4, border: 'none', background: 'transparent',
      color: 'var(--hone-muted, #6B7285)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    emptySessions: { padding: 16, fontSize: 12, color: 'var(--hone-muted, #6B7285)', textAlign: 'center' as const },
    // Main chat area
    main: { flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' },
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
      background: effStatus === 'online' ? 'var(--hone-success, #2ECC80)'
        : effStatus === 'offline' ? '#6B7285'
        : effStatus === 'reconnecting' ? '#F0A030'
        : 'var(--hone-accent, #D4A853)',
      flexShrink: 0,
      animation: (effStatus === 'reconnecting' || effStatus === 'starting') ? 'pulse 0.8s ease-in-out infinite' : undefined,
    },
    gwLabel: { fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' as const },
    statusText: { fontSize: 11, color: 'var(--hone-muted, #6B7285)' },
    searchInput: {
      background: 'var(--hone-surfaceRaised, #1A1E26)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 4,
      padding: '3px 8px', fontSize: 11, color: 'var(--hone-text, #E4E8F0)',
      outline: 'none', width: 160, boxSizing: 'border-box' as const,
      flexShrink: 0,
    },
    headerRight: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
    headerNewChatBtn: {
      fontSize: 12, padding: '4px 10px', borderRadius: 6, border: 'none',
      background: 'linear-gradient(135deg, #6366F1, #4F46E5)', color: '#fff',
      cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, whiteSpace: 'nowrap' as const,
    },
    messagesArea: {
      flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
      scrollPaddingTop: 8,
    },
    msgRow: (from: string): React.CSSProperties => ({
      display: 'flex', gap: 8, alignItems: 'flex-end',
      flexDirection: from === 'user' ? 'row-reverse' : 'row',
    }),
    avatar: (from: string): React.CSSProperties => ({
      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14,
      background: from === 'user' ? 'rgba(99, 102, 241, 0.15)'
        : from === 'system' ? 'rgba(56, 189, 248, 0.12)'
        : 'rgba(34, 197, 94, 0.12)',
    }),
    bubble: (from: string): React.CSSProperties => ({
      maxWidth: '70%', padding: '9px 13px', fontSize: 13, lineHeight: 1.55,
      borderRadius: from === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
      background: from === 'user' ? 'linear-gradient(135deg, #6366F1, #4F46E5)'
        : from === 'system' ? 'rgba(56, 189, 248, 0.08)'
        : 'var(--hone-surfaceRaised, #1A1E26)',
      color: from === 'user' ? '#FFFFFF'
        : from === 'system' ? '#7DD3FC'
        : 'var(--hone-text, #E4E8F0)',
      border: from === 'user' ? 'none'
        : from === 'system' ? '1px solid rgba(56, 189, 248, 0.25)'
        : '1px solid var(--hone-border, #252A36)',
      boxShadow: from === 'user' ? '0 1px 3px rgba(99, 102, 241, 0.25)' : 'none',
    }),
    msgTime: {
      fontSize: 9, textAlign: 'right' as const, fontFamily: '"JetBrains Mono", monospace',
      marginTop: 4, opacity: 0.55,
    },
    noResults: { textAlign: 'center' as const, color: 'var(--hone-muted, #6B7285)', fontSize: 13, paddingTop: 24 },
    quickRow: {
      display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto' as const,
      borderTop: '1px solid var(--hone-border, #252A36)', flexShrink: 0,
    },
    pill: {
      whiteSpace: 'nowrap' as const, padding: '5px 13px', borderRadius: 20,
      border: '1px solid var(--hone-border, #252A36)', fontSize: 11,
      background: 'var(--hone-surfaceRaised, #1A1E26)', color: 'var(--hone-text, #E4E8F0)',
      cursor: 'pointer', flexShrink: 0, transition: 'border-color 0.15s, background 0.15s',
    },
    inputRow: {
      display: 'flex', gap: 8, padding: '8px 12px',
      borderTop: '1px solid var(--hone-border, #252A36)',
      background: 'var(--hone-surface, #13161C)', flexShrink: 0,
    },
    textInput: {
      flex: 1, background: 'var(--hone-surfaceRaised, #1A1E26)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 8,
      padding: '8px 12px', fontSize: 13, color: 'var(--hone-text, #E4E8F0)',
      outline: 'none', boxSizing: 'border-box' as const,
      transition: 'border-color 0.15s',
    },
    sendBtn: {
      background: inputDisabled ? 'var(--hone-muted, #6B7285)' : 'linear-gradient(135deg, #6366F1, #4F46E5)',
      color: '#FFFFFF', border: 'none', borderRadius: 8,
      padding: '8px 18px', fontSize: 13, fontWeight: 500, cursor: inputDisabled ? 'not-allowed' : 'pointer',
      boxShadow: inputDisabled ? 'none' : '0 1px 3px rgba(99, 102, 241, 0.3)',
    },
  };

  const getPowerSymbol = (): React.ReactNode => {
    const color = '#FFFFFF';
    switch (effStatus) {
      case 'online':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v8" />
            <path d="M5 5.5C3.5 7.5 3 10 3 12a9 9 0 1 0 18 0c0-2-.5-4.5-2-6.5" />
          </svg>
        );
      case 'starting':
      case 'stopping':
      case 'reconnecting':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        );
      case 'offline':
      default:
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v8" />
            <path d="M5 5.5C3.5 7.5 3 10 3 12a9 9 0 1 0 18 0c0-2-.5-4.5-2-6.5" />
          </svg>
        );
    }
  };

  return (
    <div style={styles.root}>
      {/* Session sidebar */}
      <div style={styles.sidebar(sidebarCollapsed)}>
        <div style={styles.sidebarHead(sidebarCollapsed)}>
          {!sidebarCollapsed && <span style={styles.sidebarTitle}>{lang === 'zh' ? '会话历史' : 'Chat history'}</span>}
          <div style={styles.headActions}>
            <button
              style={styles.newChatBtn(sidebarCollapsed)}
              onClick={() => {
                const id = onCreateSession();
                announcedOnceRef.current = false;
                setSidebarCollapsed(false);
              }}
              title={lang === 'zh' ? '新建对话' : 'New chat'}
            >
              {sidebarCollapsed ? '+' : (lang === 'zh' ? '+ 新对话' : '+ New chat')}
            </button>
            <button
              style={styles.collapseBtn}
              onClick={() => setSidebarCollapsed(c => !c)}
              title={sidebarCollapsed ? (lang === 'zh' ? '展开' : 'Expand') : (lang === 'zh' ? '折叠' : 'Collapse')}
            >
              {sidebarCollapsed ? '▶' : '◀'}
            </button>
          </div>
        </div>
        {!sidebarCollapsed && (
        <div style={styles.sessionList}>
          {sessions.length === 0 ? (
            <div style={styles.emptySessions}>
              {lang === 'zh' ? '还没有会话。点击上方按钮开始新对话。' : 'No sessions yet. Click above to start a new chat.'}
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                style={styles.sessionItem(activeSessionId === s.id)}
                onClick={() => onSelectSession(s.id)}
              >
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => {
                      if (renameText.trim()) onRenameSession(s.id, renameText.trim());
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (renameText.trim()) onRenameSession(s.id, renameText.trim());
                        setRenamingId(null);
                      } else if (e.key === 'Escape') {
                        setRenamingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      flex: 1, fontSize: 12, background: 'var(--hone-surfaceRaised)',
                      border: '1px solid var(--hone-border)', borderRadius: 4, color: 'var(--hone-text)',
                      padding: '2px 6px', outline: 'none',
                    }}
                  />
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.sessionTitle}>{s.title}</div>
                    <div style={styles.sessionMeta}>{fmtDate(s.updatedAt)} · {s.messages.length} {lang === 'zh' ? '条' : 'msgs'}</div>
                  </div>
                )}
                <div style={{ position: 'relative' }}>
                  <button
                    style={styles.sessionMenuBtn}
                    onClick={(e) => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id); }}
                  >
                    ⋮
                  </button>
                  {sessionMenuId === s.id && (
                    <div
                      style={{
                        position: 'absolute', right: 0, top: '100%', zIndex: 100,
                        background: 'var(--hone-surfaceRaised)', border: '1px solid var(--hone-border)',
                        borderRadius: 6, padding: '4px 0', minWidth: 80,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                      }}
                    >
                      <button
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, background: 'transparent', border: 'none', color: 'var(--hone-text)', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); setRenameText(s.title); setRenamingId(s.id); setSessionMenuId(null); }}
                      >
                        {lang === 'zh' ? '重命名' : 'Rename'}
                      </button>
                      <button
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 12, background: 'transparent', border: 'none', color: 'var(--hone-danger)', cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(lang === 'zh' ? `删除会话「${s.title}」？` : `Delete session "${s.title}"?`)) {
                            onDeleteSession(s.id);
                          }
                          setSessionMenuId(null);
                        }}
                      >
                        {lang === 'zh' ? '删除' : 'Delete'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        )}
      </div>

      {/* Main chat */}
      <div style={styles.main}>
        <div style={styles.header}>
          <button
            style={{
              ...styles.powerBtn,
              animation: effStatus === 'starting' || effStatus === 'stopping' || effStatus === 'reconnecting' ? 'pulse 1s ease-in-out infinite' : undefined,
              cursor: booting ? 'wait' : 'pointer',
            }}
            onClick={handlePowerClick}
            disabled={booting}
            title={effStatus === 'online' ? t.gwStop : t.gwStart}
          >
            {getPowerSymbol()}
          </button>
          <div style={styles.statusDot} />
          <span style={styles.gwLabel}>{t.gwTitle}</span>
          <span style={styles.statusText}>{getStatusText(status)}</span>
          <div style={styles.headerRight}>
            <button
              style={styles.headerNewChatBtn}
              onClick={() => {
                const id = onCreateSession();
                announcedOnceRef.current = false;
                setSidebarCollapsed(false);
              }}
              title={lang === 'zh' ? '新建对话' : 'New chat'}
            >
              {lang === 'zh' ? '+ 新对话' : '+ New chat'}
            </button>
            <input
              style={styles.searchInput}
              placeholder={t.gwSearch}
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
            />
          </div>
        </div>

        {(errorMsg || connection.error || startError) && (
          <div style={{
            margin: '0 12px 12px', padding: '8px 12px', background: 'rgba(244, 88, 88, 0.1)',
            border: '1px solid var(--hone-danger)', borderRadius: 8, color: '#F45858', fontSize: 11, lineHeight: 1.4
          }}>
            <strong>{lang === 'zh' ? '错误: ' : 'Error: '}</strong>
            {errorMsg || connection.error || startError}
            {connection.error && lang === 'zh' && (
              <div style={{ marginTop: 4, opacity: 0.85 }}>
                Hone 进程已启动，但无法连接中继服务器。请检查：
                <br />1. 网络/代理是否放行 <code>wss://</code> 连接
                <br />2. 在设置里换一个可达的中继地址
              </div>
            )}
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

        <div ref={messagesRef} style={styles.messagesArea}>
          {filteredMessages.length === 0 ? (
            <div style={styles.noResults}>{lang === 'zh' ? '没有匹配的对话' : 'No messages yet'}</div>
          ) : (
            filteredMessages.map((msg) => (
              <div key={msg.id} style={styles.msgRow(msg.from)}>
                <div style={styles.avatar(msg.from)}>
                  {msg.from === 'gateway' ? '🤖' : msg.from === 'system' ? 'ℹ️' : '👤'}
                </div>
                <div style={styles.bubble(msg.from)}>
                  {msg.from === 'user' ? (
                    <div>{getMessageText(msg)}</div>
                  ) : (
                    <MdText text={getMessageText(msg)} />
                  )}
                  <div style={styles.msgTime}>{msg.time}</div>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div style={styles.quickRow}>
          {(() => {
            const quickDisabled = status !== 'online' || !apiKeyConfigured;
            const pillStyle = { ...styles.pill, ...(quickDisabled ? { opacity: 0.5, cursor: 'not-allowed' as const } : {}) };
            return <>
              <button style={pillStyle} disabled={quickDisabled} onClick={() => handleQuickAction(`⚡ ${t.gwQuickDispatch}`)}>
                {'⚡ '}{t.gwQuickDispatch}
              </button>
              <button style={pillStyle} disabled={quickDisabled} onClick={() => handleQuickAction(`📊 ${t.gwQuickStatus}`)}>
                {'📊 '}{t.gwQuickStatus}
              </button>
              <button style={pillStyle} disabled={quickDisabled} onClick={() => handleQuickAction(`📅 ${t.gwQuickSchedule}`)}>
                {'📅 '}{t.gwQuickSchedule}
              </button>
              <button style={pillStyle} disabled={quickDisabled} onClick={() => handleQuickAction(`🎨 ${t.gwQuickCanvas}`)}>
                {'🎨 '}{t.gwQuickCanvas}
              </button>
              <button style={pillStyle} disabled={quickDisabled} onClick={() => setLoginModalOpen(true)}>
                {'🌐 '}{lang === 'zh' ? '浏览器登录' : 'Browser Login'}
              </button>
            </>;
          })()}
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
                      appendMessage({
                        id: nextId('sys'),
                        from: 'system',
                        text: lang === 'zh' ? 'Hone 离线 — 无法打开浏览器' : 'Hone offline — cannot open browser',
                        time: formatTime(),
                      });
                    }
                    setLoginModalOpen(false);
                    setLoginProfile('');
                    setLoginUrl('');
                  }}
                  disabled={!loginProfile.trim()}
                  style={{
                    padding: '7px 16px', fontSize: 13, borderRadius: 6,
                    background: 'var(--hone-accent)', color: '#0C0E12',
                    border: 'none', cursor: 'pointer', fontWeight: 600,
                    opacity: loginProfile.trim() ? 1 : 0.5,
                  }}
                >
                  {lang === 'zh' ? '打开浏览器登录' : 'Open Browser'}
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingConfirmation && (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 10001,
              background: 'var(--hone-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div style={{
              width: 500, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 60px)',
              display: 'flex', flexDirection: 'column', gap: 14, padding: 24, borderRadius: 8,
              background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
              border: '1px solid var(--hone-accent)',
            }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                {lang === 'zh' ? '确认操作' : 'Confirm action'}
              </h2>
              <pre style={{
                margin: 0, padding: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                borderRadius: 6, border: '1px solid var(--hone-border)', background: 'var(--hone-bg)',
                fontSize: 12, lineHeight: 1.55, fontFamily: 'ui-monospace, Consolas, monospace',
              }}>
                {pendingConfirmation.description}
              </pre>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={() => respondConfirmation(false)}
                  style={{ padding: '8px 16px', fontSize: 13, borderRadius: 6, background: 'transparent', color: 'var(--hone-danger)', border: '1px solid var(--hone-danger)', cursor: 'pointer' }}
                >
                  {lang === 'zh' ? '拒绝' : 'Reject'}
                </button>
                <button
                  onClick={() => respondConfirmation(true)}
                  style={{ padding: '8px 16px', fontSize: 13, borderRadius: 6, background: 'var(--hone-accent)', color: '#0C0E12', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                >
                  {lang === 'zh' ? '批准' : 'Approve'}
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
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default GatewayChat;
