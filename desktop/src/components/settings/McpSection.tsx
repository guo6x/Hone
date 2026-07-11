import React, { useState } from 'react';
import { type McpServer } from '../../data/mock';

interface Props {
  mcps: McpServer[];
  onChange: (mcps: McpServer[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function McpSection({ mcps, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const update = (id: string, patch: Partial<McpServer>) => {
    onChange(mcps.map(m => m.id === id ? { ...m, ...patch } : m));
  };

  const addMcp = () => {
    const newM: McpServer = {
      id: `mcp_${Date.now()}`,
      name: 'new-mcp',
      transport: 'stdio',
      command: '',
      args: [],
      enabled: true,
      status: 'disconnected',
    };
    onChange([...mcps, newM]);
    setExpandedId(newM.id);
  };

  const removeMcp = (id: string) => {
    onChange(mcps.filter(m => m.id !== id));
  };

  const copyJson = (m: McpServer) => {
    const config: Record<string, unknown> = {};
    if (m.transport === 'stdio') {
      if (m.command) config.command = m.command;
      if (m.args && m.args.length) config.args = m.args;
      if (m.env && Object.keys(m.env).length) config.env = m.env;
    } else if (m.transport === 'sse') {
      config.url = m.url || '';
    } else {
      config.type = 'streamable-http';
      config.url = m.url || '';
      if (m.headers && Object.keys(m.headers).length) config.headers = m.headers;
    }
    const text = JSON.stringify({ mcpServers: { [m.name]: config } }, null, 2);
    navigator.clipboard.writeText(text);
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
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
  const btnAccent: React.CSSProperties = { ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none' };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>MCP {t('服务器', 'Servers', lang)}</h2>
        <button style={btnAccent} onClick={addMcp}>{t('+ 添加', '+ Add', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 }}>
        {t('支持 stdio / sse / streamable-http 三种传输，同步到 claude_desktop_config.json。', 'Supports stdio / sse / streamable-http. Syncs to claude_desktop_config.json.', lang)}
      </p>

      {mcps.map(m => {
        const isExpanded = expandedId === m.id;
        return (
          <div key={m.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }} onClick={() => setExpandedId(isExpanded ? null : m.id)}>
                <span style={{ fontSize: 18 }}>🔌</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{m.transport}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: m.enabled ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                  {m.enabled ? t('启用', 'On', lang) : t('禁用', 'Off', lang)}
                </span>
                <button style={{ ...btnStyle, padding: '4px 12px' }} onClick={() => update(m.id, { enabled: !m.enabled })}>
                  {m.enabled ? '禁用' : '启用'}
                </button>
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : m.id)}>
                  {isExpanded ? t('收起', 'Collapse', lang) : t('编辑', 'Edit', lang)}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('名称', 'Name', lang)}</label>
                  <input style={inputStyle} value={m.name} onChange={e => update(m.id, { name: e.target.value })} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('传输类型', 'Transport', lang)}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['stdio', 'sse', 'streamable-http'] as const).map(tr => (
                      <button key={tr} style={{
                        ...btnStyle, flex: 1,
                        borderColor: m.transport === tr ? 'var(--hone-accent)' : 'var(--hone-border)',
                        color: m.transport === tr ? 'var(--hone-accent)' : 'var(--hone-muted)',
                      }} onClick={() => update(m.id, { transport: tr })}>{tr}</button>
                    ))}
                  </div>
                </div>

                {m.transport === 'stdio' && (
                  <>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('命令', 'Command', lang)}</label>
                      <input style={inputStyle} value={m.command || ''} onChange={e => update(m.id, { command: e.target.value })} placeholder="npx" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('参数 (每行一个)', 'Args (one per line)', lang)}</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={(m.args || []).join('\n')} onChange={e => update(m.id, { args: e.target.value.split('\n').filter(a => a.trim()) })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/user/data'} />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>Env</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={Object.entries(m.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')} onChange={e => {
                        const env: Record<string, string> = {};
                        e.target.value.split('\n').forEach(line => {
                          const idx = line.indexOf('=');
                          if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
                        });
                        update(m.id, { env });
                      }} placeholder="NODE_ENV=production" />
                    </div>
                  </>
                )}

                {m.transport === 'sse' && (
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>URL</label>
                    <input style={inputStyle} value={m.url || ''} onChange={e => update(m.id, { url: e.target.value })} placeholder="http://localhost:3000/sse" />
                  </div>
                )}

                {m.transport === 'streamable-http' && (
                  <>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>URL</label>
                      <input style={inputStyle} value={m.url || ''} onChange={e => update(m.id, { url: e.target.value })} placeholder="https://serp.mcp.acedata.cloud/mcp" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('请求头', 'Headers', lang)}</label>
                      <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }} value={Object.entries(m.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')} onChange={e => {
                        const headers: Record<string, string> = {};
                        e.target.value.split('\n').forEach(line => {
                          const idx = line.indexOf(':');
                          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                        });
                        update(m.id, { headers });
                      }} placeholder="Authorization: Bearer YOUR_TOKEN" />
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={btnStyle} onClick={() => copyJson(m)}>{t('📋 复制 JSON', '📋 Copy JSON', lang)}</button>
                  <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)' }} onClick={() => removeMcp(m.id)}>{t('删除', 'Delete', lang)}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
