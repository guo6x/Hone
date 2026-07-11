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
  /** When true, the PTY has been manually stopped and won't restart on re-mount. */
  closed?: boolean;
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

  /** Manually stop a running CLI session but keep the workspace tab.
   *  The PTY is closed; the tab stays and shows a "stopped" state with a
   *  restart button. Switching away and back won't auto-restart until the
   *  user clicks restart. */
  const stopCli = useCallback(async (id: string) => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('pty_close', { sessionId: `pty_${id}` });
    } catch {}
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, closed: true } : w));
  }, [setWorkspaces]);

  /** Restart a previously stopped CLI in an existing workspace. */
  const restartCli = useCallback((id: string) => {
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, closed: false } : w));
  }, [setWorkspaces]);

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
            <span style={s.cwdDot(w.closed)} />
            <code style={{ fontSize: 11, color: 'var(--hone-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.cwd}</code>
            {w.closed ? (
              <button
                onClick={() => restartCli(w.id)}
                style={s.restartBtn}
                title={t('重新启动 CLI', 'Restart CLI')}
              >▶ {t('重启', 'Restart')}</button>
            ) : (
              <button
                onClick={() => stopCli(w.id)}
                style={s.stopBtn}
                title={t('停止 CLI 进程（保留工作区）', 'Stop CLI process (keep workspace)')}
              >■ {t('停止', 'Stop')}</button>
            )}
          </div>
          <XtermPanel
            workspaceId={w.id}
            cwd={w.cwd}
            closed={!!w.closed}
            onExited={() => setWorkspaces(prev => prev.map(x => x.id === w.id ? { ...x, closed: true } : x))}
          />
        </div>
      ))}
    </div>
  );
};

// ── XtermPanel: one xterm.js instance bound to one PTY session ─────────────

interface XtermPanelProps {
  workspaceId: string;
  cwd: string;
  /** When true, the PTY is stopped and won't be reopened on re-render.
   *  Changing from true → false triggers a fresh `pty_open`. */
  closed: boolean;
  /** Fired when the underlying PTY process exits (voluntarily or via stop).
   *  Parent uses this to flip `closed` to true so the restart button shows. */
  onExited: () => void;
}

const XtermPanel: React.FC<XtermPanelProps> = ({ workspaceId, cwd, closed, onExited }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const sessionId = `pty_${workspaceId}`;
  // Track whether we have actually opened a PTY for this render cycle.
  const openedRef = useRef(false);
  // Track host visibility so we don't fit() while the tab is hidden.
  const visibleRef = useRef(true);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    if (!isTauri()) return;
    // If the workspace is in "stopped" state, don't auto-spawn the PTY.
    if (closed) {
      openedRef.current = false;
      return;
    }

    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let cancelled = false;
    let mutationObserver: MutationObserver | null = null;

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
          openedRef.current = false;
          // Notify parent so the "stopped" state flips on and the restart button shows.
          onExitedRef.current();
        });

        await invoke('pty_open', { sessionId, cwd, cols, rows });
        openedRef.current = true;
        lastSizeRef.current = { cols, rows };

        term.onData((data: string) => {
          if (!openedRef.current) return; // drop input after stop
          invoke('pty_write', { sessionId, data }).catch(() => {});
        });

        const isHostVisible = () => {
          const el = hostRef.current;
          if (!el) return false;
          // offsetParent is null when any ancestor has display:none.
          return el.offsetParent !== null && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        };

        const doFit = () => {
          if (cancelled || !termRef.current || !fitRef.current) return;
          const visible = isHostVisible();
          visibleRef.current = visible;
          if (!visible) return; // Don't fit while hidden: zero-size resize resets scroll position.
          try {
            // Remember whether the user was at the bottom; preserve reading position.
            const atBottom = term.buffer.active.viewportY === term.buffer.active.baseY;
            const prevViewportY = term.buffer.active.viewportY;

            fit.fit();
            const cols = term.cols;
            const rows = term.rows;
            const last = lastSizeRef.current;
            if (last && last.cols === cols && last.rows === rows) {
              // Dimensions unchanged: just restore scroll position without pty_resize.
              if (atBottom) term.scrollToBottom();
              return;
            }
            lastSizeRef.current = { cols, rows };
            invoke('pty_resize', { sessionId, cols, rows }).catch(() => {});

            // After resize, restore the user's reading position.
            if (atBottom) {
              term.scrollToBottom();
            } else if (typeof (term as any).scrollToLine === 'function') {
              try {
                (term as any).scrollToLine(Math.min(prevViewportY, term.buffer.active.baseY));
              } catch {}
            }
          } catch {}
        };

        const onResize = () => {
          if (cancelled) return;
          // Debounce: rapid layout/render updates (e.g. status polling) can
          // otherwise fire dozens of fits and repeatedly reset the viewport.
          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => {
            resizeTimerRef.current = null;
            doFit();
          }, 150);
        };
        window.addEventListener('resize', onResize);
        const ro = new ResizeObserver(onResize);
        if (hostRef.current) ro.observe(hostRef.current);

        // Watch for the tab becoming visible (display:none -> flex). Fit once
        // when visible, because ResizeObserver may have been suppressed while hidden.
        mutationObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'style') {
              if (isHostVisible() && !visibleRef.current) {
                visibleRef.current = true;
                onResize();
              }
            }
          }
        });
        if (hostRef.current) {
          mutationObserver.observe(hostRef.current, { attributes: true, attributeFilter: ['style'] });
        }

        (term as any).__cleanupResize = () => {
          window.removeEventListener('resize', onResize);
          ro.disconnect();
          mutationObserver?.disconnect();
          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('Hone path not configured') || msg.includes('CLI not found')) {
          term.write('\r\n\x1b[33m⚠ 无法启动 CLI 终端\x1b[0m\r\n');
          term.write('\x1b[90m原因: 未找到 hone CLI 的安装路径\x1b[0m\r\n\r\n');
          term.write('\x1b[37m请按以下步骤操作:\x1b[0m\r\n');
          term.write('  1. 确认 hone CLI 已构建 (dist/cli.js 存在)\r\n');
          term.write('  2. 打开 设置 → 数据管理 → 工作区目录\r\n');
          term.write('  3. 选择 hone 项目根目录 (包含 dist/cli.js)\r\n\r\n');
          term.write('\x1b[90m提示: 桌面端会自动检测 exe 附近的 dist/cli.js,\x1b[0m\r\n');
          term.write('\x1b[90m开发时请从项目目录运行 npm run tauri:dev\x1b[0m\r\n');
        } else {
          term.write(`\r\n\x1b[31m启动失败: ${msg}\x1b[0m\r\n`);
        }
      }
    };
    start();

    return () => {
      cancelled = true;
      try { unlistenData?.(); } catch {}
      try { unlistenExit?.(); } catch {}
      try { (term as any).__cleanupResize?.(); } catch {}
      // Don't close the PTY on unmount — keep it alive across re-renders.
      // Only the explicit "× close tab" or "停止" button should kill the PTY.
      try { term.dispose(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd, closed]);

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 8, background: '#0C0E12' }} />;
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
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 14px', borderBottom: '1px solid var(--hone-border)',
    background: 'var(--hone-surface)', flexShrink: 0,
  },
  cwdDot: (stopped?: boolean) => ({
    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
    background: stopped ? '#6B7285' : 'var(--hone-success, #2ECC80)',
    boxShadow: stopped ? 'none' : '0 0 4px rgba(46,204,128,0.5)',
  }),
  stopBtn: {
    border: '1px solid var(--hone-danger, #F45858)', background: 'rgba(244,88,88,0.08)',
    color: 'var(--hone-danger, #F45858)', fontSize: 11, padding: '4px 12px', borderRadius: 4,
    cursor: 'pointer', whiteSpace: 'nowrap' as const, fontWeight: 500,
    transition: 'background 0.15s',
  },
  restartBtn: {
    border: '1px solid var(--hone-success, #2ECC80)', background: 'rgba(46,204,128,0.1)',
    color: 'var(--hone-success, #2ECC80)', fontSize: 11, padding: '4px 12px', borderRadius: 4,
    cursor: 'pointer', whiteSpace: 'nowrap' as const, fontWeight: 500,
    transition: 'background 0.15s',
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
