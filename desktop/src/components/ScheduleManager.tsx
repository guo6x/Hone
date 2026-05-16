import React, { useState, useEffect } from 'react';
import { LANG, type Lang } from '../i18n/translations';
import { type ScheduleInfo, type AiSuggestion } from '../data/mock';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface ScheduleManagerProps {
  schedules: ScheduleInfo[];
  onToggle: (id: string) => void;
  onEdit: (s: ScheduleInfo) => void;
  onDelete: (id: string) => void;
  filter: string;
  setFilter: (f: string) => void;
  search: string;
  setSearch: (s: string) => void;
  onNew: () => void;
  suggestions: AiSuggestion[];
  onAcceptSuggestion: (ai: AiSuggestion) => void;
  onDismissSuggestion: (id: string) => void;
  lang: Lang;
}

interface ModalProps {
  modal: { open: boolean; editing: ScheduleInfo | null };
  onClose: () => void;
  onSave: (data: Partial<ScheduleInfo>) => void;
  lang: Lang;
}

type NLResult = { cron: string; label: string } | null;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function parseNL(text: string): NLResult {
  const lower = text.toLowerCase();
  if (/早上|morning|9\s*点|9am/i.test(lower)) return { cron: '0 9 * * *', label: '0 9 * * *' };
  if (/每小时|every\s*hour/i.test(lower)) return { cron: '0 * * * *', label: '0 * * * *' };
  if (/周五|friday|fri/i.test(lower)) return { cron: '0 17 * * 5', label: '0 17 * * 5' };
  if (/周一|monday|mon/i.test(lower)) return { cron: '0 8 * * 1', label: '0 8 * * 1' };
  if (/晚上|night|凌晨/i.test(lower)) return { cron: '0 2 * * *', label: '0 2 * * *' };
  if (/30\s*分|30\s*min/i.test(lower)) return { cron: '*/30 * * * *', label: '*/30 * * * *' };
  if (/merge|pr|合并/i.test(lower)) return { cron: '0 9 * * 1-5', label: '0 9 * * 1-5' };
  return null;
}

function applyFilter(schedules: ScheduleInfo[], filter: string, search: string): ScheduleInfo[] {
  let list = schedules;
  if (filter === 'active') list = list.filter(s => s.enabled);
  else if (filter === 'paused') list = list.filter(s => !s.enabled);
  else if (filter === 'completed') list = list.filter(s => s.lastStatus === 'success');
  if (search.trim()) {
    const q = search.toLowerCase();
    list = list.filter(s => s.title.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q));
  }
  return list;
}

/* ------------------------------------------------------------------ */
/*  Subcomponents (not exported)                                      */
/* ------------------------------------------------------------------ */

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      style={{
        width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
        background: checked ? 'var(--hone-accent)' : 'var(--hone-border)',
        position: 'relative', flexShrink: 0, transition: 'background 0.15s',
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s',
      }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Modal (static)                                                    */
/* ------------------------------------------------------------------ */

function Modal({ modal, onClose, onSave, lang }: ModalProps) {
  const t = LANG[lang];
  const editing = modal.editing;

  const [nlText, setNlText] = useState(editing?.desc || '');
  const [nlResult, setNlResult] = useState<NLResult>(null);
  const [trigger, setTrigger] = useState<ScheduleInfo['trigger']>(editing?.trigger || 'cron');
  const [cron, setCron] = useState(editing?.cron || '');
  const [desc, setDesc] = useState(editing?.desc || '');
  const [delivery, setDelivery] = useState<ScheduleInfo['delivery']>(editing?.delivery || 'desktop');
  const [testStatus, setTestStatus] = useState<'running' | 'done' | null>(null);

  useEffect(() => {
    setNlResult(parseNL(nlText));
  }, [nlText]);

  function handleTest() {
    if (testStatus) return;
    setTestStatus('running');
    setTimeout(() => setTestStatus('done'), 1200);
    setTimeout(() => setTestStatus(null), 2200);
  }

  function handleSave() {
    onSave({
      title: desc.split(/[。\n.!?]/)[0].slice(0, 40) || '新日程',
      desc,
      trigger,
      cron,
      triggerLabel: nlResult?.label || cron,
      nextRun: '—',
      delivery,
    });
    onClose();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const isNew = !editing;

  return (
    <div onClick={handleOverlayClick} style={modalStyles.overlay}>
      <div style={modalStyles.panel} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>{isNew ? t.modalNewTitle : t.modalEditTitle}</span>
          <button onClick={onClose} style={modalStyles.closeBtn}>✕</button>
        </div>

        <div style={modalStyles.body}>
          {/* Natural Language */}
          <label style={modalStyles.label}>{t.modalNLLabel}</label>
          <input
            style={modalStyles.nlInput}
            placeholder={t.modalNLPlaceholder}
            value={nlText}
            onChange={e => setNlText(e.target.value)}
          />
          {nlResult && (
            <div style={modalStyles.nlHint}>
              AI 已解析为: Cron 表达式 · {nlResult.cron}
            </div>
          )}

          {/* Trigger type */}
          <label style={modalStyles.label}>{t.modalTriggerLabel}</label>
          <div style={modalStyles.pillRow}>
            {(['cron', 'interval', 'once'] as const).map(tg => (
              <button
                key={tg}
                style={modalStyles.pill(trigger === tg)}
                onClick={() => setTrigger(tg)}
              >
                {t[`modalTrigger${tg[0].toUpperCase() + tg.slice(1)}` as keyof typeof t]}
              </button>
            ))}
          </div>

          {/* Time/Cron */}
          <label style={modalStyles.label}>{t.modalTimeLabel}</label>
          <input
            style={modalStyles.input}
            placeholder={t.modalTimePlaceholder}
            value={cron}
            onChange={e => setCron(e.target.value)}
          />

          {/* Description */}
          <label style={modalStyles.label}>{t.modalDescLabel}</label>
          <input
            style={modalStyles.input}
            placeholder={t.modalDescPlaceholder}
            value={desc}
            onChange={e => setDesc(e.target.value)}
          />

          {/* Delivery */}
          <label style={modalStyles.label}>{t.modalDeliveryLabel}</label>
          <div style={modalStyles.deliveryRow}>
            {([
              ['desktop', t.modalDeliveryDesktop],
              ['cli', t.modalDeliveryCli],
              ['session', t.modalDeliverySession],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                style={modalStyles.deliveryBtn(delivery === key)}
                onClick={() => setDelivery(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={modalStyles.footer}>
          <button onClick={onClose} style={modalStyles.btnSecondary}>{t.modalCancel}</button>
          <div style={{ flex: 1 }} />
          <button onClick={handleTest} style={modalStyles.btnTest(testStatus)}>
            {testStatus === 'running' ? '运行中…' : testStatus === 'done' ? '✓ 完成' : t.modalTest}
          </button>
          <button onClick={handleSave} style={modalStyles.btnPrimary}>{t.modalSave}</button>
        </div>
      </div>
    </div>
  );
}

const modalStyles: Record<string, any> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'var(--hone-scrim)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  panel: {
    width: 500, maxWidth: '92vw', maxHeight: '85vh',
    background: 'var(--hone-surfaceRaised)',
    borderRadius: 10, border: '1px solid var(--hone-border)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px', borderBottom: '1px solid var(--hone-border)',
    flexShrink: 0,
  },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--hone-text)' },
  closeBtn: {
    background: 'transparent', border: 'none', color: 'var(--hone-muted)',
    fontSize: 15, cursor: 'pointer', padding: '2px 6px', lineHeight: 1,
  },
  body: {
    padding: '16px 18px', overflowY: 'auto', flex: 1,
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--hone-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  nlInput: {
    background: 'var(--hone-bg)', border: '1px solid var(--hone-accent)', borderRadius: 6,
    color: 'var(--hone-text)', fontSize: 14, padding: '10px 12px',
  },
  nlHint: {
    fontSize: 11, color: 'var(--hone-accentMuted)',
    background: 'var(--hone-codeBg)', padding: '4px 10px', borderRadius: 4,
    marginTop: -4,
  },
  input: {
    background: 'var(--hone-bg)', border: '1px solid var(--hone-border)', borderRadius: 6,
    color: 'var(--hone-text)', fontSize: 13, padding: '8px 12px',
  },
  pillRow: { display: 'flex', gap: 6 },
  pill: (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px 0', borderRadius: 6,
    border: active ? '1px solid var(--hone-accent)' : '1px solid var(--hone-border)',
    background: active ? 'var(--hone-accentMuted)' : 'var(--hone-bg)',
    color: active ? 'var(--hone-accent)' : 'var(--hone-muted)',
    fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400,
  }),
  deliveryRow: { display: 'flex', gap: 6 },
  deliveryBtn: (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px 0', borderRadius: 6,
    border: active ? '1px solid var(--hone-accent)' : '1px solid var(--hone-border)',
    background: active ? 'var(--hone-accentMuted)' : 'var(--hone-bg)',
    color: active ? 'var(--hone-accent)' : 'var(--hone-muted)',
    fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400,
  }),
  footer: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 18px', borderTop: '1px solid var(--hone-border)',
    flexShrink: 0,
  },
  btnSecondary: {
    background: 'var(--hone-bg)', border: '1px solid var(--hone-border)', borderRadius: 6,
    color: 'var(--hone-muted)', fontSize: 12, padding: '7px 14px', cursor: 'pointer',
  },
  btnPrimary: {
    background: 'var(--hone-accent)', border: 'none', borderRadius: 6,
    color: '#0C0E12', fontSize: 12, fontWeight: 600, padding: '7px 18px', cursor: 'pointer',
  },
  btnTest: (status: string | null): React.CSSProperties => ({
    background: status === 'running' ? 'var(--hone-accentMuted)' : 'transparent',
    border: '1px solid var(--hone-accent)',
    borderRadius: 6,
    color: status === 'done' ? 'var(--hone-success)' : 'var(--hone-accent)',
    fontSize: 12, padding: '7px 12px', cursor: status ? 'default' : 'pointer',
    transition: 'color 0.2s',
  }),
};

/* ------------------------------------------------------------------ */
/*  Empty (static)                                                    */
/* ------------------------------------------------------------------ */

interface EmptyProps { onCreate: () => void; lang: Lang }

function Empty({ onCreate, lang }: EmptyProps) {
  const t = LANG[lang];
  return (
    <div style={emptyStyles.wrap}>
      <div style={emptyStyles.icon}>&#128197;</div>
      <div style={emptyStyles.title}>{t.schedEmptyTitle}</div>
      <div style={emptyStyles.desc}>{t.schedEmptyDesc}</div>
      <button onClick={onCreate} style={emptyStyles.btn}>{t.schedEmptyBtn}</button>
    </div>
  );
}

const emptyStyles: Record<string, any> = {
  wrap: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10,
    padding: 40, color: 'var(--hone-muted)',
  },
  icon: { fontSize: 40, lineHeight: 1 },
  title: { fontSize: 15, fontWeight: 600, color: 'var(--hone-text)' },
  desc: { fontSize: 12, maxWidth: 340, textAlign: 'center', lineHeight: 1.6 },
  btn: {
    marginTop: 6, background: 'var(--hone-accent)', border: 'none',
    borderRadius: 6, color: '#0C0E12', fontSize: 12, fontWeight: 600,
    padding: '8px 20px', cursor: 'pointer',
  },
};

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export default function ScheduleManager(props: ScheduleManagerProps) {
  const {
    schedules, onToggle, onEdit, onDelete,
    filter, setFilter, search, setSearch, onNew,
    suggestions, onAcceptSuggestion, onDismissSuggestion, lang,
  } = props;
  const t = LANG[lang];
  const [hovered, setHovered] = useState<string | null>(null);

  const filtered = applyFilter(schedules, filter, search);

  return (
    <div style={styles.wrap}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <button onClick={onNew} style={styles.newBtn}>{t.schedNewBtn}</button>
        <select
          style={styles.select}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        >
          <option value="all">{t.schedFilterAll}</option>
          <option value="active">{t.schedFilterActive}</option>
          <option value="paused">{t.schedFilterPaused}</option>
          <option value="completed">{t.schedFilterCompleted}</option>
        </select>
        <input
          style={styles.searchInput}
          placeholder={t.schedSearchPlaceholder}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* AI Suggestions */}
      {suggestions.length > 0 && (
        <div style={styles.aiSection}>
          <div style={styles.aiTitle}>{t.aiTitle}</div>
          <div style={styles.aiGrid}>
            {suggestions.map(ai => (
              <div key={ai.id} style={styles.aiCard}>
                <div style={styles.aiPattern}>
                  {lang === 'zh' ? ai.pattern : ai.patternEn}
                </div>
                <div style={styles.aiActions}>
                  <button
                    style={styles.aiAccept}
                    onClick={() => onAcceptSuggestion(ai)}
                  >
                    {lang === 'zh' ? ai.acceptLabel : ai.acceptLabelEn}
                  </button>
                  <button
                    style={styles.aiDismiss}
                    onClick={() => onDismissSuggestion(ai.id)}
                  >
                    {lang === 'zh' ? ai.dismissLabel : ai.dismissLabelEn}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Schedule list / empty */}
      {filtered.length === 0 ? (
        <ScheduleManager.Empty onCreate={onNew} lang={lang} />
      ) : (
        <div style={styles.list}>
          {filtered.map(s => {
            const h = hovered === s.id;
            return (
              <div key={s.id} style={styles.card(h)} onMouseEnter={() => setHovered(s.id)} onMouseLeave={() => setHovered(null)}>
                <div style={styles.cardBody}>
                  <div style={styles.cardTitle}>{s.title}</div>
                  <div style={styles.cardDesc}>{s.desc}</div>
                  <div style={styles.cardMeta}>
                    <span>{s.triggerLabel}</span>
                    <span style={styles.metaSep}>·</span>
                    <span>{t.schedCardNext}: {s.nextRun}</span>
                    {s.lastStatus === 'success' && (
                      <>
                        <span style={styles.metaSep}>·</span>
                        <span style={{ color: 'var(--hone-success)' }}>{t.schedCardSuccess}</span>
                      </>
                    )}
                    {s.lastStatus === 'fail' && (
                      <>
                        <span style={styles.metaSep}>·</span>
                        <span style={{ color: 'var(--hone-danger)' }}>{t.schedCardFail}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={styles.cardActions}>
                  <ToggleSwitch checked={s.enabled} onChange={() => onToggle(s.id)} />
                  <button style={styles.iconBtn('var(--hone-muted)')} onClick={() => onEdit(s)} title="Edit">
                    &#9998;
                  </button>
                  <button style={styles.iconBtn(h ? 'var(--hone-danger)' : 'transparent')} onClick={() => onDelete(s.id)} title="Delete">
                    &#10005;
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Static properties */
ScheduleManager.Empty = Empty;
ScheduleManager.Modal = Modal;

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles: Record<string, any> = {
  wrap: {
    flex: 1, display: 'flex', flexDirection: 'column',
    overflow: 'hidden', padding: '16px 16px 0',
  },

  /* Toolbar */
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    paddingBottom: 14, flexShrink: 0,
  },
  newBtn: {
    background: 'var(--hone-accent)', border: 'none', borderRadius: 6,
    color: '#0C0E12', fontSize: 12, fontWeight: 600,
    padding: '7px 14px', cursor: 'pointer',
  },
  select: {
    background: 'var(--hone-bg)', border: '1px solid var(--hone-border)',
    borderRadius: 6, color: 'var(--hone-text)', fontSize: 12,
    padding: '7px 10px', cursor: 'pointer', minWidth: 80,
  },
  searchInput: {
    flex: 1, background: 'var(--hone-bg)', border: '1px solid var(--hone-border)',
    borderRadius: 6, color: 'var(--hone-text)', fontSize: 12,
    padding: '7px 12px',
  },

  /* AI Suggestions */
  aiSection: {
    marginBottom: 16, flexShrink: 0,
  },
  aiTitle: {
    fontSize: 12, fontWeight: 600, color: 'var(--hone-accent)',
    marginBottom: 8,
  },
  aiGrid: {
    display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2,
  },
  aiCard: {
    flex: '0 0 260px', background: 'var(--hone-surface)', borderRadius: 8,
    border: '1px solid var(--hone-border)', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  aiPattern: {
    fontSize: 12, color: 'var(--hone-text)', lineHeight: 1.5,
  },
  aiActions: {
    display: 'flex', gap: 6,
  },
  aiAccept: {
    background: 'var(--hone-accent)', border: 'none', borderRadius: 5,
    color: '#0C0E12', fontSize: 11, fontWeight: 600,
    padding: '5px 12px', cursor: 'pointer',
  },
  aiDismiss: {
    background: 'transparent', border: '1px solid var(--hone-border)',
    borderRadius: 5, color: 'var(--hone-muted)', fontSize: 11,
    padding: '5px 10px', cursor: 'pointer',
  },

  /* Schedule list */
  list: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: 8, paddingBottom: 16,
  },

  /* Card */
  card: (hovered: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    background: hovered ? 'var(--hone-surfaceRaised)' : 'var(--hone-surface)',
    border: `1px solid ${hovered ? 'var(--hone-border)' : 'var(--hone-border)'}`,
    borderRadius: 8, padding: '12px 14px',
    transition: 'background 0.12s',
  }),
  cardBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--hone-text)' },
  cardDesc: {
    fontSize: 11, color: 'var(--hone-muted)', lineHeight: 1.4,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  cardMeta: {
    display: 'flex', alignItems: 'center', gap: 4,
    fontSize: 11, color: 'var(--hone-muted)',
    flexWrap: 'wrap' as const,
  },
  metaSep: { color: 'var(--hone-border)' },
  cardActions: {
    display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12, flexShrink: 0,
  },
  iconBtn: (color: string): React.CSSProperties => ({
    background: 'transparent', border: 'none',
    color, fontSize: 14, cursor: 'pointer',
    padding: '2px 4px', lineHeight: 1,
  }),
};
