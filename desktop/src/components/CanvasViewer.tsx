import React, { useState, useCallback, useEffect } from 'react';
import { type Lang, LANG } from '../i18n/translations';
import { type CanvasSession } from '../data/mock';
import { isTauri } from '../tauri/useTauri';

interface Props {
  lang: Lang;
  sessions?: CanvasSession[];
  canvasPort?: string;
}

const CANVAS_PORT = '9120';

const CanvasViewer: React.FC<Props> = ({ lang, sessions: externalSessions, canvasPort = CANVAS_PORT }) => {
  const t = LANG[lang];
  const [discovered, setDiscovered] = useState<CanvasSession[]>([]);

  // Pull canvas sessions from Tauri (lists ~/.hone/canvas/*).
  // Refresh every 5s so newly generated canvases appear.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const { canvasSessionsList } = await import('../tauri/api');
        const list = await canvasSessionsList();
        if (cancelled) return;
        setDiscovered(list.map(s => ({ id: s.id, name: s.name, host: 'local' })));
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const sessions = (externalSessions && externalSessions.length > 0) ? externalSessions : discovered;

  const [selectedSession, setSelectedSession] = useState<CanvasSession>(
    sessions[0] ?? { id: '', name: '', host: '' }
  );

  // When sessions arrive (or change), auto-select the first if none chosen
  useEffect(() => {
    if (!selectedSession.id && sessions.length > 0) {
      setSelectedSession(sessions[0]!);
    }
  }, [sessions, selectedSession.id]);

  const [lastUpdated, setLastUpdated] = useState(new Date());

  const canvasUrl = selectedSession.id
    ? `http://localhost:${canvasPort}/${selectedSession.id}/index.html`
    : '';

  const handleRefresh = useCallback(() => {
    setLastUpdated(new Date());
    // Reload iframe by toggling key
    setIframeKey(k => k + 1);
  }, []);

  const [iframeKey, setIframeKey] = useState(0);

  const handlePopout = () => {
    if (canvasUrl) {
      window.open(canvasUrl, '_blank');
    }
  };

  const pad = (n: number) => String(n).padStart(2, '0');
  const timeStr = `${pad(lastUpdated.getHours())}:${pad(lastUpdated.getMinutes())}:${pad(lastUpdated.getSeconds())}`;

  const hasContent = selectedSession.id && canvasUrl;

  const styles: Record<string, React.CSSProperties> = {
    root: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--hone-bg, #0C0E12)', color: 'var(--hone-text, #E4E8F0)' },
    toolbar: {
      display: 'flex', alignItems: 'center', height: 38, padding: '0 12px', gap: 8,
      borderBottom: '1px solid var(--hone-border, #252A36)', flexShrink: 0,
    },
    sessionName: { fontSize: 11, color: 'var(--hone-muted, #6B7285)', whiteSpace: 'nowrap' as const },
    select: {
      background: 'var(--hone-surfaceRaised, #1A1E26)', color: 'var(--hone-text, #E4E8F0)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 4, padding: '2px 6px',
      fontSize: 12, outline: 'none', cursor: 'pointer',
    },
    btn: {
      background: 'var(--hone-surfaceRaised, #1A1E26)', color: 'var(--hone-text, #E4E8F0)',
      border: '1px solid var(--hone-border, #252A36)', borderRadius: 4,
      padding: '3px 10px', fontSize: 12, cursor: 'pointer',
    },
    timestamp: {
      marginLeft: 'auto', fontSize: 11, color: 'var(--hone-muted, #6B7285)',
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
    },
    main: { flex: 1, overflow: 'hidden', position: 'relative' as const },
    iframe: { width: '100%', height: '100%', border: 'none' },
    emptyState: {
      display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 8, color: 'var(--hone-muted, #6B7285)',
    },
    emptyIcon: { fontSize: 40, opacity: 0.4 },
    emptyTitle: { fontSize: 15, color: 'var(--hone-text, #E4E8F0)', marginTop: 4 },
    emptyDesc: { fontSize: 13, maxWidth: 360, textAlign: 'center' as const, lineHeight: 1.5 },
    emptyHint: {
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 12, color: 'var(--hone-accent, #D4A853)', marginTop: 4,
    },
  };

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <span style={styles.sessionName}>{hasContent ? selectedSession.name : t.canvasEmptyTitle}</span>
        {sessions.length > 0 && (
          <select
            style={styles.select}
            value={selectedSession.id}
            onChange={(e) => {
              const s = sessions.find(s => s.id === e.target.value);
              if (s) setSelectedSession(s);
            }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.host}</option>
            ))}
          </select>
        )}
        <button style={styles.btn} onClick={handleRefresh} disabled={!hasContent}>
          {t.canvasRefresh}
        </button>
        <button style={styles.btn} onClick={handlePopout} disabled={!hasContent}>
          {t.canvasPopout}
        </button>
        {hasContent && <span style={styles.timestamp}>{t.canvasUpdated}: {timeStr}</span>}
      </div>

      <div style={styles.main}>
        {hasContent ? (
          <iframe key={iframeKey} style={styles.iframe} src={canvasUrl} />
        ) : (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>{'\uD83C\uDFA8'}</div>
            <div style={styles.emptyTitle}>{t.canvasEmptyTitle}</div>
            <div style={styles.emptyDesc}>{t.canvasEmptyDesc}</div>
            <div style={styles.emptyHint}>{t.canvasEmptyHint}</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CanvasViewer;
