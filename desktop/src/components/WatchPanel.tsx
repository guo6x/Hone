/**
 * 盯盘 — list of tracked items the agent is monitoring, plus per-item drill-down.
 *
 * Data flows over the existing gateway WS:
 *   tracked_items_list_request → tracked_items_list_response
 *   tracked_item_detail_request → tracked_item_detail_response
 *   tracked_item_signal (server-pushed when monitor schedule detects movement)
 *
 * No SQL access from desktop — daemon owns the data, desktop just renders.
 */
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { type Lang } from '../i18n/translations';

interface Observation {
  id: number;
  item_id: string;
  ts: number;
  data: any;
  agent_assessment?: string;
  signal?: 'none' | 'buy' | 'sell' | 'alert';
}

interface Recommendation {
  id: number;
  item_id?: string;
  ts: number;
  recommendation: string;
  reasoning?: string;
  user_response?: 'accepted' | 'rejected' | 'ignored';
  outcome?: 'good' | 'bad';
  outcome_notes?: string;
}

interface TrackedItem {
  id: string;
  kind: string;
  identifier: string;
  display_name?: string;
  user_position?: any;
  status: 'watching' | 'committed' | 'closed' | 'archived';
  notes?: string;
  created_at: number;
  updated_at: number;
  closed_at?: number;
  monitor_schedule_id?: string;
  latest_observation?: Observation | null;
  stats?: { total: number; reviewed: number; good: number; bad: number };
}

interface Props {
  lang: Lang;
  connection?: {
    send: (msg: Record<string, unknown>) => boolean;
    subscribe: (cb: (msg: any) => void) => () => void;
  };
}

const WatchPanel: React.FC<Props> = ({ lang, connection }) => {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [items, setItems] = useState<TrackedItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ observations: Observation[]; recommendations: Recommendation[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Ref mirror so the subscribe callback (which should NOT re-subscribe on
  // every selection change) always reads the latest selectedId.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  // Ref mirror for `t` so the subscribe callback always uses the current
  // language. Without this, switching language wouldn't update the error
  // string produced inside the effect (t is stale in the closure), since
  // the effect deliberately only depends on `connection` to avoid
  // re-subscribing (and losing in-flight messages) on every render.
  const tRef = useRef(t);
  tRef.current = t;

  // Subscribe + initial fetch
  useEffect(() => {
    if (!connection) { setErr(tRef.current('Gateway 未连接', 'Gateway not connected')); setLoading(false); return; }
    const unsub = connection.subscribe((msg: any) => {
      if (msg.type === 'tracked_items_list_response') {
        setItems(msg.items || []);
        setLoading(false);
        if (!selectedIdRef.current && msg.items?.length > 0) setSelectedId(msg.items[0].id);
      } else if (msg.type === 'tracked_item_detail_response' && msg.itemId === selectedIdRef.current) {
        setDetail({ observations: msg.observations || [], recommendations: msg.recommendations || [] });
      } else if (msg.type === 'tracked_items_changed') {
        connection.send({ type: 'tracked_items_list_request' });
      } else if (msg.type === 'tracked_item_signal') {
        connection.send({ type: 'tracked_items_list_request' });
      }
    });
    connection.send({ type: 'tracked_items_list_request' });
    const tt = setInterval(() => connection.send({ type: 'tracked_items_list_request' }), 30000);
    return () => { unsub(); clearInterval(tt); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  // Re-fetch detail when selection changes
  useEffect(() => {
    if (!connection || !selectedId) return;
    setDetail(null);
    connection.send({ type: 'tracked_item_detail_request', itemId: selectedId });
  }, [connection, selectedId]);

  const selected = useMemo(() => items.find(i => i.id === selectedId) || null, [items, selectedId]);

  const removeItem = (id: string) => {
    if (!connection) return;
    if (!window.confirm(t('确定不再追踪？相关历史也会一起删除。', 'Stop tracking and delete history?'))) return;
    connection.send({ type: 'tracked_item_remove', itemId: id });
    if (selectedId === id) setSelectedId(null);
  };

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const fmtFullTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const renderItemRow = (item: TrackedItem) => {
    const ob = item.latest_observation;
    const d = ob?.data || {};
    const p = item.user_position;
    const isStock = item.kind === 'stock';
    let priceCell = '—';
    let priceColor: string | undefined;
    let pnlCell = '';
    if (isStock && d.current != null) {
      const current = Number(d.current);
      const pct = Number(d.change_pct) || 0;
      if (!isNaN(current)) {
        priceCell = `${current.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        priceColor = pct > 0 ? 'var(--hone-danger)' : pct < 0 ? 'var(--hone-success)' : 'var(--hone-muted)';
      }
    }
    if (isStock && p && p.shares != null && p.avg_cost != null && d.current != null) {
      const current = Number(d.current);
      const avgCost = Number(p.avg_cost);
      const shares = Number(p.shares);
      // Only compute P&L when we actually hold shares and have a cost basis.
      // Using != null (instead of truthy) so shares=0 still shows "no position"
      // rather than silently hiding the cell.
      if (!isNaN(current) && !isNaN(avgCost) && !isNaN(shares) && avgCost !== 0 && shares > 0) {
        const pnlPct = ((current - avgCost) / avgCost) * 100;
        pnlCell = `浮${pnlPct >= 0 ? '盈' : '亏'} ${pnlPct.toFixed(2)}%`;
      }
    }
    const sigDot = ob?.signal && ob.signal !== 'none'
      ? <span style={{ ...styles.signalDot, background: ob.signal === 'sell' ? 'var(--hone-danger)' : ob.signal === 'alert' ? 'var(--hone-warning)' : 'var(--hone-success)' }} title={ob.signal} />
      : null;
    return (
      <div
        key={item.id}
        onClick={() => setSelectedId(item.id)}
        style={{
          ...styles.row,
          background: item.id === selectedId ? 'var(--hone-accentMuted)' : 'transparent',
        }}
      >
        <div style={styles.rowKindCol}>
          <span style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            background: item.status === 'committed' ? 'var(--hone-accentMuted)' : 'var(--hone-surfaceOverlay)',
            color: item.status === 'committed' ? 'var(--hone-accent)' : 'var(--hone-muted)',
          }}>{item.status === 'committed' ? t('持仓', 'pos') : item.status === 'watching' ? t('关注', 'watch') : item.status}</span>
        </div>
        <div style={styles.rowNameCol}>
          {sigDot}
          <span style={{ fontWeight: 500 }}>{item.display_name || item.identifier}</span>
          <code style={styles.rowCode}>{item.identifier}</code>
        </div>
        <div style={{ ...styles.rowPriceCol, color: priceColor }}>{priceCell}</div>
        <div style={styles.rowPnlCol}>{pnlCell}</div>
        <div style={styles.rowStatsCol}>
          {item.stats && item.stats.reviewed > 0 && (
            <span title="历史推荐准确率">{item.stats.good}/{item.stats.reviewed}</span>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
          style={styles.removeBtn}
          title={t('删除', 'Remove')}
        >×</button>
      </div>
    );
  };

  return (
    <div style={styles.root}>
      <div style={styles.left}>
        <div style={styles.leftHead}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('盯盘列表', 'Watchlist')}</div>
          <div style={{ fontSize: 11, color: 'var(--hone-muted)' }}>
            {items.length} {t('项 · 每 30s 自动刷新', 'items · refreshing every 30s')}
          </div>
        </div>

        {loading && <div style={styles.empty}>{t('加载中…', 'Loading…')}</div>}
        {err && <div style={{ ...styles.empty, color: 'var(--hone-danger)' }}>{err}</div>}
        {!loading && !err && items.length === 0 && (
          <div style={styles.empty}>
            {t(
              '还没盯任何东西。在对话里说 "盯着 600519 茅台" agent 就会自动开始追踪。',
              'Nothing tracked yet. Say "track 600519" in chat to start.',
            )}
          </div>
        )}

        <div style={styles.list}>
          {items.map(renderItemRow)}
        </div>
      </div>

      <div style={styles.right}>
        {selected ? (
          <ItemDetail item={selected} detail={detail} fmtTime={fmtTime} fmtFullTime={fmtFullTime} lang={lang} t={t} />
        ) : (
          <div style={styles.emptyDetail}>
            {t('选一个 item 看详情', 'Select an item to see details')}
          </div>
        )}
      </div>
    </div>
  );
};

function ItemDetail({ item, detail, fmtTime, fmtFullTime, lang, t }: {
  item: TrackedItem;
  detail: { observations: Observation[]; recommendations: Recommendation[] } | null;
  fmtTime: (ts: number) => string;
  fmtFullTime: (ts: number) => string;
  lang: Lang;
  t: (zh: string, en: string) => string;
}) {
  const p = item.user_position || {};
  return (
    <div style={styles.detail}>
      <div style={styles.detailHead}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{item.display_name || item.identifier}</div>
          <div style={{ fontSize: 11, color: 'var(--hone-muted)', fontFamily: 'monospace', marginTop: 2 }}>
            {item.kind} · {item.identifier} · {t('创建于', 'created')} {fmtFullTime(item.created_at)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--hone-muted)' }}>{item.status}</div>
        </div>
      </div>

      {item.kind === 'stock' && p.shares && (
        <div style={styles.posCard}>
          <div style={styles.posTitle}>{t('当前持仓', 'Position')}</div>
          <div style={styles.posBody}>
            <div><span style={styles.posKey}>{t('股数', 'shares')}</span> {p.shares}</div>
            <div><span style={styles.posKey}>{t('均价', 'avg cost')}</span> {p.avg_cost}</div>
            <div><span style={styles.posKey}>{t('授权交易', 'auto-trade')}</span> {p.broker_authorized ? t('是', 'yes') : t('否', 'no')}</div>
          </div>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          {t('观察时间序列', 'Observations')} ({detail?.observations.length || 0})
        </div>
        <div style={styles.obsList}>
          {detail?.observations.map(ob => (
            <div key={ob.id} style={styles.obsRow}>
              <span style={styles.obsTime}>{fmtTime(ob.ts)}</span>
              <span style={styles.obsAssess}>{ob.agent_assessment || JSON.stringify(ob.data)}</span>
              {ob.signal && ob.signal !== 'none' && (
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: ob.signal === 'sell' ? 'var(--hone-dangerMuted)' : 'var(--hone-warningMuted)',
                  color: ob.signal === 'sell' ? 'var(--hone-danger)' : 'var(--hone-warning)',
                }}>{ob.signal}</span>
              )}
            </div>
          ))}
          {detail?.observations.length === 0 && (
            <div style={styles.empty}>{t('还没有观察记录', 'No observations yet')}</div>
          )}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          {t('推荐历史', 'Recommendations')} ({detail?.recommendations.length || 0})
        </div>
        <div style={styles.recList}>
          {detail?.recommendations.map(r => (
            <div key={r.id} style={styles.recRow}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--hone-muted)' }}>
                <span>{fmtTime(r.ts)}</span>
                <span>
                  {r.user_response && <span style={{ marginRight: 8 }}>{r.user_response}</span>}
                  {r.outcome === 'good' && <span style={{ color: 'var(--hone-success)' }}>✓ 对了</span>}
                  {r.outcome === 'bad' && <span style={{ color: 'var(--hone-danger)' }}>✗ 错了</span>}
                </span>
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{r.recommendation}</div>
              {r.reasoning && <div style={{ fontSize: 11, color: 'var(--hone-muted)', marginTop: 2 }}>{r.reasoning}</div>}
            </div>
          ))}
          {detail?.recommendations.length === 0 && (
            <div style={styles.empty}>{t('还没有推荐记录', 'No recommendations yet')}</div>
          )}
        </div>
      </div>

      {item.stats && item.stats.reviewed > 0 && (
        <div style={styles.statsBar}>
          {t('复盘成绩', 'Track record')}: {item.stats.good}/{item.stats.reviewed} {t('对', 'correct')} ({((item.stats.good / item.stats.reviewed) * 100).toFixed(0)}%)
        </div>
      )}
    </div>
  );
}

const styles: Record<string, any> = {
  root: { display: 'flex', height: '100%', background: 'var(--hone-bg)' },
  left: {
    width: 480, flexShrink: 0, display: 'flex', flexDirection: 'column' as const,
    borderRight: '1px solid var(--hone-border)', background: 'var(--hone-surface)',
  },
  leftHead: {
    padding: '12px 16px', borderBottom: '1px solid var(--hone-border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  empty: { padding: '24px 16px', fontSize: 12, color: 'var(--hone-muted)', lineHeight: 1.6 },
  list: { flex: 1, overflowY: 'auto' as const },
  row: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 14px', cursor: 'pointer',
    borderBottom: '1px solid var(--hone-border)',
    fontSize: 12,
  },
  rowKindCol: { width: 40, flexShrink: 0 },
  rowNameCol: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' },
  rowCode: { fontSize: 10, color: 'var(--hone-muted)', fontFamily: 'monospace' },
  rowPriceCol: { width: 110, textAlign: 'right' as const, fontFamily: 'monospace', fontSize: 11 },
  rowPnlCol: { width: 80, textAlign: 'right' as const, fontSize: 11, color: 'var(--hone-muted)' },
  rowStatsCol: { width: 36, textAlign: 'right' as const, fontSize: 10, color: 'var(--hone-muted)' },
  signalDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  removeBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--hone-muted)', fontSize: 14, padding: '0 4px',
  },
  right: { flex: 1, overflowY: 'auto' as const, padding: 20 },
  detail: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  detailHead: { display: 'flex', justifyContent: 'space-between' },
  posCard: {
    padding: '12px 14px', borderRadius: 8,
    background: 'var(--hone-surfaceRaised)', border: '1px solid var(--hone-border)',
  },
  posTitle: { fontSize: 11, color: 'var(--hone-muted)', marginBottom: 6 },
  posBody: { display: 'flex', gap: 24, fontSize: 13 },
  posKey: { fontSize: 11, color: 'var(--hone-muted)', marginRight: 4 },
  section: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--hone-text)' },
  obsList: { display: 'flex', flexDirection: 'column' as const, gap: 4, maxHeight: 280, overflowY: 'auto' as const },
  obsRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '6px 10px', fontSize: 12,
    background: 'var(--hone-surface)', borderRadius: 4,
  },
  obsTime: { fontSize: 10, color: 'var(--hone-muted)', fontFamily: 'monospace', flexShrink: 0, width: 80 },
  obsAssess: { flex: 1, color: 'var(--hone-text)' },
  recList: { display: 'flex', flexDirection: 'column' as const, gap: 6, maxHeight: 280, overflowY: 'auto' as const },
  recRow: {
    padding: '8px 12px', fontSize: 13,
    background: 'var(--hone-surface)', borderRadius: 6, border: '1px solid var(--hone-border)',
  },
  statsBar: {
    padding: '8px 12px', borderRadius: 6,
    background: 'var(--hone-accentMuted)', color: 'var(--hone-accent)',
    fontSize: 12, fontWeight: 500,
  },
  emptyDetail: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--hone-muted)', fontSize: 13,
  },
};

export default WatchPanel;
