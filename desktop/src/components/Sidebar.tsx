import { LANG, type Lang } from '../i18n/translations';
import type { ThemeName } from '../hooks/useTheme';
import type { MachineInfo } from '../data/mock';

interface SidebarProps {
  machines: MachineInfo[];
  activeMachine: string | null;
  setActiveMachine: (id: string) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: ThemeName;
  cycleTheme: () => void;
  onAddMachine: () => void;
}

const dotColor: Record<MachineInfo['status'], string> = {
  online: 'var(--hone-success)',
  busy: 'var(--hone-warning)',
  offline: 'var(--hone-muted)',
};

const themeIcon: Record<ThemeName, string> = {
  dark: '\uD83C\uDF19',
  light: '\u2600\uFE0F',
  gold: '\u2728',
  midnight: '\uD83C\uDF0A',
};

export default function Sidebar({
  machines,
  activeMachine,
  setActiveMachine,
  lang,
  setLang,
  theme,
  cycleTheme,
  onAddMachine,
}: SidebarProps) {
  const t = LANG[lang];

  return (
    <div style={s.wrap}>
      <div style={s.title}>{t.sidebarTitle}</div>

      <div style={s.list}>
        {machines.map((m) => {
          const active = m.id === activeMachine;
          return (
            <div
              key={m.id}
              style={active ? s.itemActive : s.item}
              onClick={() => setActiveMachine(m.id)}
            >
              <span
                style={{
                  ...s.dot,
                  background: dotColor[m.status],
                  boxShadow: m.status === 'online'
                    ? `0 0 6px ${dotColor[m.status]}`
                    : m.status === 'busy'
                      ? `0 0 4px ${dotColor[m.status]}`
                      : 'none',
                }}
              />
              <div style={s.itemContent}>
                <div style={s.itemName}>{m.name}</div>
                <div style={s.itemMeta}>
                  {m.host} &middot; {m.os} &middot; {m.sessions}{' '}
                  {lang === 'zh' ? '个会话' : 'sessions'}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <button style={s.addBtn} onClick={onAddMachine}>
        {t.sidebarAdd}
      </button>

      <div style={s.footer}>
        <div style={s.footerRow}>
          <button style={s.footerBtn} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
            {t.sidebarLangToggle}
          </button>
          <button style={s.footerBtn} onClick={cycleTheme} title={theme}>
            {themeIcon[theme]}
          </button>
        </div>
        <div style={s.footerRelay}>
          <span style={s.relayDot} />
          {t.sidebarRelayActive}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    width: 220,
    minWidth: 220,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--hone-surface)',
    borderRight: '1px solid var(--hone-border)',
    overflow: 'hidden',
  },
  title: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--hone-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '14px 16px 10px',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 8px',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    marginBottom: 2,
    transition: 'background 0.12s',
  },
  itemActive: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    marginBottom: 2,
    background: 'var(--hone-surfaceRaised)',
  },
  dot: {
    width: 8,
    height: 8,
    minWidth: 8,
    borderRadius: '50%',
    marginTop: 5,
  },
  itemContent: {
    minWidth: 0,
    flex: 1,
  },
  itemName: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--hone-text)',
    lineHeight: '20px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemMeta: {
    fontSize: 11,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    color: 'var(--hone-muted)',
    lineHeight: '17px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  addBtn: {
    margin: '8px 14px',
    padding: '8px 0',
    background: 'transparent',
    border: '1px dashed var(--hone-border)',
    borderRadius: 6,
    color: 'var(--hone-muted)',
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
  },
  footer: {
    flexShrink: 0,
    borderTop: '1px solid var(--hone-border)',
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  footerRow: {
    display: 'flex',
    gap: 6,
  },
  footerBtn: {
    background: 'transparent',
    border: '1px solid var(--hone-border)',
    borderRadius: 4,
    color: 'var(--hone-muted)',
    fontSize: 11,
    padding: '4px 8px',
    cursor: 'pointer',
    lineHeight: 1,
  },
  footerRelay: {
    fontSize: 10,
    color: 'var(--hone-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  relayDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--hone-success)',
    boxShadow: '0 0 4px var(--hone-success)',
    flexShrink: 0,
  },
};
