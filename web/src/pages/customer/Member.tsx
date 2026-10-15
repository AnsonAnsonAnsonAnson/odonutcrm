import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, fmtDate } from '../../api';
import { useConfig } from '../../config';
import { LangButton, useI18n } from '../../i18n';
import { ErrorText, Modal, Qr, Spinner, StampGrid } from '../../components/ui';
import { WalletButtons } from './AddToWallet';

interface Me {
  first_name: string;
  last_name: string;
  email: string;
  stamps: number;
  stamps_required: number;
  qr_token: string;
  referral_code: string;
  active_vouchers: number;
  apple_saved: boolean;
  google_saved: boolean;
  web_push: boolean;
  marketing_opt_in: boolean;
  card_updated_at: string;
}
interface Voucher {
  code: string;
  title: string;
  description: string;
  status: string;
  expires_at: string;
  redeemed_at: string | null;
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function Member() {
  const cfg = useConfig();
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [modal, setModal] = useState<null | 'card' | 'benefits' | 'promo' | 'history' | 'voucher' | 'refer' | 'settings'>(null);
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [promo, setPromo] = useState('');
  const [promoMsg, setPromoMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, v] = await Promise.all([api<Me>('/api/me'), api<Voucher[]>('/api/me/vouchers')]);
      setMe(m);
      setVouchers(v);
    } catch (e) {
      if ((e as ApiError).status === 401) nav('/', { replace: true });
    }
  }, [nav]);

  useEffect(() => {
    load();
    // Keep the card fresh while it is on screen at the counter.
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 15000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (me && locale) api('/api/me', { method: 'PATCH', body: { locale } }).catch(() => {});
  }, [locale, !!me]);

  if (!me) return <div className="center-page"><Spinner /></div>;

  const active = vouchers.filter((v) => v.status === 'active' && new Date(v.expires_at) > new Date());
  const referLink = `${location.origin}/?ref=${me.referral_code}`;

  async function openHistory() {
    setModal('history');
    setHistory(await api('/api/me/history'));
  }

  async function applyPromo(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPromoMsg(null);
    try {
      const r = await api<{ title: string }>('/api/me/promo', { body: { code: promo } });
      setPromoMsg(`🎉 ${r.title}`);
      setPromo('');
      load();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function enablePush() {
    setError(null);
    try {
      if (!cfg.vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('This browser does not support notifications. Add the card to your wallet instead.');
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications were blocked in your browser settings.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey) });
      await api('/api/me/push-subscription', { body: sub.toJSON() });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function logout() {
    await api('/api/auth/logout', { body: {} });
    nav('/', { replace: true });
  }

  async function deleteAccount() {
    if (!confirm(t('deleteConfirm'))) return;
    await api('/api/me', { method: 'DELETE' });
    nav('/', { replace: true });
  }

  const inWallet = me.apple_saved || me.google_saved;

  return (
    <div className="page narrow member">
      <header className="member-head">
        <button className="avatar" onClick={() => setModal('settings')} aria-label={t('settings')}>
          {me.first_name.slice(0, 1).toUpperCase()}
        </button>
        <img src="/icon.svg" alt={cfg.brandName} width={56} height={56} className="brand-mark" />
        <LangButton />
      </header>

      <section className="card" style={{ background: cfg.backgroundColor, color: cfg.foregroundColor }}>
        <div className="card-top">
          <span>{cfg.programName}</span>
          <button className="qr-btn" onClick={() => setModal('card')} aria-label="Show my QR code">
            <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm11-2h2v2h-2v-2zm-3 0h2v3h-2v-3zm5 3h3v2h-3v-2zm-5 2h3v3h-3v-3zm5 2h3v1h-3v-1z" /></svg>
          </button>
        </div>
        <StampGrid stamps={me.stamps} required={me.stamps_required} />
        <div className="card-bottom">
          <small>{t('youHave')}</small>
          <div className="count"><b>{me.stamps}</b> / {me.stamps_required} {t('stamps')}</div>
        </div>
      </section>

      {!inWallet && <WalletButtons compact />}
      {inWallet && <p className="ok-note">✓ {t('walletAdded')}</p>}

      <div className="tiles">
        <button className="tile big" onClick={() => setModal('benefits')}>
          <span className="tile-icon">🎁</span>
          <span>{t('benefits')}</span>
          <small>{t('benefitsHint')}</small>
        </button>
        <div className="tile-col">
          <button className="tile" onClick={() => { setModal('promo'); setPromoMsg(null); setError(null); }}>
            <span className="tile-icon">%</span>{t('promoCode')}
          </button>
          <button className="tile" onClick={openHistory}>
            <span className="tile-icon">↺</span>{t('history')}
          </button>
        </div>
      </div>

      <h2 className="section-title">
        {t('myVouchers')} {active.length > 0 && <span className="badge">{active.length}</span>}
      </h2>
      {active.length === 0 && <p className="muted">{t('noVouchers')}</p>}
      <div className="vouchers">
        {active.map((v) => (
          <button key={v.code} className="voucher" onClick={() => { setVoucher(v); setModal('voucher'); }}>
            <div className="voucher-body">
              <h3>{v.title}</h3>
              <p>📅 {t('expiringOn')} {fmtDate(v.expires_at)}</p>
              <p>◈ {t('singleUse')}</p>
            </div>
            <div className="voucher-art"><img src="/icon.svg" alt="" width={64} height={64} /></div>
          </button>
        ))}
      </div>

      <div className="tiles">
        <button className="tile" onClick={() => setModal('refer')}><span className="tile-icon">♥</span>{t('refer')}</button>
        {cfg.vapidPublicKey && (
          <button className="tile" onClick={enablePush} disabled={me.web_push}>
            <span className="tile-icon">🔔</span>{me.web_push ? t('pushOn') : t('enablePush')}
          </button>
        )}
      </div>
      <ErrorText error={modal ? null : error} />

      <footer className="footer">{t('poweredBy')}</footer>

      <Modal open={modal === 'card'} onClose={() => setModal(null)}>
        <div className="center">
          <Qr value={me.qr_token} size={240} />
          <p className="code">{me.qr_token}</p>
          <p className="muted">{t('showCard')}</p>
        </div>
      </Modal>

      <Modal open={modal === 'voucher'} onClose={() => setModal(null)} title={voucher?.title}>
        {voucher && (
          <div className="center">
            <Qr value={voucher.code} size={220} />
            <p className="code">{voucher.code}</p>
            <p>{voucher.description}</p>
            <p className="muted">{t('showAtCounter')} · {t('expiringOn')} {fmtDate(voucher.expires_at)}</p>
          </div>
        )}
      </Modal>

      <Modal open={modal === 'benefits'} onClose={() => setModal(null)} title={t('benefits')}>
        <h3>{t('howItWorks')}</h3>
        <p>{t('howBody')}</p>
        <h3>{t('perks')}</h3>
        <ul className="perks">
          <li>🍩 {t('perkWelcome')}</li>
          <li>🎂 {t('perkBirthday')}</li>
          <li>💌 {t('perkReferral')}</li>
        </ul>
        <p className="fine">{cfg.terms}</p>
      </Modal>

      <Modal open={modal === 'promo'} onClose={() => setModal(null)} title={t('promoCode')}>
        <form className="form" onSubmit={applyPromo}>
          <input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="HELLODONUT" required autoCapitalize="characters" />
          <ErrorText error={error} />
          {promoMsg && <p className="success">{promoMsg}</p>}
          <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : t('apply')}</button>
        </form>
      </Modal>

      <Modal open={modal === 'history'} onClose={() => setModal(null)} title={t('history')}>
        <ul className="history">
          {history.map((h, i) => (
            <li key={i}>
              <span>
                {h.type === 'stamp' && `${h.delta > 0 ? '+' : ''}${h.delta} ${t('stamps')}`}
                {h.type === 'voucher_issued' && `🎁 ${h.detail}`}
                {h.type === 'voucher_redeemed' && `✓ ${t('used')}: ${h.detail}`}
                {h.store && <small> · {h.store}</small>}
              </span>
              <time>{fmtDate(h.at, true)}</time>
            </li>
          ))}
          {history.length === 0 && <li className="muted">—</li>}
        </ul>
      </Modal>

      <Modal open={modal === 'refer'} onClose={() => setModal(null)} title={t('refer')}>
        <p>{t('referBody')}</p>
        <p className="code">{me.referral_code}</p>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              if (navigator.share) await navigator.share({ title: cfg.brandName, url: referLink }).catch(() => {});
              else {
                await navigator.clipboard.writeText(referLink);
                setCopied(true);
              }
            }}
          >
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
      </Modal>

      <Modal open={modal === 'settings'} onClose={() => setModal(null)} title={t('settings')}>
        <p><b>{me.first_name} {me.last_name}</b><br /><span className="muted">{me.email}</span></p>
        <label className="check">
          <input
            type="checkbox"
            checked={me.marketing_opt_in}
            onChange={async (e) => {
              await api('/api/me', { method: 'PATCH', body: { marketingOptIn: e.target.checked } });
              load();
            }}
          />
          {t('marketing')}
        </label>
        <div className="stack">
          <button className="btn" onClick={logout}>{t('logout')}</button>
          <button className="btn danger-link" onClick={deleteAccount}>{t('deleteAccount')}</button>
        </div>
      </Modal>
    </div>
  );
}
