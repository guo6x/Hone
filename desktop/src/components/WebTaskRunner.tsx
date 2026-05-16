import React, { useState, useRef, useEffect } from 'react';
import { type Lang, LANG } from '../i18n/translations';

interface WebTaskResult {
  id: string;
  task: string;
  status: 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';
  finalUrl?: string;
  steps: number;
  durationMs?: number;
  error?: string;
  startTime: number;
}

interface ChatMessage {
  id: string;
  from: 'user' | 'agent' | 'system';
  text: string;
  time: string;
  result?: WebTaskResult;
}

interface Props {
  lang: Lang;
  relayUrl: string;
}

function formatTime(): string {
  return `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
}

let taskIdCounter = 0;

const WebTaskRunner: React.FC<Props> = ({ lang, relayUrl }) => {
  const t = LANG[lang];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef(`web_${Date.now()}`);
  const registeredRef = useRef(false);

  // Auto-connect to relay
  useEffect(() => {
    if (!relayUrl) return;

    const connect = () => {
      const ws = new WebSocket(relayUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'register',
          role: 'client',
          clientId: clientIdRef.current,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'registered') {
            registeredRef.current = true;
          }

          if (msg.type === 'browser_task_result') {
            const taskResult: WebTaskResult = {
              id: msg.taskId || '',
              task: '',
              status: msg.status || 'failed',
              finalUrl: msg.finalUrl,
              steps: msg.steps || 0,
              durationMs: msg.durationMs,
              error: msg.error,
              startTime: Date.now(),
            };
            setMessages(prev => {
              const updated = [...prev];
              // Find last user message and attach result
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].from === 'user' && !updated[i].result) {
                  updated[i] = { ...updated[i], result: taskResult };
                  break;
                }
              }
              // Add agent response
              const statusText = taskResult.status === 'success'
                ? `任务完成！${taskResult.finalUrl ? ` 最终页面: ${taskResult.finalUrl}` : ''} (${taskResult.steps} 步, ${((taskResult.durationMs || 0) / 1000).toFixed(1)}s)`
                : `任务失败: ${taskResult.error || taskResult.status}`;
              updated.push({
                id: 'a' + Date.now(),
                from: 'agent',
                text: statusText,
                time: formatTime(),
                result: taskResult,
              });
              return updated;
            });
            setRunning(false);
          }

          if (msg.type === 'browser_task_started') {
            setMessages(prev => [...prev, {
              id: 'a' + Date.now(),
              from: 'agent',
              text: `正在执行: ${msg.task || ''}`,
              time: formatTime(),
            }]);
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        registeredRef.current = false;
      };

      ws.onerror = () => {};
    };

    connect();
    return () => { wsRef.current?.close(); };
  }, [relayUrl]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || running) return;

    const now = formatTime();
    setMessages(prev => [...prev, {
      id: 'u' + Date.now(),
      from: 'user',
      text,
      time: now,
    }]);
    setInput('');
    setRunning(true);

    // Send via relay WebSocket — gateway LLM auto-parses browser intent
    if (wsRef.current?.readyState === WebSocket.OPEN && registeredRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        clientId: clientIdRef.current,
        payload: { text },
      }));
      return;
    }

    // No relay connection — show clear offline message
    setMessages(prev => [...prev, {
      id: 'a' + Date.now(),
      from: 'system',
      text: lang === 'zh'
        ? 'Gateway 未连接 — 网页任务需要 Gateway 在线才能执行。请检查 Gateway 是否已启动并连接到中继。'
        : 'Gateway offline — web tasks require Gateway to be online. Check if Gateway is running and connected to relay.',
      time: formatTime(),
    }]);
    setRunning(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const statusBadgeStyle = (status: string): React.CSSProperties => ({
    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
    background: status === 'success' ? '#2ECC8020' : status === 'failed' ? '#F4585820' : '#D4A85320',
    color: status === 'success' ? 'var(--hone-success, #2ECC80)' : status === 'failed' ? 'var(--hone-danger, #F45858)' : 'var(--hone-accent, #D4A853)',
  });

  const s: Record<string, any> = {
    wrapper: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--hone-bg)', color: 'var(--hone-text)' },
    header: { padding: '14px 16px', borderBottom: '1px solid var(--hone-border)', flexShrink: 0 },
    title: { fontSize: 15, fontWeight: 600, margin: 0 },
    desc: { fontSize: 12, color: 'var(--hone-muted)', marginTop: 2 },
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
      fontSize: 14,
      background: from === 'user' ? 'var(--hone-accentMuted, #24201A)'
        : from === 'system' ? 'var(--hone-surface, #13161C)'
        : 'var(--hone-surfaceOverlay, #222733)',
    }),
    bubble: (from: string): React.CSSProperties => ({
      maxWidth: '75%', padding: '8px 12px', fontSize: 13, lineHeight: 1.5,
      borderRadius: from === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
      background: from === 'user' ? 'var(--hone-accent, #D4A853)'
        : from === 'system' ? 'var(--hone-surface, #13161C)'
        : 'var(--hone-surfaceRaised, #1A1E26)',
      color: from === 'user' ? '#0C0E12'
        : from === 'system' ? 'var(--hone-warning, #f59e0b)'
        : 'var(--hone-text, #E4E8F0)',
      border: from === 'user' ? '1px solid var(--hone-accentHover, #C49B40)'
        : from === 'system' ? '1px solid var(--hone-warning, #f59e0b)'
        : '1px solid var(--hone-border, #252A36)',
    }),
    msgTime: {
      fontSize: 9, textAlign: 'right' as const, fontFamily: '"JetBrains Mono", monospace',
      marginTop: 4, opacity: 0.6,
    },
    resultCard: {
      marginTop: 6, padding: '6px 8px', borderRadius: 4, fontSize: 11,
      background: 'var(--hone-bg)', border: '1px solid var(--hone-border)',
    },
    empty: {
      flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
      justifyContent: 'center', color: 'var(--hone-muted)', padding: 40, textAlign: 'center' as const,
    },
    emptyTitle: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--hone-text)' },
    emptyDesc: { fontSize: 13, maxWidth: 400, lineHeight: 1.6 },
    inputRow: {
      display: 'flex', gap: 8, padding: '8px 12px',
      borderTop: '1px solid var(--hone-border)',
      background: 'var(--hone-surface)', flexShrink: 0,
    },
    textInput: {
      flex: 1, background: 'var(--hone-surfaceRaised)', border: '1px solid var(--hone-border)',
      borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--hone-text)',
      outline: 'none', boxSizing: 'border-box' as const,
    },
    sendBtn: {
      background: running ? 'var(--hone-muted)' : 'var(--hone-accent)',
      color: '#0C0E12', border: 'none', borderRadius: 6,
      padding: '8px 18px', fontSize: 13, fontWeight: 500,
      cursor: running ? 'not-allowed' : 'pointer',
    },
  };

  return (
    <div style={s.wrapper}>
      <div style={s.header}>
        <h2 style={s.title}>{t.webtaskTitle}</h2>
        <p style={s.desc}>{t.webtaskDesc}</p>
      </div>

      <div style={s.messagesArea}>
        {messages.length === 0 ? (
          <div style={s.empty}>
            <div style={s.emptyTitle}>{t.webtaskEmpty}</div>
            <div style={s.emptyDesc}>{t.webtaskEmptyDesc}</div>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} style={s.msgRow(msg.from)}>
              <div style={s.avatar(msg.from)}>
                {msg.from === 'agent' ? '\u{1F916}' : msg.from === 'system' ? '\u2139\uFE0F' : '\u{1F464}'}
              </div>
              <div>
                <div style={s.bubble(msg.from)}>
                  <div>{msg.text}</div>
                  <div style={s.msgTime}>{msg.time}</div>
                </div>
                {msg.result && (
                  <div style={s.resultCard}>
                    <span style={statusBadgeStyle(msg.result.status)}>
                      {msg.result.status === 'success' ? t.webtaskSuccess : msg.result.status === 'failed' ? t.webtaskFailed : msg.result.status}
                    </span>
                    {msg.result.steps > 0 && <span style={{ marginLeft: 8 }}>{msg.result.steps} {t.webtaskSteps}</span>}
                    {msg.result.durationMs != null && <span style={{ marginLeft: 8 }}>{((msg.result.durationMs || 0) / 1000).toFixed(1)}s</span>}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {running && (
          <div style={{ ...s.msgRow('agent'), opacity: 0.7 }}>
            <div style={s.avatar('agent')}>{'\u{1F916}'}</div>
            <div style={s.bubble('agent')}>
              <div>执行中…</div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={s.inputRow}>
        <input
          style={s.textInput}
          placeholder={t.webtaskPlaceholder}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
        />
        <button style={s.sendBtn} onClick={handleSend} disabled={running || !input.trim()}>
          {t.gwSend}
        </button>
      </div>
    </div>
  );
};

export default WebTaskRunner;
