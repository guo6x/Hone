import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type { GatewayConnectionInfo } from '../../tauri/types';
import type { Lang } from '../../i18n/translations';

interface Props {
  connection: GatewayConnectionInfo | null;
  lang: Lang;
  onRotate: () => Promise<GatewayConnectionInfo | null>;
}

function mobileLink(connection: GatewayConnectionInfo): string {
  const url = new URL(connection.relay_url);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('relay', connection.relay_url);
  url.searchParams.set('pairingId', connection.pairing_id);
  url.searchParams.set('code', connection.pairing_code);
  return url.toString();
}

export function MobileAccessSection({ connection, lang, onRotate }: Props) {
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const link = useMemo(() => connection ? mobileLink(connection) : '', [connection]);
  const zh = lang === 'zh';

  useEffect(() => {
    let cancelled = false;
    if (!link) {
      setQr('');
      return () => { cancelled = true; };
    }
    QRCode.toDataURL(link, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#101419', light: '#FFFFFF' },
    }).then(dataUrl => {
      if (!cancelled) setQr(dataUrl);
    }).catch(() => {
      if (!cancelled) setNotice(zh ? '二维码生成失败' : 'Could not create QR code');
    });
    return () => { cancelled = true; };
  }, [link, zh]);

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNotice(zh ? '链接已复制' : 'Link copied');
    } catch {
      setNotice(zh ? '无法复制链接' : 'Could not copy link');
    }
  };

  const rotate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await onRotate();
      setNotice(zh ? '已生成新的配对码' : 'New pairing code created');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!connection) {
    return (
      <div style={{ maxWidth: 640 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 4px' }}>{zh ? '移动端' : 'Mobile'}</h2>
        <p style={{ fontSize: 13, color: 'var(--hone-muted)' }}>{zh ? '正在读取网关配对信息…' : 'Loading gateway pairing information…'}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 4px' }}>{zh ? '移动端配对' : 'Mobile Pairing'}</h2>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 20 }}>
        {zh ? '扫码后在桌面端批准设备。' : 'Scan, then approve the device on this desktop.'}
      </p>
      <div style={{
        display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap',
        background: 'var(--hone-surface)', border: '1px solid var(--hone-border)', borderRadius: 8, padding: 16,
      }}>
        <div style={{ width: 220, height: 220, background: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          {qr && <img src={qr} width={220} height={220} alt={zh ? '移动端配对二维码' : 'Mobile pairing QR code'} />}
        </div>
        <div style={{ minWidth: 200, flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--hone-muted)', marginBottom: 6 }}>{zh ? '配对码' : 'Pairing code'}</div>
          <div style={{ fontFamily: 'monospace', fontSize: 30, letterSpacing: 6, color: 'var(--hone-accent)', marginBottom: 18 }}>
            {connection.pairing_code}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={copyLink} style={buttonStyle}>
              {zh ? '复制链接' : 'Copy link'}
            </button>
            <button type="button" onClick={rotate} disabled={busy} style={{ ...buttonStyle, opacity: busy ? 0.6 : 1 }}>
              {busy ? (zh ? '生成中…' : 'Creating…') : (zh ? '重新生成' : 'Regenerate')}
            </button>
          </div>
          {notice && <div style={{ fontSize: 12, color: 'var(--hone-muted)', marginTop: 12 }}>{notice}</div>}
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '7px 12px',
  fontSize: 13,
  borderRadius: 6,
  cursor: 'pointer',
  background: 'var(--hone-surfaceRaised)',
  color: 'var(--hone-text)',
  border: '1px solid var(--hone-border)',
};
