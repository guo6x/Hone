import React, { useState, useEffect, useMemo, useRef } from 'react';
import { type Lang, LANG } from '../i18n/translations';
import { isTauri } from '../tauri/useTauri';
import { canvasDocumentsList, type CanvasDocumentInfo } from '../tauri/api';

/** Minimal markdown → HTML converter. Handles headers, lists, code, bold, italic, links. */
function mdToHtml(src: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = src.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';
  const flushList = () => { if (inList) { out.push(`</${listType}>`); inList = false; } };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const cmFence = ln.match(/^```(\w*)$/);
    if (cmFence) {
      if (inCode) {
        out.push(`<pre><code class="lang-${codeLang}">${escape(codeBuf.join('\n'))}</code></pre>`);
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        flushList(); inCode = true; codeLang = cmFence[1] || '';
      }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }

    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushList(); const lv = h[1].length; out.push(`<h${lv}>${inline(escape(h[2]))}</h${lv}>`); continue; }

    const ul = ln.match(/^\s*[-*]\s+(.*)$/);
    const ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const desired: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (!inList || listType !== desired) { flushList(); listType = desired; out.push(`<${desired}>`); inList = true; }
      out.push(`<li>${inline(escape((ul || ol)![1]))}</li>`);
      continue;
    }

    if (ln.trim() === '') { flushList(); out.push(''); continue; }

    flushList();
    out.push(`<p>${inline(escape(ln))}</p>`);
  }
  if (inCode) out.push(`<pre><code>${escape(codeBuf.join('\n'))}</code></pre>`);
  flushList();
  return out.join('\n');
}

/** Whitelist of URL schemes safe to render in <a href>. Blocks javascript:, data:, etc. */
function safeUrl(raw: string): string {
  const trimmed = raw.trim();
  // Allow only http/https/mailto/relative paths. Anything else (incl javascript:,
  // data:, vbscript:) becomes '#' so a malicious markdown link can't fire scripts.
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^\/[^/]/.test(trimmed) || /^\.{0,2}\//.test(trimmed)) return trimmed;
  return '#';
}

function inline(s: string): string {
  // Bold **x**, italic *x*, inline code `x`, links [t](u).
  // Link URLs go through safeUrl() so `[click](javascript:alert(1))` can't XSS.
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) =>
      `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

interface Doc {
  id: number;
  ts: number;
  title: string;
  text: string;
  kind: 'markdown' | 'html' | 'text';
  intent?: string;
}

function classifyKind(text: string): Doc['kind'] {
  const trimmed = text.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return 'html';
  if (/^#{1,6}\s|^- |^\* |```/m.test(trimmed)) return 'markdown';
  return 'text';
}

function makeTitle(text: string): string {
  const trimmed = text.trim();
  // First markdown header wins
  const h = trimmed.match(/^#{1,6}\s+(.+)$/m);
  if (h) return h[1].slice(0, 80);
  // First non-empty line
  const first = trimmed.split('\n').find(l => l.trim().length > 0) || '(空)';
  return first.slice(0, 80);
}

interface Props {
  lang: Lang;
  connection?: {
    send: (msg: Record<string, unknown>) => boolean;
    subscribe: (cb: (msg: any) => void) => () => void;
  };
}

const CanvasViewer: React.FC<Props> = ({ lang, connection }) => {
  const t = LANG[lang];
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Mirror selectedId into a ref so mergeDocs (defined inside an effect that
  // doesn't re-run on selectedId changes) always reads the latest value.
  const selectedIdRef = useRef<number | null>(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    let gatewayDocs: Doc[] = [];
    let localDocs: Doc[] = [];
    const mergeDocs = () => {
      // Merge local canvas sessions with gateway messages, local first
      const merged = [...localDocs, ...gatewayDocs];
      setDocs(merged);
      setLoading(false);
      if (merged.length > 0 && selectedIdRef.current === null) setSelectedId(merged[0].id);
    };

    // 1. Fetch local canvas sessions via Tauri IPC
    if (isTauri()) {
      canvasDocumentsList().then((sessions: CanvasDocumentInfo[]) => {
        localDocs = sessions.map((s, index) => ({
          id: -(index + 1),
          ts: new Date(s.modified_at).getTime() || Date.now(),
          title: s.name,
          text: s.content,
          kind: classifyKind(s.content),
          intent: 'canvas',
        }));
        mergeDocs();
      }).catch((e) => {
        // Don't swallow IPC errors silently — surface them so the user knows
        // why local canvas documents aren't showing. Gateway docs (if any)
        // still get merged below.
        const msg = String(e?.message || e);
        setErr(lang === 'zh' ? `本地画布加载失败: ${msg}` : `Local canvas load failed: ${msg}`);
        mergeDocs();
      });
    }

    // 2. Also fetch from Gateway WebSocket
    if (!connection) {
      setErr(lang === 'zh' ? 'Gateway 未连接' : 'Gateway not connected');
      mergeDocs();
      return;
    }
    const unsub = connection.subscribe((msg: any) => {
      if (msg.type === 'messages_list_response') {
        const list: Doc[] = (msg.messages || [])
          .filter((m: any) => m.direction === 'out' && (m.text || '').length >= 80)
          .map((m: any) => ({
            id: m.id,
            ts: m.ts,
            title: makeTitle(m.text),
            text: m.text,
            kind: classifyKind(m.text),
            intent: m.intent_action,
          }))
          .reverse(); // newest first
        gatewayDocs = list;
        mergeDocs();
      }
    });
    const sent = connection.send({ type: 'messages_list_request', limit: 200 });
    if (!sent) {
      setErr(lang === 'zh' ? 'Gateway 离线' : 'Gateway offline');
      mergeDocs();
    }
    const refreshTimer = setInterval(() => {
      connection.send({ type: 'messages_list_request', limit: 200 });
    }, 15000);
    return () => { unsub(); clearInterval(refreshTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, lang]);

  const selected = useMemo(() => docs.find(d => d.id === selectedId) || null, [docs, selectedId]);

  const fmtDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const html = useMemo(() => {
    if (!selected) return '';
    if (selected.kind === 'html') return selected.text;
    if (selected.kind === 'markdown') return mdToHtml(selected.text);
    return `<pre>${selected.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  }, [selected]);

  return (
    <div style={styles.root}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHead}>
          {lang === 'zh' ? 'Agent 产出' : 'Agent Outputs'}
          <span style={styles.count}>{docs.length}</span>
        </div>
        {loading && (
          <div style={styles.empty}>{lang === 'zh' ? '加载中…' : 'Loading…'}</div>
        )}
        {err && (
          <div style={{ ...styles.empty, color: 'var(--hone-danger)' }}>{err}</div>
        )}
        {!loading && !err && docs.length === 0 && (
          <div style={styles.empty}>
            {lang === 'zh' ? '还没有产出。让 agent 写点文档/方案/代码，会自动出现在这里。' : 'No outputs yet. Ask the agent to write something.'}
          </div>
        )}
        <div style={styles.list}>
          {docs.map(d => (
            <div
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              style={{
                ...styles.listItem,
                background: d.id === selectedId ? 'var(--hone-accentMuted)' : 'transparent',
                color: d.id === selectedId ? 'var(--hone-accent)' : 'var(--hone-text)',
              }}
            >
              <div style={styles.itemTitle}>{d.title}</div>
              <div style={styles.itemMeta}>
                <span>{fmtDate(d.ts)}</span>
                <span style={styles.itemKind}>{d.kind}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={styles.main}>
        {selected ? (
          <>
            <div style={styles.toolbar}>
              <span style={styles.toolTitle}>{selected.title}</span>
              <span style={styles.toolMeta}>{fmtDate(selected.ts)} · {selected.kind}</span>
              <button
                style={styles.toolBtn}
                onClick={() => navigator.clipboard?.writeText(selected.text)}
              >
                {lang === 'zh' ? '复制原文' : 'Copy'}
              </button>
              {selected.kind === 'html' && (
                <button
                  style={styles.toolBtn}
                  onClick={() => {
                    const blob = new Blob([selected.text], { type: 'text/html' });
                    const url = URL.createObjectURL(blob);
                    window.open(url, '_blank', 'noopener,noreferrer');
                  }}
                >
                  {lang === 'zh' ? '外部打开' : 'Open'}
                </button>
              )}
            </div>
            {selected.kind === 'html' ? (
              <iframe
                style={styles.iframe}
                srcDoc={`<style>
                  body { font-family: -apple-system, system-ui, sans-serif; padding: 20px; line-height: 1.6; color: #E4E8F0; background: #0C0E12; }
                  pre { background: #1A1E26; padding: 12px; border-radius: 6px; overflow-x: auto; }
                  code { font-family: 'JetBrains Mono', monospace; font-size: 13px; }
                  a { color: #D4A853; }
                  h1, h2, h3 { color: #fff; }
                </style>${selected.text}`}
                // Strictest sandbox: no same-origin, no scripts, no forms.
                // The HTML comes from gateway/agent output and must not be
                // able to touch the parent window's localStorage/cookies or
                // run arbitrary scripts.
                sandbox=""
                title={selected.title}
              />
            ) : (
              <div className="hone-canvas-doc" style={styles.content} dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </>
        ) : (
          <div style={styles.emptyMain}>
            <div style={styles.emptyIcon}>🎨</div>
            <div style={styles.emptyTitle}>{t.canvasEmptyTitle || (lang === 'zh' ? '画布' : 'Canvas')}</div>
            <div style={styles.emptyDesc}>
              {lang === 'zh'
                ? '这里会自动汇总 agent 写过的所有文档、方案、报告。让它写点东西就有了。'
                : 'All long-form agent outputs appear here. Ask the agent to write something.'}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .hone-canvas-doc h1 { font-size: 24px; margin: 16px 0 8px; }
        .hone-canvas-doc h2 { font-size: 20px; margin: 14px 0 8px; }
        .hone-canvas-doc h3 { font-size: 16px; margin: 12px 0 6px; }
        .hone-canvas-doc p { margin: 8px 0; line-height: 1.7; }
        .hone-canvas-doc pre { background: var(--hone-surface); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
        .hone-canvas-doc code { font-family: 'JetBrains Mono', monospace; }
        .hone-canvas-doc p code { background: var(--hone-surface); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
        .hone-canvas-doc ul, .hone-canvas-doc ol { margin: 8px 0 8px 24px; line-height: 1.7; }
        .hone-canvas-doc a { color: var(--hone-accent); }
        .hone-canvas-doc strong { color: var(--hone-text); }
      `}</style>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100%', background: 'var(--hone-bg)', color: 'var(--hone-text)' },
  sidebar: {
    width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column' as const,
    borderRight: '1px solid var(--hone-border)', background: 'var(--hone-surface)',
  },
  sidebarHead: {
    padding: '12px 14px', fontSize: 13, fontWeight: 600,
    borderBottom: '1px solid var(--hone-border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  count: { fontSize: 11, color: 'var(--hone-muted)', fontWeight: 400 },
  list: { flex: 1, overflowY: 'auto' as const },
  listItem: {
    padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--hone-border)',
  },
  itemTitle: {
    fontSize: 13, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  itemMeta: {
    fontSize: 10, color: 'var(--hone-muted)',
    display: 'flex', justifyContent: 'space-between', marginTop: 4,
  },
  itemKind: {
    fontFamily: 'JetBrains Mono, monospace', padding: '0 4px', borderRadius: 3,
    background: 'var(--hone-surfaceOverlay)',
  },
  empty: { padding: '20px 14px', fontSize: 12, color: 'var(--hone-muted)', lineHeight: 1.6 },
  main: { flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
    borderBottom: '1px solid var(--hone-border)', flexShrink: 0,
  },
  toolTitle: { fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  toolMeta: { fontSize: 11, color: 'var(--hone-muted)' },
  toolBtn: {
    fontSize: 11, padding: '4px 10px', borderRadius: 4,
    background: 'var(--hone-surfaceRaised)', border: '1px solid var(--hone-border)',
    color: 'var(--hone-text)', cursor: 'pointer',
  },
  content: { flex: 1, overflowY: 'auto' as const, padding: '20px 28px', fontSize: 14 },
  iframe: { flex: 1, border: 'none', width: '100%' },
  emptyMain: {
    flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: 40, textAlign: 'center' as const, color: 'var(--hone-muted)',
  },
  emptyIcon: { fontSize: 40, opacity: 0.5 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: 'var(--hone-text)' },
  emptyDesc: { fontSize: 13, maxWidth: 400, lineHeight: 1.6 },
};

export default CanvasViewer;
