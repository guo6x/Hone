/**
 * CLI Workspace — multi-project terminal panel.
 *
 * Each workspace is a folder hosting a real PTY-backed `hone` interactive
 * session, rendered with xterm.js. Ink-based TUI works correctly because
 * the child process is bound to a real pseudo-terminal (ConPTY on Windows).
 *
 * Tabs persist their cwd; PTY sessions reopen automatically when you switch back.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { type Lang } from '../i18n/translations';
import { isTauri } from '../tauri/useTauri';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Workspace {
  id: string;
  cwd: string;
  label: string;
}

const STORAGE_KEY = 'hone-workspaces-v2';

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((w: any) => ({
      id: String(w.id),
      cwd: String(w.cwd),
      label: String(w.label || basename(w.cwd)),
    }));
  } catch { return []; }
}

function saveWorkspaces(workspaces: Workspace[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces)); } catch {}
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

interface Props {
  lang: Lang;
  workspaces: Workspace[];
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
}

const CliWorkspace: React.FC<Props> = ({ lang, workspaces, setWorkspaces, activeId, setActiveId }) => {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;

  const addWorkspace = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (!picked || typeof picked !== 'string') return;
      const ws: Workspace = {
        id: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        cwd: picked,
        label: basename(picked),
      };
      setWorkspaces(prev => [...prev, ws]);
      setActiveId(ws.id);
    } catch (e) {
      console.error('add workspace failed:', e);
    }
  }, [setWorkspaces, setActiveId]);

  const removeWorkspace = useCallback(async (id: string) => {
    if (!window.confirm(t('确定关闭这个 workspace？终端会一起退出。', 'Close this workspace? Terminal will be killed.'))) return;
    // Close PTY if open
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('pty_close', { sessionId: `pty_${id}` });
      } catch {}
    }
    setWorkspaces(prev => {
      const next = prev.filter(w => w.id !== id);
      if (activeId === id) setActiveId(next[0]?.id || null);
      return next;
    });
  }, [activeId, t, setWorkspaces, setActiveId]);

  return (
    <div style={s.root}>
      <div style={s.tabBar}>
        {workspaces.map(w => (
          <div
            key={w.id}
            onClick={() => setActiveId(w.id)}
            style={{ ...s.tab, ...(w.id === activeId ? s.tabActive : {}) }}
            title={w.cwd}
          >
            <span style={s.tabDot} />
            <span>{w.label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); removeWorkspace(w.id); }}
              style={s.tabClose}
              title={t('关闭', 'Close')}
            >×</button>
          </div>
        ))}
        <button onClick={addWorkspace} style={s.addBtn}>
          + {t('添加项目', 'Add Project')}
        </button>
      </div>

      {!activeId && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>📁</div>
          <div style={s.emptyTitle}>{t('还没有工作目录', 'No workspaces yet')}</div>
          <div style={s.emptyDesc}>
            {t(
              '添加你的项目目录，会在那里启动一个完整的 hone 交互式 CLI。Ink TUI 正常渲染，可以一直对话开发。',
              'Add a project folder to start a full interactive hone CLI there.',
            )}
          </div>
          <button onClick={addWorkspace} style={s.bigBtn}>
            {t('添加第一个项目', 'Add First Project')}
          </button>
        </div>
      )}

      {/* Each workspace gets a persistent xterm even when not active (hidden via display:none),
          so its PTY keeps running and output isn't lost when tabs are switched. */}
      {workspaces.map(w => (
        <div
          key={w.id}
          style={{ ...s.termWrap, display: w.id === activeId ? 'flex' : 'none' }}
        >
          <div style={s.cwdBar}>
            <code style={{ fontSize: 11, color: 'var(--hone-muted)' }}>{w.cwd}</code>
          </div>
          <XtermPanel workspaceId={w.id} cwd={w.cwd} />
        </div>
      ))}
    </div>
  );
};

// ── XtermPanel: one xterm.js instance bound to one PTY session ─────────────

const XtermPanel: React.FC<{ workspaceId: string; cwd: string }> = ({ workspaceId, cwd }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = `pty_${workspaceId}`;

  useEffect(() => {
    if (!hostRef.current) return;
    if (!isTauri()) return;

    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let cancelled = false;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#0C0E12',
        foreground: '#E4E8F0',
        cursor: '#D4A853',
        black: '#0C0E12',
        red: '#F45858',
        green: '#2ECC80',
        yellow: '#D4A853',
        blue: '#5B9BD5',
        magenta: '#B47CE8',
        cyan: '#5BBFB7',
        white: '#E4E8F0',
        brightBlack: '#6B7285',
        brightRed: '#FF6B6B',
        brightGreen: '#3DDE94',
        brightYellow: '#E5BC68',
        brightBlue: '#7AB3E8',
        brightMagenta: '#C798F5',
        brightCyan: '#73D3CB',
        brightWhite: '#FFFFFF',
      },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const start = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;

        unlistenData = await listen<string>(`pty_data_${sessionId}`, (e) => {
          term.write(e.payload);
        });
        unlistenExit = await listen<{ exit_code: number }>(`pty_exit_${sessionId}`, (e) => {
          term.write(`\r\n\x1b[33m[进程退出 code=${e.payload.exit_code}]\x1b[0m\r\n`);
        });

        await invoke('pty_open', { sessionId, cwd, cols, rows });

        term.onData((data: string) => {
          invoke('pty_write', { sessionId, data }).catch(() => {});
        });

        const onResize = () => {
          if (cancelled) return;
          try {
            fit.fit();
            invoke('pty_resize', { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
          } catch {}
        };
        window.addEventListener('resize', onResize);
        const ro = new ResizeObserver(onResize);
        if (hostRef.current) ro.observe(hostRef.current);
        (term as any).__cleanupResize = () => {
          window.removeEventListener('resize', onResize);
          ro.disconnect();
        };
      } catch (err) {
        term.write(`\r\n\x1b[31m启动失败: ${err}\x1b[0m\r\n`);
      }
    };
    start();

    return () => {
      cancelled = true;
      try { unlistenData?.(); } catch {}
      try { unlistenExit?.(); } catch {}
      try { (term as any).__cleanupResize?.(); } catch {}
      // Don't close the PTY on unmount — keep it alive across re-renders.
      // Only the explicit "× close tab" should kill the PTY.
      try { term.dispose(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd]);

  return <div ref={hostRef} style={{ flex: 1, padding: 8, background: '#0C0E12' }} />;
};

const s: Record<string, any> = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', background: 'var(--hone-bg)' },
  tabBar: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px',
    borderBottom: '1px solid var(--hone-border)', overflowX: 'auto' as const, flexShrink: 0,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
    borderRadius: 6, cursor: 'pointer', fontSize: 12, color: 'var(--hone-muted)',
    border: '1px solid transparent', whiteSpace: 'nowrap' as const,
  },
  tabActive: {
    background: 'var(--hone-surface)',
    border: '1px solid var(--hone-border)',
    color: 'var(--hone-text)',
  },
  tabDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--hone-success)' },
  tabClose: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--hone-muted)', fontSize: 14, padding: '0 4px', lineHeight: 1,
  },
  addBtn: {
    fontSize: 11, padding: '4px 10px', border: '1px dashed var(--hone-border)',
    background: 'transparent', borderRadius: 6, color: 'var(--hone-muted)', cursor: 'pointer',
  },
  cwdBar: {
    display: 'flex', alignItems: 'center',
    padding: '6px 14px', borderBottom: '1px solid var(--hone-border)',
    background: 'var(--hone-surface)', flexShrink: 0,
  },
  termWrap: {
    flex: 1, flexDirection: 'column' as const, overflow: 'hidden',
  },
  emptyState: {
    flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    justifyContent: 'center', gap: 10, padding: 40, textAlign: 'center' as const,
    color: 'var(--hone-muted)',
  },
  emptyIcon: { fontSize: 48, opacity: 0.5 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: 'var(--hone-text)' },
  emptyDesc: { fontSize: 13, maxWidth: 400, lineHeight: 1.6 },
  bigBtn: {
    marginTop: 12, background: 'var(--hone-accent)', color: '#0C0E12',
    border: 'none', borderRadius: 6, padding: '8px 20px', fontSize: 13,
    fontWeight: 600, cursor: 'pointer',
  },
};

export default CliWorkspace;
