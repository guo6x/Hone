import { LANG, type Lang } from '../i18n/translations';
import type { StatusBarData } from '../data/mock';

interface StatusBarProps {
  lang: Lang;
  statusBar: StatusBarData;
}

interface StatItem {
  labelKey: 'statusUptime' | 'statusLatency' | 'statusTokens' | 'statusBackup';
  value: string;
}

export default function StatusBar({ lang, statusBar }: StatusBarProps) {
  const t = LANG[lang];

  const items: StatItem[] = [
    { labelKey: 'statusUptime', value: statusBar.uptime },
    { labelKey: 'statusLatency', value: statusBar.latency },
    { labelKey: 'statusTokens', value: statusBar.tokensToday },
    { labelKey: 'statusBackup', value: statusBar.lastBackup },
  ];

  return (
    <div style={s.wrap}>
      {items.map((item) => (
        <div key={item.labelKey} style={s.item}>
          <span style={s.label}>{t[item.labelKey]}</span>
          <span style={s.value}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    height: 28,
    minHeight: 28,
    display: 'flex',
    alignItems: 'center',
    gap: 24,
    padding: '0 16px',
    background: 'var(--hone-surface)',
    borderTop: '1px solid var(--hone-border)',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 11,
    flexShrink: 0,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: 'var(--hone-muted)',
  },
  value: {
    color: 'var(--hone-text)',
    fontWeight: 500,
  },
};
