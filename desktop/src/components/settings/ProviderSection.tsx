import React, { useState, useCallback } from 'react';
import { type ProviderProfile } from '../../data/mock';
import { providerFetchModels, testProvider } from '../../tauri/api';
import { isTauri } from '../../tauri/useTauri';

const KIND_DEFAULTS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: '',
};

const KIND_PRESETS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro'],
  custom: [],
};

interface Props {
  providers: ProviderProfile[];
  onChange: (providers: ProviderProfile[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function ProviderSection({ providers, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const update = useCallback((id: string, patch: Partial<ProviderProfile>) => {
    onChange(providers.map(p => p.id === id ? { ...p, ...patch } : p));
  }, [providers, onChange]);

  const addProvider = () => {
    const newP: ProviderProfile = {
      id: `prov_${Date.now()}`,
      name: `Provider ${providers.length + 1}`,
      kind: 'custom',
      apiKey: '',
      baseUrl: '',
      model: '',
      enabled: true,
      isDefault: providers.length === 0,
    };
    onChange([...providers, newP]);
    setExpandedId(newP.id);
  };

  const removeProvider = (id: string) => {
    const filtered = providers.filter(p => p.id !== id);
    if (providers.find(p => p.id === id)?.isDefault && filtered.length > 0) {
      filtered[0].isDefault = true;
    }
    onChange(filtered);
  };

  const setDefault = (id: string) => {
    onChange(providers.map(p => ({ ...p, isDefault: p.id === id })));
  };

  const fetchModels = async (p: ProviderProfile) => {
    if (!isTauri()) return;
    const baseUrl = p.baseUrl || KIND_DEFAULTS[p.kind] || '';
    if (!baseUrl || !p.apiKey) return;
    setFetchingId(p.id);
    try {
      const models = await providerFetchModels(baseUrl, p.apiKey);
      update(p.id, { fetchedModels: models.map(m => m.id), lastFetchError: undefined });
    } catch (e: any) {
      update(p.id, { lastFetchError: String(e?.message ?? e), fetchedModels: undefined });
    } finally {
      setFetchingId(null);
    }
  };

  const testConn = async (p: ProviderProfile) => {
    if (!isTauri()) return;
    setTestingId(p.id);
    try {
      await testProvider({ provider: p.kind, apiKey: p.apiKey, baseUrl: p.baseUrl || KIND_DEFAULTS[p.kind] || '', model: p.model });
      update(p.id, { lastFetchError: undefined });
    } catch (e: any) {
      update(p.id, { lastFetchError: String(e?.message ?? e) });
    } finally {
      setTestingId(null);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
    transition: 'box-shadow 0.15s, border-color 0.15s',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 8,
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box',
  };

  const btnStyle: React.CSSProperties = {
    padding: '7px 16px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none',
  };

  const btnAccent: React.CSSProperties = {
    ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none',
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('大模型', 'AI Providers', lang)}</h2>
        <button style={btnAccent} onClick={addProvider}>{t('+ 添加', '+ Add', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 }}>
        {t('管理多个 AI 模型提供商，支持 OpenAI 兼容接口。', 'Manage multiple AI providers with OpenAI-compatible APIs.', lang)}
      </p>

      {providers.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', color: 'var(--hone-muted)' }}>
          {t('暂无 Provider，点击「添加」创建。', 'No providers yet. Click "Add" to create one.', lang)}
        </div>
      )}

      {providers.map(p => {
        const isExpanded = expandedId === p.id;
        const presets = KIND_PRESETS[p.kind] || [];
        const models = p.fetchedModels || [];
        return (
          <div key={p.id} style={{
            ...cardStyle,
            borderColor: p.isDefault ? 'var(--hone-accent)' : 'var(--hone-border)',
            boxShadow: p.isDefault ? '0 0 0 1px var(--hone-accent)' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
                   onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                <span style={{ fontSize: 18 }}>{p.isDefault ? '⭐' : '🔌'}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name || `Provider`}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>
                    {p.kind} · {p.model || t('未选模型', 'no model', lang)}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!p.isDefault && (
                  <button style={btnStyle} onClick={() => setDefault(p.id)}>
                    {t('设为默认', 'Set Default', lang)}
                  </button>
                )}
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                  {isExpanded ? t('收起', 'Collapse', lang) : t('编辑', 'Edit', lang)}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('别名', 'Name', lang)}</label>
                  <input style={inputStyle} value={p.name} onChange={e => update(p.id, { name: e.target.value })} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('类型', 'Type', lang)}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['deepseek', 'openai', 'openrouter', 'custom'] as const).map(k => (
                      <button key={k} style={{
                        ...btnStyle,
                        flex: 1,
                        borderColor: p.kind === k ? 'var(--hone-accent)' : 'var(--hone-border)',
                        color: p.kind === k ? 'var(--hone-accent)' : 'var(--hone-muted)',
                      }} onClick={() => update(p.id, { kind: k, baseUrl: p.baseUrl || KIND_DEFAULTS[k] })}>
                        {k}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>API Key</label>
                  <input style={inputStyle} type="password" value={p.apiKey} onChange={e => update(p.id, { apiKey: e.target.value })} placeholder="sk-..." />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>Base URL</label>
                  <input style={inputStyle} value={p.baseUrl} onChange={e => update(p.id, { baseUrl: e.target.value })} placeholder={KIND_DEFAULTS[p.kind] || 'https://...'} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('模型', 'Model', lang)}</label>
                  {models.length > 0 ? (
                    <div>
                      <input list={`models-${p.id}`} style={inputStyle} value={p.model} onChange={e => update(p.id, { model: e.target.value })} placeholder={t('搜索或输入模型名', 'Search or type model name', lang)} />
                      <datalist id={`models-${p.id}`}>
                        {models.map(m => <option key={m} value={m} />)}
                      </datalist>
                      <div style={{ fontSize: 11, color: 'var(--hone-success)', marginTop: 4 }}>
                        {t(`拉取成功，共 ${models.length} 个模型`, `Fetched ${models.length} models`, lang)}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <input style={inputStyle} value={p.model} onChange={e => update(p.id, { model: e.target.value })} placeholder={presets[0] || 'model-name'} />
                      {presets.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {presets.map(m => (
                            <button key={m} style={{ ...btnStyle, padding: '3px 10px', fontSize: 11, borderColor: p.model === m ? 'var(--hone-accent)' : 'var(--hone-border)' }} onClick={() => update(p.id, { model: m })}>{m}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('温度', 'Temperature', lang)}</label>
                    <input type="number" step="0.1" min="0" max="2" style={inputStyle} value={p.temperature ?? ''} onChange={e => update(p.id, { temperature: parseFloat(e.target.value) || undefined })} placeholder="0.7" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('最大 Tokens', 'Max Tokens', lang)}</label>
                    <input type="number" step="128" min="0" style={inputStyle} value={p.maxTokens ?? ''} onChange={e => update(p.id, { maxTokens: parseInt(e.target.value) || undefined })} placeholder="4096" />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button style={{ ...btnAccent, opacity: testingId === p.id ? 0.6 : 1 }} disabled={testingId === p.id} onClick={() => testConn(p)}>
                    {testingId === p.id ? t('测试中…', 'Testing…', lang) : t('🔌 测试', '🔌 Test', lang)}
                  </button>
                  <button style={{ ...btnStyle, opacity: fetchingId === p.id ? 0.6 : 1 }} disabled={fetchingId === p.id} onClick={() => fetchModels(p)}>
                    {fetchingId === p.id ? t('拉取中…', 'Fetching…', lang) : t('📋 拉取模型', '📋 Fetch Models', lang)}
                  </button>
                  <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)' }} onClick={() => removeProvider(p.id)}>
                    {t('删除', 'Delete', lang)}
                  </button>
                </div>

                {p.lastFetchError && (
                  <div style={{ fontSize: 12, color: 'var(--hone-danger)', padding: '8px 12px', background: 'var(--hone-dangerMuted)', borderRadius: 6 }}>
                    {p.lastFetchError}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
