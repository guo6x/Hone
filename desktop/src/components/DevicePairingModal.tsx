import React, { useState } from 'react';
import { LANG, type Lang } from '../i18n/translations';
import { isTauri } from '../tauri/useTauri';
import { sshConnect, pairWithLocalCli } from '../tauri/api';
import type { SshAuth } from '../tauri/types';

type Method = 'local' | 'ssh' | 'tunnel';
type SshAuthMode = 'agent' | 'password' | 'key';

export function DevicePairingModal({ lang, onClose, onPaired, useTauri, discoveredGateways, onScan, scanning }: {
  lang: Lang;
  onClose: () => void;
  onPaired: (machine: any) => void;
  useTauri?: boolean;
  discoveredGateways?: any[];
  onScan?: () => void;
  scanning?: boolean;
}) {
  const [method, setMethod] = useState<Method>('local');
  const [code, setCode] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [sshAuthMode, setSshAuthMode] = useState<SshAuthMode>('agent');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = <K extends string>(key: K): string => {
    const map: Record<string, Record<'zh' | 'en', string>> = {
      pairTitle: { zh: '连接 CLI 实例', en: 'Connect CLI Instance' },
      pairDesc: { zh: '输入设备配对码或远程连接信息以连接到 CLI 实例。', en: 'Enter the device pairing code or remote connection info to connect to a CLI instance.' },
      pairLocal: { zh: '本地网络', en: 'Local Network' },
      pairSSH: { zh: 'SSH 远程', en: 'SSH Remote' },
      pairTunnel: { zh: 'Cloudflare Tunnel', en: 'Cloudflare Tunnel' },
      pairCode: { zh: '配对码', en: 'Pairing Code' },
      pairCodeDesc: { zh: '在 CLI 实例中运行 <code>hone pair</code> 获取配对码', en: 'Run <code>hone pair</code> in your CLI instance to get a pairing code.' },
      pairCodePlaceholder: { zh: '输入 6 位配对码', en: 'Enter 6-digit code' },
      pairHost: { zh: '主机地址', en: 'Host Address' },
      pairHostPlaceholder: { zh: '192.168.1.100 或 user@host', en: '192.168.1.100 or user@host' },
      pairUsername: { zh: '用户名', en: 'Username' },
      pairUsernamePlaceholder: { zh: 'SSH 用户名', en: 'SSH username' },
      pairPort: { zh: '端口', en: 'Port' },
      pairAuth: { zh: '认证方式', en: 'Authentication' },
      pairAgent: { zh: 'SSH Agent', en: 'SSH Agent' },
      pairPassword: { zh: '密码', en: 'Password' },
      pairKey: { zh: '私钥', en: 'Private Key' },
      pairPasswordPlaceholder: { zh: '输入 SSH 密码', en: 'Enter SSH password' },
      pairKeyPathPlaceholder: { zh: '私钥路径，例如 C:\\Users\\me\\.ssh\\id_ed25519', en: 'Private key path, e.g. C:\\Users\\me\\.ssh\\id_ed25519' },
      pairPassphrasePlaceholder: { zh: '私钥口令（可选）', en: 'Key passphrase (optional)' },
      pairConnect: { zh: '连接', en: 'Connect' },
      pairConnecting: { zh: '连接中...', en: 'Connecting...' },
      pairConnected: { zh: '已连接', en: 'Connected' },
      pairFailed: { zh: '连接失败', en: 'Connection failed' },
      pairCancel: { zh: '取消', en: 'Cancel' },
    };
    return map[key]?.[lang] ?? key;
  };

  const parseSshTarget = () => {
    const trimmed = host.trim();
    if (trimmed.includes('@')) {
      const [userPart, ...hostParts] = trimmed.split('@');
      return {
        host: hostParts.join('@').trim(),
        username: username.trim() || userPart.trim(),
      };
    }
    return { host: trimmed, username: username.trim() };
  };

  const getSshAuth = (): SshAuth => {
    if (sshAuthMode === 'password') return { Password: sshPassword };
    if (sshAuthMode === 'key') {
      return {
        Key: {
          path: sshKeyPath.trim(),
          passphrase: sshKeyPassphrase.trim() || null,
        },
      };
    }
    return 'Agent';
  };

  const handleConnect = async () => {
    if (connecting || connected) return;
    setError(null);
    setConnecting(true);

    try {
      if (method === 'ssh' && isTauri()) {
        const sshTarget = parseSshTarget();
        if (!sshTarget.host) throw new Error(lang === 'zh' ? '请输入 SSH 主机地址' : 'Enter an SSH host');
        if (!sshTarget.username) throw new Error(lang === 'zh' ? '请输入 SSH 用户名' : 'Enter an SSH username');
        if (sshAuthMode === 'password' && !sshPassword) throw new Error(lang === 'zh' ? '请输入 SSH 密码' : 'Enter an SSH password');
        if (sshAuthMode === 'key' && !sshKeyPath.trim()) throw new Error(lang === 'zh' ? '请输入私钥路径' : 'Enter a private key path');

        await sshConnect({
          host: sshTarget.host,
          port: parseInt(port, 10) || 22,
          username: sshTarget.username,
          auth: getSshAuth(),
        });
        setConnecting(false);
        setConnected(true);
        setTimeout(() => {
          onPaired({
            name: `${sshTarget.username}@${sshTarget.host}`,
            method: 'ssh',
            host: sshTarget.host,
            username: sshTarget.username,
            port: parseInt(port, 10) || 22,
            code: '',
            pairedAt: Date.now(),
          });
          onClose();
        }, 600);
      } else if (method === 'local' && isTauri()) {
        // Local network: POST /pair to the CLI's `hone pair` server.
        const targetHost = (host.trim() || '127.0.0.1');
        const targetPort = parseInt(port, 10) || 18789;
        if (!code.trim() || code.trim().length !== 6) {
          throw new Error(lang === 'zh' ? '请输入 6 位配对码' : 'Enter the 6-digit code');
        }
        const r = await pairWithLocalCli(targetHost, targetPort, code.trim());
        if (!r.ok) {
          throw new Error(r.error || (lang === 'zh' ? '配对失败' : 'Pairing failed'));
        }
        const machineName = r.machine_name || `CLI-${code}`;
        setConnecting(false);
        setConnected(true);
        setTimeout(() => {
          onPaired({
            name: machineName,
            method: 'local',
            host: targetHost,
            port: targetPort,
            code: code.trim(),
            pairedAt: Date.now(),
          });
          onClose();
        }, 400);
      } else {
        // Tunnel or non-Tauri: save the machine info directly
        const machineName = host.trim() || `CLI-${code || 'tunnel'}`;
        setConnecting(false);
        setConnected(true);
        setTimeout(() => {
          onPaired({
            name: machineName,
            method,
            host: host.trim(),
            port: parseInt(port, 10) || (method === 'ssh' ? 22 : 18789),
            code: code.trim(),
            pairedAt: Date.now(),
          });
          onClose();
        }, 400);
      }
    } catch (e: any) {
      setConnecting(false);
      setError(e?.message || e?.toString() || t('pairFailed'));
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const pill = (m: Method, label: string) => (
    <button
      style={{
        flex: 1, padding: '7px 0', fontSize: 13, borderRadius: 20, cursor: 'pointer',
        border: method === m ? '1px solid var(--hone-accent)' : '1px solid var(--hone-border)',
        background: method === m ? 'var(--hone-accentMuted)' : 'transparent',
        color: method === m ? 'var(--hone-accent)' : 'var(--hone-muted)',
      }}
      onClick={() => { setMethod(m); setError(null); }}
    >
      {label}
    </button>
  );

  const authPill = (m: SshAuthMode, label: string) => (
    <button
      style={{
        flex: 1, padding: '7px 0', fontSize: 12, borderRadius: 16, cursor: 'pointer',
        border: sshAuthMode === m ? '1px solid var(--hone-accent)' : '1px solid var(--hone-border)',
        background: sshAuthMode === m ? 'var(--hone-accentMuted)' : 'transparent',
        color: sshAuthMode === m ? 'var(--hone-accent)' : 'var(--hone-muted)',
      }}
      onClick={() => { setSshAuthMode(m); setError(null); }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'var(--hone-scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 500, maxWidth: 'calc(100vw - 40px)', borderRadius: 12, padding: 28,
        background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
        border: '1px solid var(--hone-border)',
      }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600 }}>{t('pairTitle')}</h2>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--hone-muted)' }}>{t('pairDesc')}</p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {pill('local', t('pairLocal'))}
          {pill('ssh', t('pairSSH'))}
          {pill('tunnel', t('pairTunnel'))}
        </div>

        {method === 'local' && (
          <div>
            <p style={{ fontSize: 12, color: 'var(--hone-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
              {lang === 'zh'
                ? <>在 CLI 实例终端运行 <code style={{ background: 'var(--hone-codeBg)', padding: '1px 5px', borderRadius: 3 }}>hone pair</code>。CLI 会显示主机地址、端口和 6 位配对码——把它们填到下面。</>
                : <>Run <code style={{ background: 'var(--hone-codeBg)', padding: '1px 5px', borderRadius: 3 }}>hone pair</code> in your CLI's terminal. It will print host, port, and a 6-digit code—enter them below.</>
              }
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 2 }}>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4, color: 'var(--hone-muted)' }}>
                  {lang === 'zh' ? '主机' : 'Host'}
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="127.0.0.1"
                  style={{
                    width: '100%', boxSizing: 'border-box' as const,
                    padding: '8px 12px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--hone-border)',
                    background: 'var(--hone-surface)', color: 'var(--hone-text)',
                    outline: 'none', fontFamily: 'monospace',
                  }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4, color: 'var(--hone-muted)' }}>
                  {lang === 'zh' ? '端口' : 'Port'}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={port === '22' ? '18789' : port}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, '');
                    setPort(v);
                  }}
                  placeholder="18789"
                  style={{
                    width: '100%', boxSizing: 'border-box' as const,
                    padding: '8px 12px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--hone-border)',
                    background: 'var(--hone-surface)', color: 'var(--hone-text)',
                    outline: 'none', fontFamily: 'monospace',
                  }}
                />
              </div>
            </div>

            <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6 }}>{t('pairCode')}</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '');
                if (v.length <= 6) setCode(v);
              }}
              placeholder={t('pairCodePlaceholder')}
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '16px', fontSize: 32, textAlign: 'center',
                fontFamily: 'monospace', letterSpacing: 12,
                borderRadius: 8, border: '1px solid var(--hone-border)',
                background: 'var(--hone-surface)', color: 'var(--hone-text)',
                outline: 'none',
              }}
            />

            {useTauri && onScan && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--hone-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {lang === 'zh' ? '或自动发现局域网内设备' : 'Or discover devices on LAN'}
                  </span>
                  <button
                    onClick={onScan}
                    disabled={scanning}
                    style={{
                      padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: scanning ? 'default' : 'pointer',
                      background: scanning ? 'var(--hone-surface)' : 'var(--hone-accent)',
                      color: scanning ? 'var(--hone-muted)' : '#fff', border: 'none', opacity: scanning ? 0.6 : 1,
                    }}
                  >
                    {scanning ? (lang === 'zh' ? '扫描中…' : 'Scanning…') : (lang === 'zh' ? '🔍 扫描' : '🔍 Scan')}
                  </button>
                </div>
                {discoveredGateways && discoveredGateways.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                    {discoveredGateways.map((gw: any, i: number) => (
                      <div
                        key={i}
                        onClick={() => {
                          setCode('');
                          setHost(gw.host || gw.ip || '');
                          setPort(String(gw.port || '18789'));
                        }}
                        style={{
                          padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                          background: 'var(--hone-surface)', border: '1px solid var(--hone-border)',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        }}
                      >
                        <span style={{ fontSize: 13, color: 'var(--hone-text)' }}>{gw.name || gw.id || gw.host}</span>
                        <span style={{ fontSize: 11, color: 'var(--hone-muted)', fontFamily: 'monospace' }}>
                          {gw.host || gw.ip}:{gw.port || '18789'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {method !== 'local' && (
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 4 }}>{t('pairHost')}</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('pairHostPlaceholder')}
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '8px 12px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--hone-border)',
                background: 'var(--hone-surface)', color: 'var(--hone-text)',
                outline: 'none', marginBottom: 14,
              }}
            />
            {method === 'ssh' && (
              <>
                <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 4 }}>{t('pairUsername')}</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('pairUsernamePlaceholder')}
                  style={{
                    width: '100%', boxSizing: 'border-box' as const,
                    padding: '8px 12px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--hone-border)',
                    background: 'var(--hone-surface)', color: 'var(--hone-text)',
                    outline: 'none', marginBottom: 14,
                  }}
                />
              </>
            )}
            <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 4 }}>{t('pairPort')}</label>
            <input
              type="text"
              inputMode="numeric"
              value={port}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '');
                setPort(v);
              }}
              placeholder={method === 'ssh' ? '22' : '18789'}
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '8px 12px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--hone-border)',
                background: 'var(--hone-surface)', color: 'var(--hone-text)',
                outline: 'none', marginBottom: method === 'ssh' ? 14 : 0,
              }}
            />
            {method === 'ssh' && (
              <>
                <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 8 }}>{t('pairAuth')}</label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  {authPill('agent', t('pairAgent'))}
                  {authPill('password', t('pairPassword'))}
                  {authPill('key', t('pairKey'))}
                </div>
                {sshAuthMode === 'password' && (
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={t('pairPasswordPlaceholder')}
                    style={{
                      width: '100%', boxSizing: 'border-box' as const,
                      padding: '8px 12px', fontSize: 13, borderRadius: 6,
                      border: '1px solid var(--hone-border)',
                      background: 'var(--hone-surface)', color: 'var(--hone-text)',
                      outline: 'none',
                    }}
                  />
                )}
                {sshAuthMode === 'key' && (
                  <>
                    <input
                      type="text"
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                      placeholder={t('pairKeyPathPlaceholder')}
                      style={{
                        width: '100%', boxSizing: 'border-box' as const,
                        padding: '8px 12px', fontSize: 13, borderRadius: 6,
                        border: '1px solid var(--hone-border)',
                        background: 'var(--hone-surface)', color: 'var(--hone-text)',
                        outline: 'none', marginBottom: 10,
                      }}
                    />
                    <input
                      type="password"
                      value={sshKeyPassphrase}
                      onChange={(e) => setSshKeyPassphrase(e.target.value)}
                      placeholder={t('pairPassphrasePlaceholder')}
                      style={{
                        width: '100%', boxSizing: 'border-box' as const,
                        padding: '8px 12px', fontSize: 13, borderRadius: 6,
                        border: '1px solid var(--hone-border)',
                        background: 'var(--hone-surface)', color: 'var(--hone-text)',
                        outline: 'none',
                      }}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 14, padding: '8px 12px', borderRadius: 6, fontSize: 13,
            background: 'var(--hone-dangerMuted)', color: 'var(--hone-danger)',
          }}>
            {error}
          </div>
        )}
        {connected && (
          <div style={{
            marginTop: 14, padding: '8px 12px', borderRadius: 6, fontSize: 13,
            background: 'var(--hone-successMuted)', color: 'var(--hone-success)',
          }}>
            {t('pairConnected')}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              background: 'transparent', color: 'var(--hone-text)',
              border: '1px solid var(--hone-border)',
            }}
          >
            {t('pairCancel')}
          </button>
          <button
            onClick={handleConnect}
            disabled={connecting || connected}
            style={{
              padding: '8px 18px', fontSize: 13, borderRadius: 6, cursor: connecting ? 'default' : 'pointer',
              background: connecting || connected ? 'var(--hone-successMuted)' : 'var(--hone-accent)',
              color: connecting || connected ? 'var(--hone-success)' : '#fff',
              border: 'none', opacity: connecting ? 0.7 : 1,
            }}
          >
            {connecting ? t('pairConnecting') : connected ? t('pairConnected') : t('pairConnect')}
          </button>
        </div>
      </div>
    </div>
  );
}
