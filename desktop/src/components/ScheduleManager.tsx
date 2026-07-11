import React, { useState, useEffect, useRef } from 'react';
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
  /** Optional shared gateway connection for fetching execution history. */
  connection?: {
    send: (msg: Record<string, unknown>) => boolean;
    subscribe: (cb: (msg: any) => void) => () => void;
    clientId: string;
  };
}

interface ModalProps {
  modal: { open: boolean; editing: ScheduleInfo | null };
  onClose: () => void;
  onSave: (data: Partial<ScheduleInfo>) => void;
  lang: Lang;
  /** Gateway connection for testing schedules. */
  connection?: {
    send: (msg: Record<string, unknown>) => boolean;
    subscribe: (cb: (msg: any) => void) => () => void;
    clientId: string;
  };
}

type NLResult = { cron: string; label: string } | null;

const loopTemplates = [
  {
    id: 'daily-health-loop',
    titleZh: '每日健康闭环',
    titleEn: 'Daily health loop',
    cron: '0 9 * * *',
    label: '0 9 * * *',
    descZh: '运行项目健康检查，修复可安全自动修复的问题，最后汇报验证结果和剩余风险。',
    descEn: 'Run project health checks, fix safe issues, then report verification results and remaining risks.',
  },
  {
    id: 'test-reliability-loop',
    titleZh: '测试稳定性闭环',
    titleEn: 'Test reliability loop',
    cron: '0 10 * * 1-5',
    label: '0 10 * * 1-5',
    descZh: '执行测试套件；若失败，定位最小根因并修复；重复验证直到通过或给出明确阻塞原因。',
    descEn: 'Run the test suite; if it fails, find the smallest root cause and fix it; repeat until green or clearly blocked.',
  },
  {
    id: 'mobile-pairing-loop',
    titleZh: '移动端连通性闭环',
    titleEn: 'Mobile pairing loop',
    cron: '*/30 * * * *',
    label: '*/30 * * * *',
    descZh: '检查桌面端 Gateway、Relay、局域网配对和移动端连接状态；失败时修复配置或输出可执行诊断。',
    descEn: 'Check desktop Gateway, Relay, LAN pairing, and mobile connectivity; fix config issues or produce actionable diagnostics.',
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function parseNL(text: string): NLResult {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;

  // ── Interval patterns ──────────────────────────────────────────────
  // "每30分钟", "每2小时", "every 30 min", "every 2 hours"
  let m = lower.match(/每\s*(\d+)\s*分钟|every\s*(\d+)\s*(?:min|minute)/);
  if (m) return { cron: `*/${m[1] || m[2]} * * * *`, label: `*/${m[1] || m[2]} * * * *` };
  m = lower.match(/每\s*(\d+)\s*小时|every\s*(\d+)\s*hour/);
  if (m) return { cron: `0 */${m[1] || m[2]} * * *`, label: `0 */${m[1] || m[2]} * * *` };
  m = lower.match(/每\s*(\d+)\s*天|every\s*(\d+)\s*day/);
  if (m) return { cron: `0 0 */${m[1] || m[2]} * *`, label: `0 0 */${m[1] || m[2]} * *` };

  // Shorthand intervals
  if (/每小时|every\s*hour/.test(lower)) return { cron: '0 * * * *', label: '0 * * * *' };
  if (/每天|every\s*day|每日/.test(lower) && !/点|:|at\s+\d/i.test(lower)) return { cron: '0 0 * * *', label: '0 0 * * *' };
  if (/30\s*分|30\s*min|每半小时/.test(lower)) return { cron: '*/30 * * * *', label: '*/30 * * * *' };
  if (/15\s*分|15\s*min|每刻/.test(lower)) return { cron: '*/15 * * * *', label: '*/15 * * * *' };

  // ── Day-of-week patterns ───────────────────────────────────────────
  const dayMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
  const dayEnMap: Record<string, number> = { 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0 };

  // "每周一", "每周五下午5点", "every Monday at 9am"
  m = lower.match(/每周[一二三四五六日天]|every\s+(?:mon|tue|wed|thu|fri|sat|sun)/);
  if (m) {
    let dow: number | null = null;
    for (const [k, v] of Object.entries(dayMap)) {
      if (m[0].includes(k)) { dow = v; break; }
    }
    if (dow === null) {
      for (const [k, v] of Object.entries(dayEnMap)) {
        if (m[0].includes(k)) { dow = v; break; }
      }
    }
    if (dow !== null) {
      const timeMatch = lower.match(/(\d+)\s*[点:：]\s*(\d+)?|at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
      let hour = 9, minute = 0;
      if (timeMatch) {
        hour = parseInt(timeMatch[1] || timeMatch[3], 10);
        minute = parseInt(timeMatch[2] || timeMatch[4] || '0', 10);
        const ampm = timeMatch[5];
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
      }
      return { cron: `${minute} ${hour} * * ${dow}`, label: `${minute} ${hour} * * ${dow}` };
    }
  }

  // ── Weekday patterns ───────────────────────────────────────────────
  if (/工作日|weekday|周一到周五/.test(lower)) {
    const timeMatch = lower.match(/(\d+)\s*[点:：]\s*(\d+)?|at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
    let hour = 9, minute = 0;
    if (timeMatch) {
      hour = parseInt(timeMatch[1] || timeMatch[3], 10);
      minute = parseInt(timeMatch[2] || timeMatch[4] || '0', 10);
      const ampm = timeMatch[5];
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
    }
    return { cron: `${minute} ${hour} * * 1-5`, label: `${minute} ${hour} * * 1-5` };
  }

  // ── Time-of-day patterns ───────────────────────────────────────────
  // "早上8点", "下午3点半", "每天9:30", "at 9:30am"
  m = lower.match(/(\d+)\s*[点:：]\s*(\d+)?\s*(半)?|(?:at\s+)?(\d+)(?::(\d+))?\s*(am|pm)/);
  if (m) {
    let hour = parseInt(m[1] || m[4], 10);
    let minute = m[3] ? 30 : parseInt(m[2] || m[5] || '0', 10);
    const ampm = m[6];
    // Chinese time-of-day context
    if (/下午|傍晚/.test(lower) && hour < 12) hour += 12;
    if (/晚上|夜里/.test(lower) && hour < 12) hour += 12;
    if (/凌晨|深夜/.test(lower) && hour > 12) hour -= 12;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Check for "every day" context
    const isDaily = /每天|每日|every\s*day|每天早上|每天下午/.test(lower);
    if (isDaily || /早上|上午|下午|晚上|凌晨|morning|night/.test(lower)) {
      return { cron: `${minute} ${hour} * * *`, label: `${minute} ${hour} * * *` };
    }
    return { cron: `${minute} ${hour} * * *`, label: `${minute} ${hour} * * *` };
  }

  // ── Preset patterns ────────────────────────────────────────────────
  if (/早上|morning|9\s*am/.test(lower)) return { cron: '0 9 * * *', label: '0 9 * * *' };
  if (/中午|noon/.test(lower)) return { cron: '0 12 * * *', label: '0 12 * * *' };
  if (/下午|afternoon/.test(lower)) return { cron: '0 14 * * *', label: '0 14 * * *' };
  if (/晚上|night|傍晚/.test(lower)) return { cron: '0 19 * * *', label: '0 19 * * *' };
  if (/凌晨|midnight|深夜/.test(lower)) return { cron: '0 0 * * *', label: '0 0 * * *' };
  if (/merge|pr|合并/.test(lower)) return { cron: '0 9 * * 1-5', label: '0 9 * * 1-5' };

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

function Modal({ modal, onClose, onSave, lang, connection }: ModalProps) {
  const t = LANG[lang];
  const editing = modal.editing;

  const [nlText, setNlText] = useState(editing?.desc || '');
  const [nlResult, setNlResult] = useState<NLResult>(null);
  const [trigger, setTrigger] = useState<ScheduleInfo['trigger']>(editing?.trigger || 'cron');
  const [cron, setCron] = useState(editing?.cron || '');
  const [desc, setDesc] = useState(editing?.desc || '');
  const [delivery, setDelivery] = useState<ScheduleInfo['delivery']>(editing?.delivery || 'desktop');
  const [testStatus, setTestStatus] = useState<'running' | 'done' | 'fail' | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  // Track the in-flight test subscription + timeout so we can tear them down
  // when the user clicks Test again or closes the modal. Without this, rapid
  // clicks pile up subscriptions and timers that all fire setState on an
  // unmounted component.
  const testUnsubRef = useRef<(() => void) | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (testUnsubRef.current) { try { testUnsubRef.current(); } catch {} testUnsubRef.current = null; }
      if (testTimerRef.current) { clearTimeout(testTimerRef.current); testTimerRef.current = null; }
    };
  }, []);

  // Re-sync all internal state when switching to a different schedule.
  // Without this, the parent's `{modal.open && <Modal/>}` reuse keeps stale
  // fields from the previously-edited schedule when the user clicks edit on
  // another row without closing the modal in between.
  const editingId = editing?.id;
  useEffect(() => {
    setNlText(editing?.desc || '');
    setNlResult(null);
    setTrigger(editing?.trigger || 'cron');
    setCron(editing?.cron || '');
    setDesc(editing?.desc || '');
    setDelivery(editing?.delivery || 'desktop');
    setTestStatus(null);
    setTestResult(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    setNlResult(parseNL(nlText));
  }, [nlText]);

  async function handleTest() {
    if (testStatus === 'running') return;
    if (!desc.trim()) {
      setTestStatus('fail');
      setTestResult(lang === 'zh' ? '请先填写日程描述' : 'Please enter a schedule description first');
      return;
    }
    if (!connection) {
      setTestStatus('fail');
      setTestResult(lang === 'zh' ? 'Gateway 未连接，无法测试' : 'Gateway not connected');
      return;
    }

    // Tear down any previous test subscription/timer so rapid re-clicks
    // don't stack up multiple listeners.
    if (testUnsubRef.current) { try { testUnsubRef.current(); } catch {} testUnsubRef.current = null; }
    if (testTimerRef.current) { clearTimeout(testTimerRef.current); testTimerRef.current = null; }

    setTestStatus('running');
    setTestResult(null);

    // Send a test dispatch through the Gateway connection
    // 必须带 target + clientId，否则 gateway 不处理（与 sendChat 一致）
    const sent = connection.send({
      type: 'message',
      target: 'gateway',
      clientId: connection.clientId,
      payload: { text: `[测试] ${desc}` },
    });

    if (!sent) {
      setTestStatus('fail');
      setTestResult(lang === 'zh' ? '发送失败 — 连接未就绪' : 'Send failed — connection not ready');
      return;
    }

    // Listen for a response with a timeout
    const timeoutMs = 15000;
    let resolved = false;
    const unsub = connection.subscribe((msg: any) => {
      if (resolved) return;
      if (msg.type === 'message' || msg.type === 'reply' || msg.type === 'error') {
        resolved = true;
        if (testUnsubRef.current) { try { testUnsubRef.current(); } catch {} testUnsubRef.current = null; }
        const text = msg.payload?.text || msg.text || msg.error || '';
        if (msg.type === 'error' || msg.error) {
          setTestStatus('fail');
          setTestResult(String(text).slice(0, 200));
        } else {
          setTestStatus('done');
          setTestResult(String(text).slice(0, 200) || (lang === 'zh' ? '测试完成' : 'Test completed'));
        }
      }
    });
    testUnsubRef.current = unsub;

    testTimerRef.current = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (testUnsubRef.current) { try { testUnsubRef.current(); } catch {} testUnsubRef.current = null; }
        testTimerRef.current = null;
        setTestStatus('fail');
        setTestResult(lang === 'zh' ? '请求已发送，但 15 秒内没有收到 Gateway 响应' : 'Request sent, but no Gateway response arrived within 15 seconds');
      }
    }, timeoutMs);
  }

  function handleSave() {
    // Validate: cron trigger requires a non-empty cron expression, otherwise
    // the scheduler silently creates a schedule that never fires.
    if (trigger === 'cron') {
      if (!cron.trim()) {
        setTestStatus('fail');
        setTestResult(lang === 'zh' ? '请填写 Cron 表达式（或用自然语言生成）' : 'Please fill in the Cron expression (or generate one from natural language)');
        return;
      }
      // 校验 cron 格式：5 段，每段为 * / 数字 / */n / 范围 / 逗号列表
      const parts = cron.trim().split(/\s+/);
      if (parts.length !== 5) {
        setTestStatus('fail');
        setTestResult(lang === 'zh' ? 'Cron 表达式无效：需要 5 段（分 时 日 月 周），如 "0 9 * * *"' : 'Invalid cron: need 5 fields (min hour day month weekday)');
        return;
      }
      const validPart = /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*|\d+\/\d+)$/;
      if (!parts.every(p => validPart.test(p))) {
        setTestStatus('fail');
        setTestResult(lang === 'zh' ? 'Cron 表达式无效：每段仅支持 * / 数字 / */n / 范围 / 逗号列表' : 'Invalid cron format');
        return;
      }
    }
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

          {/* Time/Cron — 根据 trigger 类型显示不同输入字段 */}
          {trigger === 'cron' && (
            <>
              <label style={modalStyles.label}>{t.modalTimeLabel}</label>
              <input
                style={modalStyles.input}
                placeholder={t.modalTimePlaceholder}
                value={cron}
                onChange={e => setCron(e.target.value)}
              />
            </>
          )}
          {trigger === 'interval' && (
            <>
              <label style={modalStyles.label}>{lang === 'zh' ? '间隔（分钟）' : 'Interval (minutes)'}</label>
              <input
                style={modalStyles.input}
                type="number"
                min="1"
                placeholder="30"
                value={cron}
                onChange={e => setCron(e.target.value)}
              />
            </>
          )}
          {trigger === 'once' && (
            <>
              <label style={modalStyles.label}>{lang === 'zh' ? '执行时间' : 'Run at'}</label>
              <input
                style={modalStyles.input}
                type="datetime-local"
                value={cron}
                onChange={e => setCron(e.target.value)}
              />
            </>
          )}

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
            {testStatus === 'running' ? '运行中…' : testStatus === 'done' ? '✓ 完成' : testStatus === 'fail' ? '✗ 失败' : t.modalTest}
          </button>
          <button onClick={handleSave} style={modalStyles.btnPrimary}>{t.modalSave}</button>
        </div>
        {testResult && (
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: testStatus === 'fail' ? 'var(--hone-dangerMuted)' : 'var(--hone-successMuted)',
            color: testStatus === 'fail' ? 'var(--hone-danger)' : 'var(--hone-success)',
            lineHeight: 1.5, wordBreak: 'break-word',
          }}>
            {testResult}
          </div>
        )}
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
    color: status === 'done' ? 'var(--hone-success)' : status === 'fail' ? 'var(--hone-danger)' : 'var(--hone-accent)',
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

// ── History modal ───────────────────────────────────────────────────────

interface ScheduleRun {
  id: number;
  schedule_id: string;
  started_at: number;
  finished_at?: number;
  status?: 'ok' | 'fail';
  result?: string;
  error?: string;
  duration_ms?: number;
}

interface AgentInfo {
  schedule_id: string;
  created_at: number;
  confidence: number;
  source_pattern?: string;
  user_corrected: boolean;
}

function HistoryModal({
  scheduleId, title, connection, onClose, lang,
}: {
  scheduleId: string;
  title: string;
  connection: ScheduleManagerProps['connection'];
  onClose: () => void;
  lang: Lang;
}) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) {
      setErr(lang === 'zh' ? 'Gateway 未连接，无法读取历史' : 'Gateway not connected');
      return;
    }
    let resolved = false;
    const unsub = connection.subscribe((msg: any) => {
      if (msg.type === 'schedule_runs_response' && msg.scheduleId === scheduleId) {
        resolved = true;
        setRuns(msg.runs || []);
        setAgentInfo(msg.agentInfo || null);
      }
    });
    const sent = connection.send({ type: 'schedule_runs_request', scheduleId, limit: 50 });
    if (!sent) setErr(lang === 'zh' ? 'Gateway 离线' : 'Gateway offline');
    // Use a local flag instead of reading `runs` (which is stale in this
    // closure) to determine whether the response arrived in time.
    const timer = setTimeout(() => {
      if (!resolved) setErr(prev => prev || (lang === 'zh' ? '请求超时' : 'Request timed out'));
    }, 5000);
    return () => { unsub(); clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId, connection]);

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'var(--hone-scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 640, maxWidth: 'calc(100vw - 40px)', maxHeight: '80vh',
        borderRadius: 12, padding: 24, overflow: 'auto',
        background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
        border: '1px solid var(--hone-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {lang === 'zh' ? '执行历史' : 'Run History'}
          </h2>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--hone-muted)', fontSize: 16,
          }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--hone-muted)', marginBottom: 12 }}>{title}</div>

        {agentInfo && (
          <div style={{
            padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 12,
            background: 'var(--hone-accentMuted)', color: 'var(--hone-accent)',
            border: '1px solid var(--hone-accent)',
          }}>
            🤖 {lang === 'zh' ? 'Agent 自创' : 'Agent-created'} · {lang === 'zh' ? '置信度' : 'Confidence'} {(agentInfo.confidence * 100).toFixed(0)}%
            {agentInfo.source_pattern && <> · <code>{agentInfo.source_pattern}</code></>}
            {agentInfo.user_corrected && <> · {lang === 'zh' ? '已被你纠正' : 'user-corrected'}</>}
          </div>
        )}

        {err && (
          <div style={{
            padding: '10px 12px', borderRadius: 6, fontSize: 12,
            background: 'var(--hone-dangerMuted)', color: 'var(--hone-danger)',
          }}>{err}</div>
        )}

        {!err && runs === null && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--hone-muted)', fontSize: 13 }}>
            {lang === 'zh' ? '加载中…' : 'Loading…'}
          </div>
        )}

        {!err && runs && runs.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--hone-muted)', fontSize: 13 }}>
            {lang === 'zh' ? '这个日程还没执行过' : 'No runs yet'}
          </div>
        )}

        {!err && runs && runs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runs.map(r => (
              <div key={r.id} style={{
                padding: '10px 12px', borderRadius: 6,
                background: 'var(--hone-surface)',
                border: `1px solid ${r.status === 'fail' ? 'var(--hone-danger)' : 'var(--hone-border)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: r.result || r.error ? 6 : 0 }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--hone-muted)' }}>
                    {fmtTime(r.started_at)}
                  </span>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10,
                    background: r.status === 'ok' ? 'var(--hone-successMuted)'
                      : r.status === 'fail' ? 'var(--hone-dangerMuted)'
                      : 'var(--hone-surfaceOverlay)',
                    color: r.status === 'ok' ? 'var(--hone-success)'
                      : r.status === 'fail' ? 'var(--hone-danger)'
                      : 'var(--hone-muted)',
                  }}>
                    {r.status === 'ok' ? (lang === 'zh' ? '✓ 成功' : '✓ ok')
                     : r.status === 'fail' ? (lang === 'zh' ? '✗ 失败' : '✗ fail')
                     : (lang === 'zh' ? '进行中' : 'running')}
                    {r.duration_ms != null && ` · ${(r.duration_ms / 1000).toFixed(1)}s`}
                  </span>
                </div>
                {r.result && (
                  <div style={{ fontSize: 12, color: 'var(--hone-text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const, maxHeight: 120, overflow: 'auto' }}>
                    {r.result.length > 500 ? r.result.slice(0, 500) + '…' : r.result}
                  </div>
                )}
                {r.error && (
                  <div style={{ fontSize: 12, color: 'var(--hone-danger)', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const }}>
                    {r.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ScheduleManager(props: ScheduleManagerProps) {
  const {
    schedules, onToggle, onEdit, onDelete,
    filter, setFilter, search, setSearch, onNew,
    suggestions, onAcceptSuggestion, onDismissSuggestion, lang,
    connection,
  } = props;
  const t = LANG[lang];
  const [hovered, setHovered] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<ScheduleInfo | null>(null);

  const filtered = applyFilter(schedules, filter, search);

  function openLoopTemplate(template: typeof loopTemplates[number]) {
    const desc = lang === 'zh' ? template.descZh : template.descEn;
    onEdit({
      id: `loop-template-${template.id}`,
      title: lang === 'zh' ? template.titleZh : template.titleEn,
      desc: `[Loop] ${desc}`,
      trigger: 'cron',
      cron: template.cron,
      triggerLabel: template.label,
      nextRun: '—',
      enabled: true,
      lastRun: null,
      lastStatus: null,
      delivery: 'cli',
    });
  }

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

      <div style={styles.loopSection}>
        <div style={styles.loopTitle}>
          {lang === 'zh' ? 'Loop 模板' : 'Loop templates'}
        </div>
        <div style={styles.loopGrid}>
          {loopTemplates.map(template => (
            <button
              key={template.id}
              type="button"
              style={styles.loopCard}
              onClick={() => openLoopTemplate(template)}
            >
              <span style={styles.loopCardTitle}>
                {lang === 'zh' ? template.titleZh : template.titleEn}
              </span>
              <span style={styles.loopCardMeta}>{template.label}</span>
            </button>
          ))}
        </div>
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

      {historyFor && (
        <HistoryModal
          scheduleId={historyFor.id}
          title={historyFor.title}
          connection={connection}
          onClose={() => setHistoryFor(null)}
          lang={lang}
        />
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
                  <button style={styles.iconBtn('var(--hone-muted)')} onClick={() => setHistoryFor(s)} title={lang === 'zh' ? '执行历史' : 'History'}>
                    &#9202;
                  </button>
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
  loopSection: {
    marginBottom: 14, flexShrink: 0,
  },
  loopTitle: {
    fontSize: 12, fontWeight: 600, color: 'var(--hone-text)',
    marginBottom: 8,
  },
  loopGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 8,
  },
  loopCard: {
    border: '1px solid var(--hone-border)',
    background: 'var(--hone-surface)',
    borderRadius: 8,
    padding: '10px 12px',
    cursor: 'pointer',
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  loopCardTitle: {
    color: 'var(--hone-text)',
    fontSize: 12,
    fontWeight: 600,
  },
  loopCardMeta: {
    color: 'var(--hone-muted)',
    fontSize: 11,
    fontFamily: 'monospace',
  },
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
