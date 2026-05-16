import { LANG, type Lang, type Translations } from '../i18n/translations';
import { type SessionInfo, type MachineInfo } from '../data/mock';

// ── Types ──────────────────────────────────────────────────────────────────────

interface DashboardProps {
  lang: Lang;
  machines: MachineInfo[];
  sessions: SessionInfo[];
  filter: string;
  setFilter: (f: string) => void;
  sortBy: string;
  setSortBy: (k: string) => void;
  sortDir: 'asc' | 'desc';
  setSortDir: (d: 'asc' | 'desc') => void;
  search: string;
  setSearch: (s: string) => void;
}

interface EmptyProps { lang: Lang; onAddMachine: () => void }
interface LoadingProps { lang: Lang }
interface ErrorProps { lang: Lang; onRetry: () => void }

// ── Constants ──────────────────────────────────────────────────────────────────

const FILTERS: { key: string; zh: string; en: string }[] = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'live', zh: '进行中', en: 'Live' },
  { key: 'idle', zh: '空闲', en: 'Idle' },
  { key: 'done', zh: '已完成', en: 'Done' },
];

const SORT_COLS: { key: string; tk: keyof Translations }[] = [
  { key: 'machineName', tk: 'tableColMachine' },
  { key: 'status', tk: 'tableColStatus' },
  { key: 'task', tk: 'tableColTask' },
  { key: 'tokensUsed', tk: 'tableColTokens' },
  { key: 'elapsed', tk: 'tableColTime' },
];


// ── Helpers ────────────────────────────────────────────────────────────────────

function parseTokens(raw: string): { used: string; total: string | null; pct: number } {
  const parts = raw.split('/');
  const used = parts[0] ?? '0';
  const totalRaw = parts[1] ?? '—';
  const total = totalRaw === '—' || totalRaw === '' ? null : totalRaw;
  const usedNum = parseInt(used.replace(/,/g, ''), 10) || 0;
  const totalNum = total ? parseInt(total.replace(/,/g, ''), 10) || 0 : 1;
  const pct = total ? Math.min(100, Math.round((usedNum / totalNum) * 100)) : 0;
  return { used, total, pct };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Empty({ lang, onAddMachine }: EmptyProps) {
  const t = LANG[lang];
  return (
    <div style={styles.centerWrap}>
      <div style={styles.centerIcon}>🖥</div>
      <div style={styles.centerTitle}>{t.emptyTitle}</div>
      <div style={styles.centerDesc}>{t.emptyDesc}</div>
      <button style={styles.centerBtn} onClick={onAddMachine}>{t.emptyBtn}</button>
    </div>
  );
}

function Loading({ lang }: LoadingProps) {
  const t = LANG[lang];
  return (
    <div style={styles.centerWrap}>
      <div style={styles.centerIcon}>⏳</div>
      <div style={styles.centerTitle}>{t.loadingTitle}</div>
      <div style={styles.loadingDots}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{ ...styles.dot, animationDelay: `${i * 0.16}s` }} />
        ))}
      </div>
    </div>
  );
}

function Error_({ lang, onRetry }: ErrorProps) {
  const t = LANG[lang];
  return (
    <div style={styles.centerWrap}>
      <div style={styles.centerIcon}>⚠</div>
      <div style={styles.centerTitle}>{t.errorTitle}</div>
      <div style={styles.centerDesc}>{t.errorDesc}</div>
      <button style={styles.centerBtn} onClick={onRetry}>{t.errorBtn}</button>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard({
  lang, machines, sessions, filter, setFilter, sortBy, setSortBy, sortDir, setSortDir, search, setSearch,
}: DashboardProps) {
  const t = LANG[lang];

  // 从真实数据计算概要卡片
  const onlineMachines = machines.filter(m => m.status === 'online' || m.status === 'busy').length;
  const busyCount = machines.filter(m => m.status === 'busy').length;
  const activeSessions = sessions.filter(s => s.status === 'live').length;
  const totalSessions = machines.reduce((sum, m) => sum + m.sessions, 0);
  const totalTokens = sessions.reduce((sum, s) => {
    const used = parseInt(s.tokensUsed.split('/')[0]?.replace(/,/g, '') || '0', 10);
    return sum + (isNaN(used) ? 0 : used);
  }, 0);

  // Filter & sort
  const filtered = sessions
    .filter(s => (filter === 'all' ? true : s.status === filter))
    .filter(s => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return s.machineName.toLowerCase().includes(q) || s.task.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const aVal = String(a[sortBy as keyof SessionInfo] ?? '');
      const bVal = String(b[sortBy as keyof SessionInfo] ?? '');
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });

  function handleSort(colKey: string) {
    if (sortBy === colKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(colKey);
      setSortDir('asc');
    }
  }

  function statusBadge(s: SessionInfo['status']) {
    const bg = s === 'live' ? 'var(--hone-accentMuted)' : s === 'idle' ? 'var(--hone-warningMuted)' : 'var(--hone-mutedMuted)';
    const color = s === 'live' ? 'var(--hone-accent)' : s === 'idle' ? 'var(--hone-warning)' : 'var(--hone-muted)';
    const label = s === 'live' ? t.badgeLive : s === 'idle' ? t.badgeIdle : t.badgeDone;
    return (
      <span style={{ ...styles.badge, background: bg, color }}>{label}</span>
    );
  }

  return (
    <div style={styles.wrapper}>
      {/* ── Summary Cards ──────────────────────────────── */}
      <div style={styles.cardsRow}>
        <div style={styles.card}>
          <div style={styles.cardGlow} />
          <div style={styles.cardValue}>{onlineMachines}</div>
          <div style={styles.cardTitle}>{t.cardsMachinesTitle}</div>
          <div style={styles.cardDesc}>{busyCount > 0 ? lang === 'zh' ? `${busyCount} 台忙碌` : `${busyCount} busy` : lang === 'zh' ? '全部空闲' : 'All idle'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardGlow} />
          <div style={styles.cardValue}>{totalSessions}</div>
          <div style={styles.cardTitle}>{t.cardsSessionsTitle}</div>
          <div style={styles.cardDesc}>{activeSessions > 0 ? lang === 'zh' ? `${activeSessions} 个进行中` : `${activeSessions} live` : lang === 'zh' ? '无活跃会话' : 'No active sessions'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardGlow} />
          <div style={styles.cardValue}>{totalTokens.toLocaleString()}</div>
          <div style={styles.cardTitle}>{t.cardsTokensTitle}</div>
          <div style={styles.cardDesc}>{lang === 'zh' ? '累计用量' : 'Total usage'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardGlow} />
          <div style={styles.cardValue}>{machines.length}</div>
          <div style={styles.cardTitle}>{t.cardsTasksTitle}</div>
          <div style={styles.cardDesc}>{lang === 'zh' ? '已注册机器' : 'Registered machines'}</div>
        </div>
      </div>

      {/* ── Sessions Table ─────────────────────────────── */}
      <div style={styles.section}>
        <div style={styles.tableHeader}>
          <span style={styles.tableTitle}>{t.tableTitle}</span>
          <div style={styles.filterRow}>
            {FILTERS.map(f => (
              <button
                key={f.key}
                style={filter === f.key ? styles.filterPillActive : styles.filterPill}
                onClick={() => setFilter(f.key)}
              >
                {lang === 'zh' ? f.zh : f.en}
              </button>
            ))}
          </div>
          <input
            style={styles.searchInput}
            placeholder={t.tableSearch}
            value={search}
            onChange={e => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {SORT_COLS.map(c => (
                  <th
                    key={c.key}
                    style={styles.th}
                    onClick={() => handleSort(c.key)}
                  >
                    <span style={styles.thInner}>
                      {t[c.tk]}
                      {sortBy === c.key && (
                        <span style={styles.sortArrow}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={styles.tdEmpty}>{lang === 'zh' ? '没有匹配的会话' : 'No matching sessions'}</td>
                </tr>
              ) : (
                filtered.map(s => {
                  const { used, total, pct } = parseTokens(s.tokensUsed);
                  return (
                    <tr key={s.id} style={styles.tr}>
                      <td style={{ ...styles.td, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{s.machineName}</td>
                      <td style={styles.td}>{statusBadge(s.status)}</td>
                      <td style={styles.td}>{s.task}</td>
                      <td style={styles.td}>
                        <div style={styles.tokenCell}>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{used}</span>
                          {total && <span style={{ color: 'var(--hone-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>&nbsp;/&nbsp;{total}</span>}
                          {total && (
                            <div style={styles.progressTrack}>
                              <div style={{ ...styles.progressBar, width: `${pct}%` }} />
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ ...styles.td, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{s.elapsed}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Activity Timeline ──────────────────────────── */}
      <div style={styles.section}>
        <div style={styles.tableTitle}>{t.activityTitle}</div>
        <div style={styles.activityList}>
          {sessions.length > 0 ? (
            sessions.slice(0, 10).map((s, i) => (
              <div key={s.id || i} style={styles.activityItem}>
                <span style={styles.activityTime}>{s.elapsed}</span>
                <span style={styles.activityMachine}>{s.machineName}</span>
                <span style={styles.activityText}>{s.task}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: 'var(--hone-muted)', padding: '12px 0' }}>
              {lang === 'zh' ? '暂无活动记录，连接机器后开始追踪' : 'No activity yet. Connect a machine to start tracking.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

Dashboard.Empty = Empty;
Dashboard.Loading = Loading;
Dashboard.Error = Error_;

// ── Styles ─────────────────────────────────────────────────────────────────────

const cardGlowStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'radial-gradient(ellipse at 30% 20%, rgba(212,168,83,0.06) 0%, transparent 60%)',
  borderRadius: 8,
  pointerEvents: 'none',
};

const styles: Record<string, React.CSSProperties> = {
  // Layout
  wrapper: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '16px 20px 20px',
  },

  // Cards
  cardsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12,
  },
  card: {
    position: 'relative',
    background: 'var(--hone-surface)',
    border: '1px solid var(--hone-border)',
    borderRadius: 8,
    padding: '16px 18px',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    overflow: 'hidden',
  },
  cardGlow: cardGlowStyle,
  cardValue: {
    fontSize: 26,
    fontWeight: 700,
    color: 'var(--hone-text)',
    fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: '-0.02em',
    position: 'relative',
    zIndex: 1,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--hone-muted)',
    marginTop: 4,
    position: 'relative',
    zIndex: 1,
  },
  cardDesc: {
    fontSize: 10,
    color: 'var(--hone-muted)',
    opacity: 0.65,
    marginTop: 2,
    position: 'relative',
    zIndex: 1,
  },

  // Section
  section: {
    background: 'var(--hone-surface)',
    border: '1px solid var(--hone-border)',
    borderRadius: 8,
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },

  // Table header
  tableHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap' as const,
  },
  tableTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--hone-text)',
  },
  filterRow: {
    display: 'flex',
    gap: 4,
  },
  filterPill: {
    background: 'transparent',
    border: '1px solid var(--hone-border)',
    borderRadius: 14,
    padding: '3px 12px',
    fontSize: 11,
    color: 'var(--hone-muted)',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  filterPillActive: {
    background: 'var(--hone-accentMuted)',
    border: '1px solid var(--hone-accent)',
    borderRadius: 14,
    padding: '3px 12px',
    fontSize: 11,
    color: 'var(--hone-accent)',
    cursor: 'pointer',
    fontWeight: 500,
  },
  searchInput: {
    marginLeft: 'auto',
    background: 'var(--hone-surfaceRaised)',
    border: '1px solid var(--hone-border)',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 11,
    color: 'var(--hone-text)',
    outline: 'none',
    width: 180,
    fontFamily: 'Inter, sans-serif',
  },

  // Table
  tableWrap: { width: '100%' },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
  },
  th: {
    textAlign: 'left' as const,
    padding: '7px 10px',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--hone-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    borderBottom: '1px solid var(--hone-border)',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },
  thInner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  sortArrow: {
    fontSize: 9,
    color: 'var(--hone-accent)',
  },
  tr: {
    borderBottom: '1px solid var(--hone-border)',
  },
  td: {
    padding: '8px 10px',
    fontSize: 12,
    color: 'var(--hone-text)',
    verticalAlign: 'middle' as const,
  },
  tdEmpty: {
    padding: '28px 10px',
    textAlign: 'center' as const,
    color: 'var(--hone-muted)',
    fontSize: 12,
  },

  // Badge
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 500,
    lineHeight: '16px',
  },

  // Token cell
  tokenCell: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 3,
  },
  progressTrack: {
    width: 80,
    height: 3,
    background: 'var(--hone-progressTrack)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: 'var(--hone-accent)',
    borderRadius: 2,
    transition: 'width 0.3s',
  },

  // Activity
  activityList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  activityItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '6px 0',
  },
  activityTime: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: 'var(--hone-accent)',
    minWidth: 42,
    flexShrink: 0,
  },
  activityMachine: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: 'var(--hone-muted)',
    minWidth: 80,
    flexShrink: 0,
  },
  activityText: {
    flex: 1,
    color: 'var(--hone-text)',
  },
  activityDuration: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: 'var(--hone-muted)',
    flexShrink: 0,
  },

  // Center states (Empty / Loading / Error)
  centerWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 40,
  },
  centerIcon: {
    fontSize: 40,
    marginBottom: 4,
  },
  centerTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--hone-text)',
  },
  centerDesc: {
    fontSize: 12,
    color: 'var(--hone-muted)',
    textAlign: 'center' as const,
    maxWidth: 320,
    lineHeight: 1.6,
  },
  centerBtn: {
    marginTop: 8,
    background: 'var(--hone-accent)',
    color: '#0C0E12',
    border: 'none',
    borderRadius: 6,
    padding: '7px 18px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'Inter, sans-serif',
  },

  // Loading dots
  loadingDots: {
    display: 'flex',
    gap: 5,
    marginTop: 2,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--hone-accent)',
    animation: 'bounce 0.7s infinite ease-in-out',
  },
};
