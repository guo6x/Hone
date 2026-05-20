import React, { useState, useEffect, useCallback } from 'react';
import { LANG, type Lang } from '../i18n/translations';
import { type SettingsData, type SkillInfo, type McpInfo } from '../data/mock';
import { type ThemeName } from '../hooks/useTheme';
import { isTauri } from '../tauri/useTauri';

type Section = 'provider' | 'gateway' | 'data' | 'skills' | 'buddy' | 'mcp' | 'browser' | 'appearance' | 'about';

const navItems: { key: Section; zh: string; en: string }[] = [
  { key: 'provider', zh: '提供方', en: 'Provider' },
  { key: 'gateway', zh: '网关', en: 'Gateway' },
  { key: 'data', zh: '数据', en: 'Data' },
  { key: 'skills', zh: '技能', en: 'Skills' },
  { key: 'buddy', zh: '智能伙伴', en: 'AI Buddy' },
  { key: 'mcp', zh: 'MCP', en: 'MCP Servers' },
  { key: 'browser', zh: '浏览器', en: 'Browser' },
  { key: 'appearance', zh: '外观', en: 'Appearance' },
  { key: 'about', zh: '关于', en: 'About' },
];

// Internal provider keys match those expected by Rust gateway_manager.rs.
const providers = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'custom', label: 'Custom (OpenAI 兼容)' },
] as const;

// Suggested model names per provider — shown as quick-pick chips, but the
// model field stays a free-text input so any model name is accepted.
const MODEL_PRESETS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-v4-pro'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini'],
  custom: ['llama-3.3-70b', 'qwen2.5-72b', 'glm-4-plus', 'kimi-k2'],
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com',
  custom: '',
};

const themes: { key: ThemeName; zh: string; en: string; colors: [string, string, string] }[] = [
  { key: 'dark', zh: '暗夜黑', en: 'Dark', colors: ['#1a1a2e', '#16213e', '#0f3460'] },
  { key: 'light', zh: '月光白', en: 'Light', colors: ['#f5f5f5', '#ffffff', '#e8e8e8'] },
  { key: 'gold', zh: '琥珀金', en: 'Gold', colors: ['#1a1a2e', '#2d2420', '#c9a050'] },
  { key: 'midnight', zh: '深蓝夜', en: 'Midnight', colors: ['#0d1117', '#161b22', '#1f6feb'] },
];

export function SettingsPage({ settings, setSettings, lang, theme, setTheme, hydrated = false }: {
  settings: SettingsData;
  setSettings: (s: SettingsData) => void;
  lang: Lang;
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  hydrated?: boolean;
}) {
  const [section, setSection] = useState<Section>('provider');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.apiKey ?? '');
  const [model, setModel] = useState(settings.model ?? 'deepseek-chat');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Normalize legacy capitalized provider names from older configs.
  const normProvider = (p: string) => {
    const lower = (p || '').toLowerCase();
    if (lower === 'deepseek' || lower === 'openai' || lower === 'custom') return lower;
    return 'deepseek';
  };
  const [provider, setProvider] = useState<string>(normProvider(settings.provider));
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
  const [customProviderName, setCustomProviderName] = useState(settings.customProviderName ?? '');
  const [temperature, setTemperature] = useState(settings.temperature ?? '');
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? '');
  const [relayUrl, setRelayUrl] = useState(settings.relayUrl ?? '');
  const [localPort, setLocalPort] = useState(settings.localPort ?? '18789');
  const [autoStart, setAutoStart] = useState(settings.gatewayAutoStart ?? false);
  const [workspace, setWorkspace] = useState(settings.workspaceDir ?? '');
  const [logRetention, setLogRetention] = useState(settings.logRetention ?? '30');
  const [browserEnabled, setBrowserEnabled] = useState(settings.browserEnabled ?? false);
  const [guiModelUrl, setGuiModelUrl] = useState(settings.guiModelUrl ?? '');
  const [guiModelName, setGuiModelName] = useState((settings as any).guiModelName ?? '');
  const [guiModelKey, setGuiModelKey] = useState((settings as any).guiModelKey ?? '');
  const [browserHeadless, setBrowserHeadless] = useState(settings.browserHeadless ?? true);
  const [browserMaxSteps, setBrowserMaxSteps] = useState(settings.browserMaxSteps ?? '15');
  const [buddySpecies, setBuddySpecies] = useState(settings.buddySpecies ?? 'robot');
  const [showDanger, setShowDanger] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>(() => {
    try {
      const saved = localStorage.getItem('hone-skills');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [mcps, setMcps] = useState<McpInfo[]>(() => {
    try {
      const saved = localStorage.getItem('hone-mcps');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const [isLocalHydrated, setIsLocalHydrated] = useState(false);

  // Sync settings once when the app is hydrated
  useEffect(() => {
    if (hydrated && !isLocalHydrated && settings) {
      setApiKeyDraft(settings.apiKey ?? '');
      setModel(settings.model ?? 'deepseek-chat');
      setProvider(normProvider(settings.provider));
      setBaseUrl(settings.baseUrl ?? '');
      setCustomProviderName(settings.customProviderName ?? '');
      setTemperature(settings.temperature ?? '');
      setMaxTokens(settings.maxTokens ?? '');
      setRelayUrl(settings.relayUrl ?? '');
      setLocalPort(settings.localPort ?? '18789');
      setAutoStart(settings.gatewayAutoStart ?? false);
      setWorkspace(settings.workspaceDir ?? '');
      setLogRetention(settings.logRetention ?? '30');
      setBrowserEnabled(settings.browserEnabled ?? false);
      setGuiModelUrl(settings.guiModelUrl ?? '');
      setGuiModelName((settings as any).guiModelName ?? '');
      setGuiModelKey((settings as any).guiModelKey ?? '');
      setBrowserHeadless(settings.browserHeadless ?? true);
      setBrowserMaxSteps(settings.browserMaxSteps ?? '15');
      setBuddySpecies(settings.buddySpecies ?? 'robot');
      setIsLocalHydrated(true);
    }
  }, [hydrated, isLocalHydrated, settings]);

  // Reverse flow: sync config values that may update from the backend (like workspace detection)
  useEffect(() => {
    if (isLocalHydrated && settings) {
      if (settings.workspaceDir !== undefined && settings.workspaceDir !== workspace) {
        setWorkspace(settings.workspaceDir);
      }
      if (settings.relayUrl !== undefined && settings.relayUrl !== relayUrl) {
        setRelayUrl(settings.relayUrl);
      }
      if (settings.localPort !== undefined && settings.localPort !== localPort) {
        setLocalPort(settings.localPort);
      }
      if (settings.gatewayAutoStart !== undefined && settings.gatewayAutoStart !== autoStart) {
        setAutoStart(settings.gatewayAutoStart);
      }
    }
  }, [settings?.workspaceDir, settings?.relayUrl, settings?.localPort, settings?.gatewayAutoStart, isLocalHydrated]);

  // Persist skills to localStorage
  const updateSkills = useCallback((next: SkillInfo[]) => {
    setSkills(next);
    try { localStorage.setItem('hone-skills', JSON.stringify(next)); } catch {}
  }, []);

  // Persist mcps to localStorage
  const updateMcps = useCallback((next: McpInfo[]) => {
    setMcps(next);
    try { localStorage.setItem('hone-mcps', JSON.stringify(next)); } catch {}
  }, []);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 创建表单状态
  const [showSkillForm, setShowSkillForm] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDesc, setNewSkillDesc] = useState('');
  const [newSkillTrigger, setNewSkillTrigger] = useState('');
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const saveTimer = React.useRef<ReturnType<typeof setTimeout>>();

  // 自动保存：任一字段变更后延迟 600ms 同步到父状态
  const autoSave = useCallback(() => {
    if (!isLocalHydrated) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaved(false);
    saveTimer.current = setTimeout(() => {
      setSettings({
        provider,
        apiKey: apiKeyDraft,
        model,
        baseUrl,
        customProviderName,
        temperature,
        maxTokens,
        gatewayAutoStart: autoStart,
        relayUrl,
        localPort,
        workspaceDir: workspace,
        logRetention,
        browserEnabled,
        guiModelUrl,
        guiModelName,
        guiModelKey,
        browserHeadless,
        browserMaxSteps,
        buddySpecies,
      } as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, 600);
  }, [provider, apiKeyDraft, model, baseUrl, customProviderName, temperature, maxTokens, autoStart, relayUrl, localPort, workspace, logRetention, browserEnabled, guiModelUrl, guiModelName, guiModelKey, browserHeadless, browserMaxSteps, buddySpecies, setSettings, isLocalHydrated]);

  useEffect(() => { autoSave(); }, [autoSave]);

  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);

  const doTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    if (!isTauri()) {
      setTesting(false);
      setTestResult({
        ok: false,
        text: t('浏览器模式下无法测试 — 请使用桌面端。', 'Browser mode cannot test — use desktop app.'),
      });
      return;
    }

    try {
      const { testProvider } = await import('../tauri/api');
      const result = await testProvider({
        provider,
        apiKey: apiKeyDraft,
        baseUrl: baseUrl || DEFAULT_BASE_URLS[provider] || '',
        model,
      });
      setTestResult({ ok: true, text: result });
    } catch (e: any) {
      setTestResult({
        ok: false,
        text: `${t('连接失败', 'Failed')}: ${e?.message ?? String(e)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleCheckUpdate = () => {
    setCheckingUpdate(true);
    setUpdateStatus(null);
    // Version check: compare current version against the latest release.
    // When a release feed is available, fetch it here.
    setTimeout(() => {
      setCheckingUpdate(false);
      setUpdateStatus(t(
        '✓ 当前版本 v0.3.0-alpha。更新检查功能即将上线。',
        '✓ v0.3.0-alpha. Update check coming soon.',
      ));
      setTimeout(() => setUpdateStatus(null), 4000);
    }, 600);
  };

  const handleClearData = () => {
    setSettings({
      provider: 'DeepSeek',
      apiKey: '',
      model: 'deepseek-v3',
      gatewayAutoStart: false,
      relayUrl: '',
      localPort: '18789',
      workspaceDir: '',
      logRetention: '30',
      browserEnabled: false,
      guiModelUrl: '',
      browserHeadless: true,
      browserMaxSteps: '15',
    });
    setApiKeyDraft('');
    setRelayUrl('');
    setLocalPort('18789');
    setWorkspace('');
    setModel('deepseek-v3');
    setProvider('DeepSeek');
    setLogRetention('30');
    setAutoStart(false);
    setBrowserEnabled(false);
    setGuiModelUrl('');
    setBrowserHeadless(true);
    setBrowserMaxSteps('15');
    setSkills([]);
    setMcps([]);
    try { localStorage.removeItem('hone-skills'); } catch {}
    try { localStorage.removeItem('hone-mcps'); } catch {}
    try { localStorage.removeItem('hone-settings-extra'); } catch {}
    setShowDanger(false);
    setConfirmClear(false);
  };

  const s: Record<string, any> = {
    wrapper: { display: 'flex', height: '100%', background: 'var(--hone-bg)', color: 'var(--hone-text)' },
    nav: { width: 160, borderRight: '1px solid var(--hone-border)', padding: '16px 0', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 },
    navItem: (active: boolean) => ({
      padding: '8px 16px', cursor: 'pointer', fontSize: 13,
      display: 'flex', alignItems: 'center', gap: 8,
      background: active ? 'var(--hone-surfaceRaised)' : 'transparent',
      borderLeft: active ? '2px solid var(--hone-accent)' : '2px solid transparent',
      color: active ? 'var(--hone-text)' : 'var(--hone-muted)',
      transition: 'background 0.15s',
    }),
    navDot: (active: boolean) => ({
      width: 6, height: 6, borderRadius: '50%',
      background: active ? 'var(--hone-accent)' : 'var(--hone-muted)',
      flexShrink: 0,
    }),
    content: { flex: 1, overflowY: 'auto', padding: '24px 32px' },
    title: { fontSize: 20, fontWeight: 600, margin: '0 0 4px' },
    desc: { fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 },
    section: { maxWidth: 640 },
    row: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
    label: { fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' },
    input: {
      width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 6,
      background: 'var(--hone-surface)', color: 'var(--hone-text)',
      border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box' as const,
    },
    select: {
      width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 6,
      background: 'var(--hone-surface)', color: 'var(--hone-text)',
      border: '1px solid var(--hone-border)', outline: 'none', cursor: 'pointer',
    },
    btn: {
      padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
      background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
      border: '1px solid var(--hone-border)', outline: 'none',
    },
    btnAccent: {
      padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
      background: 'var(--hone-accent)', color: '#fff', border: 'none', outline: 'none',
    },
    btnDanger: {
      padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
      background: 'var(--hone-danger)', color: '#fff', border: 'none', outline: 'none',
    },
    toggleTrack: (on: boolean) => ({
      width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
      background: on ? 'var(--hone-accent)' : 'var(--hone-muted)',
      position: 'relative' as const, flexShrink: 0,
      transition: 'background 0.2s',
    }),
    toggleThumb: (on: boolean) => ({
      width: 18, height: 18, borderRadius: '50%', background: '#fff',
      position: 'absolute' as const, top: 2, left: on ? 20 : 2,
      transition: 'left 0.2s',
    }),
    card: {
      background: 'var(--hone-surface)', borderRadius: 8, padding: 16,
      border: '1px solid var(--hone-border)', marginBottom: 12,
    },
    mono: { fontFamily: 'monospace', fontSize: 12 },
    dangerZone: {
      border: '1px solid var(--hone-danger)', borderRadius: 8, padding: 16,
      marginTop: 24,
    },
    bannerGreen: {
      padding: '8px 12px', borderRadius: 6, fontSize: 13,
      background: 'var(--hone-successMuted)', color: 'var(--hone-success)',
      marginTop: 12,
    },
    bannerRed: {
      padding: '8px 12px', borderRadius: 6, fontSize: 13,
      background: 'var(--hone-dangerMuted)', color: 'var(--hone-danger)',
      marginTop: 12,
    },
  };

  const renderNav = () => (
    <div style={s.nav}>
      {navItems.map((item) => (
        <div key={item.key} style={s.navItem(section === item.key)} onClick={() => setSection(item.key)}>
          <div style={s.navDot(section === item.key)} />
          {item[lang === 'zh' ? 'zh' : 'en']}
        </div>
      ))}
    </div>
  );

  const renderProvider = () => {
    const presets = MODEL_PRESETS[provider] || [];
    const baseUrlPlaceholder = DEFAULT_BASE_URLS[provider] || 'https://your-endpoint.com';
    return (
      <div style={s.section}>
        <h2 style={s.title}>{t('选择提供商', 'Choose Provider')}</h2>
        <p style={s.desc}>{t('选择 AI 模型提供商并配置 API 密钥', 'Select an AI model provider and configure your API key.')}</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {providers.map((p) => (
            <button
              key={p.key}
              style={{
                ...s.btn,
                flex: 1,
                background: provider === p.key ? 'var(--hone-surfaceRaised)' : 'var(--hone-surface)',
                borderColor: provider === p.key ? 'var(--hone-accent)' : 'var(--hone-border)',
              }}
              onClick={() => setProvider(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {provider === 'custom' && (
          <>
            <label style={s.label}>{t('提供商显示名', 'Provider Display Name')}</label>
            <input
              style={{ ...s.input, marginBottom: 16 }}
              value={customProviderName}
              onChange={(e) => setCustomProviderName(e.target.value)}
              placeholder="Custom"
            />
          </>
        )}

        <label style={s.label}>{t('API Key', 'API Key')}</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            type={apiKeyVisible ? 'text' : 'password'}
            style={s.input}
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder="sk-..."
          />
          <button style={s.btn} onClick={() => setApiKeyVisible(!apiKeyVisible)}>
            {apiKeyVisible ? t('隐藏', 'Hide') : t('显示', 'Show')}
          </button>
        </div>

        <label style={s.label}>{t('Base URL (OpenAI 兼容)', 'Base URL (OpenAI compatible)')}</label>
        <input
          style={{ ...s.input, marginBottom: 4 }}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={baseUrlPlaceholder}
        />
        <p style={{ fontSize: 12, color: 'var(--hone-muted)', marginTop: 0, marginBottom: 16 }}>
          {t('留空使用默认。代理 / 中转 API / 第三方网关都填这里。', 'Leave empty for provider default. Use this for proxies, relays, or third-party gateways.')}
        </p>

        <label style={s.label}>{t('模型名', 'Model Name')}</label>
        <input
          style={{ ...s.input, marginBottom: 8 }}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={presets[0] || 'model-name'}
        />
        {presets.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {presets.map((m) => (
              <button
                key={m}
                style={{
                  ...s.btn,
                  padding: '4px 10px', fontSize: 11,
                  borderColor: model === m ? 'var(--hone-accent)' : 'var(--hone-border)',
                  color: model === m ? 'var(--hone-accent)' : 'var(--hone-muted)',
                }}
                onClick={() => setModel(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>{t('温度', 'Temperature')}</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              style={s.input}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0.7"
            />
            <p style={{ fontSize: 11, color: 'var(--hone-muted)', marginTop: 4 }}>
              {t('0-2，越高越发散。留空用默认。', '0–2, higher = more random. Empty = default.')}
            </p>
          </div>
          <div style={{ flex: 1 }}>
            <label style={s.label}>{t('最大输出 tokens', 'Max Output Tokens')}</label>
            <input
              type="number"
              step="128"
              min="0"
              max="32768"
              style={s.input}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="4096"
            />
            <p style={{ fontSize: 11, color: 'var(--hone-muted)', marginTop: 4 }}>
              {t('每次回复最多生成多少 token。留空用默认。', 'Cap per reply. Empty = default.')}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            style={{ ...s.btnAccent, opacity: testing ? 0.6 : 1 }}
            disabled={testing}
            onClick={doTestConnection}
          >
            {testing ? t('测试中...', 'Testing...') : t('🔌 测试连接', '🔌 Test Connection')}
          </button>
          {testResult && (
            <span style={{
              fontSize: 13,
              color: testResult.ok ? 'var(--hone-success)' : 'var(--hone-danger)',
            }}>
              {testResult.text}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderGateway = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('网关配置', 'Gateway Configuration')}</h2>
      <p style={s.desc}>{t('配置中继地址、本地端口和启动项', 'Configure relay address, local port, and startup options.')}</p>
      <div style={s.row}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{t('开机自启', 'Launch at Startup')}</div>
          <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{t('系统启动时自动运行网关', 'Automatically start the gateway on system boot.')}</div>
        </div>
        <div style={s.toggleTrack(autoStart)} onClick={async () => {
          const next = !autoStart;
          setAutoStart(next);
          if (isTauri()) {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('autostart_toggle', { enable: next });
            } catch (e) {
              console.error('autostart_toggle failed:', e);
              setAutoStart(!next); // rollback on failure
            }
          }
        }}>
          <div style={s.toggleThumb(autoStart)} />
        </div>
      </div>
      <label style={s.label}>{t('中继地址', 'Relay URL')}</label>
      <input
        style={{ ...s.input, marginBottom: 16 }}
        value={relayUrl}
        onChange={(e) => setRelayUrl(e.target.value)}
        placeholder="https://hone-relay.marsailleippi79.workers.dev"
      />
      <label style={s.label}>{t('本地端口', 'Local Port')}</label>
      <input
        style={s.input}
        value={localPort}
        onChange={(e) => setLocalPort(e.target.value)}
        placeholder="18789"
      />
      <p style={{ fontSize: 12, color: 'var(--hone-muted)', marginTop: 4 }}>{t('本地网关监听的端口号', 'Port number on which the local gateway listens.')}</p>
    </div>
  );

  const renderData = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('数据管理', 'Data Management')}</h2>
      <p style={s.desc}>{t('管理工作区目录和日志保留策略', 'Manage workspace directory and log retention policy.')}</p>
      <label style={s.label}>{t('工作区目录', 'Workspace Directory')}</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          style={{ ...s.mono, ...s.input, flex: 1, marginBottom: 0 }}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="/home/user/hone-workspace"
        />
        {isTauri() && (
          <button
            style={{ ...s.btn, whiteSpace: 'nowrap' as const, flexShrink: 0 }}
            onClick={async () => {
              try {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const picked = await open({ directory: true, multiple: false });
                if (picked && typeof picked === 'string') {
                  setWorkspace(picked);
                  // Validate via set_hone_path
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('set_hone_path', { newPath: picked });
                  } catch (err) {
                    console.warn('set_hone_path validation:', err);
                  }
                }
              } catch (e) {
                console.error('Directory picker failed:', e);
              }
            }}
          >{t('浏览…', 'Browse…')}</button>
        )}
      </div>
      <label style={s.label}>{t('日志保留', 'Log Retention')}</label>
      <select
        style={{ ...s.select, marginBottom: 24 }}
        value={logRetention}
        onChange={(e) => setLogRetention(e.target.value)}
      >
        {[7, 14, 30, 60, 90].map((d) => (
          <option key={d} value={d}>{t(`${d}天`, `${d} days`)}</option>
        ))}
      </select>
      <div style={s.dangerZone}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t('清除所有数据', 'Clear All Data')}</div>
        <p style={{ fontSize: 12, color: 'var(--hone-muted)', margin: '0 0 12px' }}>
          {t('删除所有本地数据，包括对话历史、日志和缓存', 'Delete all local data including conversation history, logs, and cache.')}
        </p>
        {!showDanger ? (
          <button style={{ ...s.btn, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)' }} onClick={() => setShowDanger(true)}>
            {t('清除所有数据', 'Clear All Data')}
          </button>
        ) : !confirmClear ? (
          <div>
            <p style={{ fontSize: 13, margin: '0 0 8px', color: 'var(--hone-danger)' }}>
              {t('确定要清除吗？', 'Are you sure you want to clear?')}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btnDanger} onClick={() => setConfirmClear(true)}>{t('确认清除', 'Confirm Clear')}</button>
              <button style={s.btn} onClick={() => setShowDanger(false)}>{t('取消', 'Cancel')}</button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, margin: '0 0 8px' }}>{t('数据已清除', 'Data cleared.')}</p>
            <button style={s.btn} onClick={handleClearData}>{t('完成', 'Done')}</button>
          </div>
        )}
      </div>
    </div>
  );

  const renderSkills = () => (
    <div style={s.section}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ ...s.title, margin: 0 }}>{t('技能管理', 'Skills Management')}</h2>
        <button style={s.btnAccent} onClick={() => setShowSkillForm(!showSkillForm)}>
          {showSkillForm ? t('取消', 'Cancel') : t('+ 新建技能', '+ New Skill')}
        </button>
      </div>
      <p style={s.desc}>{t('管理和配置自定义技能', 'Manage and configure custom skills.')}</p>

      {showSkillForm && (
        <div style={{ ...s.card, marginBottom: 12 }}>
          <input style={s.input} placeholder={t('技能名称 (如: deploy)', 'Skill name (e.g. deploy)')} value={newSkillName} onChange={e => setNewSkillName(e.target.value)} />
          <input style={{ ...s.input, marginTop: 8 }} placeholder={t('描述', 'Description')} value={newSkillDesc} onChange={e => setNewSkillDesc(e.target.value)} />
          <input style={{ ...s.input, marginTop: 8 }} placeholder={t('触发词', 'Trigger word')} value={newSkillTrigger} onChange={e => setNewSkillTrigger(e.target.value)} />
          <button
            style={{ ...s.btnAccent, marginTop: 10 }}
            disabled={!newSkillName.trim()}
            onClick={() => {
              if (!newSkillName.trim()) return;
              updateSkills([...skills, { id: Date.now().toString(), name: newSkillName.trim(), desc: newSkillDesc, descEn: newSkillDesc, trigger: newSkillTrigger || newSkillName, enabled: true }]);
              setNewSkillName(''); setNewSkillDesc(''); setNewSkillTrigger('');
              setShowSkillForm(false);
            }}
          >
            {t('创建', 'Create')}
          </button>
        </div>
      )}

      {skills.map((skill: SkillInfo) => (
        <div key={skill.name} style={s.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>📦</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, ...s.mono }}>/{skill.name}</div>
                <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{lang === 'zh' ? skill.desc : skill.descEn}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: skill.enabled ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                {skill.enabled ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}
              </span>
              <div style={s.toggleTrack(skill.enabled)} onClick={() => {
                updateSkills(skills.map((s) => s.name === skill.name ? { ...s, enabled: !s.enabled } : s));
              }}>
                <div style={s.toggleThumb(skill.enabled)} />
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--hone-muted)', ...s.mono }}>
            {t('触发词: ', 'Trigger: ')}<span style={{ color: 'var(--hone-text)' }}>{skill.trigger}</span>
          </div>
        </div>
      ))}
    </div>
  );

  const renderMcp = () => (
    <div style={s.section}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ ...s.title, margin: 0 }}>{t('MCP 服务器', 'MCP Servers')}</h2>
        <button style={s.btnAccent} onClick={() => { setShowMcpForm(!showMcpForm); setShowSkillForm(false); }}>
          {showMcpForm ? t('取消', 'Cancel') : t('+ 添加 MCP 服务器', '+ Add MCP Server')}
        </button>
      </div>
      <p style={s.desc}>{t('管理 Model Context Protocol 服务器', 'Manage Model Context Protocol servers.')}</p>

      {showMcpForm && (
        <div style={{ ...s.card, marginBottom: 12 }}>
          <input style={s.input} placeholder={t('MCP 名称 (如: filesystem)', 'MCP name (e.g. filesystem)')} value={newMcpName} onChange={e => setNewMcpName(e.target.value)} />
          <input style={{ ...s.input, marginTop: 8 }} placeholder={t('URL (如: http://localhost:3456)', 'URL (e.g. http://localhost:3456)')} value={newMcpUrl} onChange={e => setNewMcpUrl(e.target.value)} />
          <button
            style={{ ...s.btnAccent, marginTop: 10 }}
            disabled={!newMcpName.trim() || !newMcpUrl.trim()}
            onClick={() => {
              if (!newMcpName.trim() || !newMcpUrl.trim()) return;
              updateMcps([...mcps, { id: Date.now().toString(), name: newMcpName.trim(), url: newMcpUrl.trim(), status: 'disconnected', config: '{}', tools: 0 }]);
              setNewMcpName(''); setNewMcpUrl('');
              setShowMcpForm(false);
            }}
          >
            {t('创建', 'Create')}
          </button>
        </div>
      )}

      {mcps.map((mcp: McpInfo) => (
        <div key={mcp.name} style={s.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>🔌</span>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{mcp.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: mcp.status === 'connected' ? 'var(--hone-success)' : 'var(--hone-muted)',
                }} />
                <span style={{ color: mcp.status === 'connected' ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                  {mcp.status === 'connected' ? t('已连接', 'Connected') : mcp.status === 'error' ? t('连接失败', 'Error') : t('未连接', 'Disconnected')}
                </span>
              </div>
            </div>
          </div>
          <div style={{ ...s.mono, fontSize: 12, color: 'var(--hone-muted)', marginBottom: 6 }}>{mcp.url}</div>
          <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>
            {t('配置: ', 'Config: ')}{mcp.config}{t(' | 工具数: ', ' | Tools: ')}{mcp.tools}
          </div>
        </div>
      ))}
    </div>
  );

  const renderAppearance = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('外观', 'Appearance')}</h2>
      <p style={s.desc}>{t('选择应用主题', 'Choose an application theme.')}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {themes.map((th) => (
          <div
            key={th.key}
            style={{
              ...s.card, cursor: 'pointer', position: 'relative',
              borderColor: theme === th.key ? 'var(--hone-accent)' : 'var(--hone-border)',
            }}
            onClick={() => setTheme(th.key)}
          >
            {theme === th.key && (
              <span style={{ position: 'absolute', top: 8, right: 10, color: 'var(--hone-accent)', fontSize: 14 }}>✓</span>
            )}
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{lang === 'zh' ? th.zh : th.en}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {th.colors.map((c, i) => (
                <div key={i} style={{ width: 28, height: 28, borderRadius: 6, background: c, border: '1px solid var(--hone-border)' }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderAbout = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('关于 Hone', 'About Hone')}</h2>
      <p style={s.desc}>{t('AI 桌面网关应用', 'AI Desktop Gateway Application')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={s.row}>
          <span style={{ fontSize: 13, color: 'var(--hone-muted)', width: 100 }}>{t('版本', 'Version')}</span>
          <span style={s.mono}>v0.3.0-alpha</span>
        </div>
        <div style={s.row}>
          <span style={{ fontSize: 13, color: 'var(--hone-muted)', width: 100 }}>{t('更新', 'Update')}</span>
          <button
            style={{ ...s.btn, opacity: checkingUpdate ? 0.6 : 1 }}
            disabled={checkingUpdate}
            onClick={handleCheckUpdate}
          >
            {checkingUpdate ? t('检查中...', 'Checking...') : t('检查更新', 'Check for Updates')}
          </button>
          {updateStatus && <span style={{ fontSize: 12, color: 'var(--hone-success)' }}>{updateStatus}</span>}
        </div>
        <div style={s.row}>
          <span style={{ fontSize: 13, color: 'var(--hone-muted)', width: 100 }}>{t('文档', 'Docs')}</span>
          <span style={s.mono}>docs.hone.dev</span>
          <span style={{ fontSize: 16 }}>📖</span>
        </div>
        <div style={s.row}>
          <span style={{ fontSize: 13, color: 'var(--hone-muted)', width: 100 }}>{t('许可', 'License')}</span>
          <span style={s.mono}>MIT</span>
        </div>
      </div>
    </div>
  );

  const renderBrowser = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('浏览器自动化', 'Browser Automation')}</h2>
      <p style={s.desc}>{t('配置浏览器代理和 GUI 视觉模型，让 Hone Gateway 24/7 自动完成网页任务。', 'Configure the browser agent and GUI vision model for autonomous web tasks.')}</p>

      <div style={s.row}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{t('启用浏览器代理', 'Enable Browser Agent')}</div>
          <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{t('需要先安装 Playwright。在项目目录运行 npm install playwright。', 'Requires Playwright. Run npm install playwright in the project directory.')}</div>
        </div>
        <div style={s.toggleTrack(browserEnabled)} onClick={() => setBrowserEnabled(!browserEnabled)}>
          <div style={s.toggleThumb(browserEnabled)} />
        </div>
      </div>

      <label style={s.label}>{t('视觉模型 URL', 'Vision Model URL')}</label>
      <input
        style={{ ...s.input, marginBottom: 8 }}
        value={guiModelUrl}
        onChange={(e) => setGuiModelUrl(e.target.value)}
        placeholder="https://ark.cn-beijing.volces.com/api/v3/chat/completions"
      />
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' as const }}>
        {[
          { label: '字节方舟', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: '' },
          { label: 'Kimi', url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-32k-vision-preview' },
          { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
          { label: '本地 UI-TARS', url: 'http://localhost:8000/v1/chat/completions', model: 'ui-tars-7b' },
        ].map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => { setGuiModelUrl(p.url); if (p.model) setGuiModelName(p.model); }}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 12,
              background: 'var(--hone-surface)', color: 'var(--hone-muted)',
              border: '1px solid var(--hone-border)', cursor: 'pointer',
            }}
          >{p.label}</button>
        ))}
      </div>

      <label style={s.label}>{t('视觉模型名称 / 接入点 ID', 'Vision Model / Endpoint ID')}</label>
      <input
        style={{ ...s.input, marginBottom: 4, fontFamily: 'monospace' }}
        value={guiModelName}
        onChange={(e) => setGuiModelName(e.target.value)}
        placeholder="ep-20250101000000-xxxxx (火山方舟) 或 doubao-1.5-vision-pro-32k"
      />
      <p style={{ fontSize: 11, color: 'var(--hone-muted)', margin: '0 0 12px' }}>
        {t(
          '火山方舟要填接入点 ID（在控制台「在线推理」创建后获得，形如 ep-...），不是模型名。',
          'For Volcengine Ark, paste the endpoint ID (e.g. ep-...), not the model name.',
        )}
      </p>

      <label style={s.label}>{t('视觉模型 API Key', 'Vision Model API Key')}</label>
      <input
        type="password"
        style={{ ...s.input, marginBottom: 8, fontFamily: 'monospace' }}
        value={guiModelKey}
        onChange={(e) => setGuiModelKey(e.target.value)}
        placeholder="sk-..."
      />
      <p style={{ fontSize: 12, color: 'var(--hone-muted)', marginTop: -4, marginBottom: 16 }}>
        {t(
          '留空 URL = DOM 降级（仅文本）。Kimi/GPT-4V 等通用 vision 模型能用但准确率不如专门训练的 GUI 模型 (UI-TARS)。',
          'Leave URL empty for DOM fallback. General vision LLMs (Kimi/GPT-4V) work but are less accurate than GUI-specialized models.',
        )}
      </p>

      <div style={{ ...s.row, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{t('无头模式', 'Headless Mode')}</div>
          <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{t('浏览器在后台运行，不显示窗口。', 'Run browser in the background without a visible window.')}</div>
        </div>
        <div style={s.toggleTrack(browserHeadless)} onClick={() => setBrowserHeadless(!browserHeadless)}>
          <div style={s.toggleThumb(browserHeadless)} />
        </div>
      </div>

      <label style={s.label}>{t('最大步数', 'Max Steps')}</label>
      <select
        style={{ ...s.select, marginBottom: 16, width: 120 }}
        value={browserMaxSteps}
        onChange={(e) => setBrowserMaxSteps(e.target.value)}
      >
        {['5', '10', '15', '20', '30'].map(n => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </div>
  );

  const renderBuddy = () => (
    <div style={s.section}>
      <h2 style={s.title}>{t('🤖 智能伙伴', '🤖 AI Buddy')}</h2>
      <p style={s.desc}>{t('选择一个你喜欢的 SVG 宠物作为 AI 助手的化身。', 'Pick an SVG pet as your AI avatar.')}</p>
      <label style={s.label}>{t('伙伴品种', 'Buddy Species')}</label>
      <select
        style={{ ...s.select, marginBottom: 16 }}
        value={buddySpecies}
        onChange={(e) => setBuddySpecies(e.target.value)}
      >
        <option value="robot">Robot</option>
        <option value="cat">Cat</option>
        <option value="duck">Duck</option>
        <option value="owl">Owl</option>
        <option value="ghost">Ghost</option>
        <option value="blob">Blob</option>
        <option value="axolotl">Axolotl</option>
      </select>
    </div>
  );

  const renderContent = () => {
    switch (section) {
      case 'provider': return renderProvider();
      case 'gateway': return renderGateway();
      case 'data': return renderData();
      case 'skills': return renderSkills();
      case 'buddy': return renderBuddy();
      case 'mcp': return renderMcp();
      case 'browser': return renderBrowser();
      case 'appearance': return renderAppearance();
      case 'about': return renderAbout();
    }
  };

  return (
    <div style={s.wrapper}>
      {renderNav()}
      <div style={s.content}>
        {saved && (
          <div style={{ fontSize: 11, color: 'var(--hone-success)', marginBottom: 12, transition: 'opacity 0.3s' }}>
            {t('✓ 已自动保存', '✓ Auto-saved')}
          </div>
        )}
        {renderContent()}
      </div>
    </div>
  );
}
