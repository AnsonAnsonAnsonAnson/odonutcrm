import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { useConfig } from '../../config';
import { LangButton, useI18n } from '../../i18n';
import { ErrorText, Spinner } from '../../components/ui';

type Step = 'email' | 'code' | 'signup';

export default function Join() {
  const cfg = useConfig();
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'email' | 'phone'>('email');
  const [cc, setCc] = useState('+852');
  const [mobile, setMobile] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    country: '+852',
    phone: '',
    year: '',
    month: '',
    day: '',
    gender: '',
    referralCode: '',
    marketingOptIn: true,
    acceptTerms: false,
  });

  useEffect(() => {
    const ref = params.get('ref');
    if (ref) {
      try {
        sessionStorage.setItem('ref', ref);
      } catch {}
    }
    let saved = ref;
    try {
      saved = saved ?? sessionStorage.getItem('ref');
    } catch {}
    if (saved) setForm((f) => ({ ...f, referralCode: saved! }));
    // A promo code on the link (e.g. from the counter poster) is applied once the member exists.
    let p = params.get('promo');
    try {
      if (p) sessionStorage.setItem('promo', p);
      else p = sessionStorage.getItem('promo');
    } catch {}
    if (p) setPromo(p.toUpperCase());
    api('/api/me').then(() => nav('/me', { replace: true })).catch(() => {});
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setError(err.issues?.length ? err.issues.map((i) => i.message).join('. ') : err.message);
    } finally {
      setBusy(false);
    }
  }

  const phone = `${cc}${mobile.replace(/\D/g, '').replace(/^0+/, '')}`;
  const who = mode === 'email' ? { email } : { phone };

  async function claimPromo(): Promise<{ title: string }[]> {
    if (!promo) return [];
    try {
      const r = await api<{ title: string }>('/api/me/promo', { body: { code: promo } });
      return [{ title: r.title }];
    } catch {
      return [];
    } finally {
      try {
        sessionStorage.removeItem('promo');
      } catch {}
    }
  }

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    run(async () => {
      await api('/api/auth/otp', { body: { ...who, locale } });
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ status: string }>('/api/auth/verify', { body: { ...who, code } });
      if (r.status === 'ok') {
        await claimPromo();
        nav('/me', { replace: true });
      }
      else setStep('signup');
    });
  };

  const signup = (e: FormEvent) => {
    e.preventDefault();
    const pad = (s: string) => s.padStart(2, '0');
    run(async () => {
      const r = await api<{ welcomeVouchers: { title: string }[] }>('/api/auth/signup', {
        body: {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: `${form.country}${form.phone}`,
          birthday: `${form.year}-${pad(form.month)}-${pad(form.day)}`,
          gender: form.gender || 'undisclosed',
          marketingOptIn: form.marketingOptIn,
          acceptTerms: form.acceptTerms,
          referralCode: form.referralCode || null,
          locale,
        },
      });
      try {
        sessionStorage.removeItem('ref');
      } catch {}
      const gifts = await claimPromo();
      nav('/me/wallet', { replace: true, state: { welcome: [...r.welcomeVouchers, ...gifts] } });
    });
  };

  const set = (k: keyof typeof form) => (e: any) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  if (step === 'signup') {
    return (
      <div className="page narrow">
        <header className="topbar">
          <button className="back" onClick={() => setStep('email')} aria-label="Back">‹</button>
          <h1>{t('signUp')}</h1>
          <LangButton />
        </header>
        <form className="form" onSubmit={signup}>
          <p className="req-note">* {t('required')}</p>
          <label>* {t('firstName')}<input required value={form.firstName} onChange={set('firstName')} autoComplete="given-name" /></label>
          <label>* {t('lastName')}<input required value={form.lastName} onChange={set('lastName')} autoComplete="family-name" /></label>
          <label>
            * {t('mobile')}
            <div className="row">
              <select value={form.country} onChange={set('country')} className="cc">
                <option>+852</option>
                <option>+853</option>
                <option>+86</option>
                <option>+886</option>
                <option>+65</option>
                <option>+44</option>
                <option>+1</option>
              </select>
              <input required inputMode="tel" value={form.phone} onChange={set('phone')} autoComplete="tel-national" />
            </div>
          </label>
          <fieldset>
            <legend>* {t('dob')}</legend>
            <div className="row">
              <input required placeholder="YYYY" inputMode="numeric" maxLength={4} value={form.year} onChange={set('year')} />
              <input required placeholder="MM" inputMode="numeric" maxLength={2} value={form.month} onChange={set('month')} />
              <input required placeholder="DD" inputMode="numeric" maxLength={2} value={form.day} onChange={set('day')} />
            </div>
          </fieldset>
          <fieldset>
            <legend>* {t('gender')}</legend>
            <div className="radios">
              {(['male', 'female', 'other', 'undisclosed'] as const).map((g) => (
                <label key={g} className="radio">
                  <input type="radio" name="gender" required value={g} checked={form.gender === g} onChange={set('gender')} />
                  {t(g === 'undisclosed' ? 'preferNot' : g)}
                </label>
              ))}
            </div>
          </fieldset>
          <label>{t('referral')}<input value={form.referralCode} onChange={set('referralCode')} /></label>
          <label className="check"><input type="checkbox" checked={form.marketingOptIn} onChange={set('marketingOptIn')} />{t('optIn')}</label>
          <label className="check"><input type="checkbox" required checked={form.acceptTerms} onChange={set('acceptTerms')} />{t('acceptTerms')}</label>
          {cfg.privacyPolicy && <p className="fine"><Link to="/privacy">{t('privacy')}</Link></p>}
          <p className="fine">{cfg.terms}</p>
          <ErrorText error={error} />
          <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : t('join')}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="hero">
      <LangButton />
      <div className="hero-art">
        <img src="/icon.svg" alt="" width={120} height={120} />
        <h1>{cfg.brandName}</h1>
        <p>{t('tagline')}</p>
      </div>
      <div className="sheet">
        <h2 className="divider-title">{t('signInRegister')}</h2>
        {promo && <p className="promo-note">🎁 {t('promoWaiting').replace('{c}', promo)}</p>}
        {step === 'email' ? (
          <form className="form" onSubmit={sendCode}>
            {mode === 'email' ? (
              <label>
                {t('email')}
                <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            ) : (
              <label>
                {t('mobile')}
                <div className="row">
                  <select value={cc} onChange={(e) => setCc(e.target.value)} className="cc">
                    {['+852', '+853', '+86', '+886', '+65', '+44', '+1'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <input required inputMode="tel" autoComplete="tel-national" value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </div>
                <small className="muted">{t('mobileHint')}</small>
              </label>
            )}
            <ErrorText error={error} />
            <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : t('nextStep')}</button>
            {cfg.smsSignIn && (
              <div className="links">
                <button type="button" className="link" onClick={() => { setMode(mode === 'email' ? 'phone' : 'email'); setError(null); }}>
                  {mode === 'email' ? t('useMobile') : t('useEmail')}
                </button>
              </div>
            )}
          </form>
        ) : (
          <form className="form" onSubmit={verify}>
            <p className="muted">{t('codeSent')} <b>{mode === 'email' ? email : phone}</b></p>
            <label>
              {t('code')}
              <input
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                className="otp"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </label>
            <ErrorText error={error} />
            <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : t('verify')}</button>
            <div className="links">
              <button type="button" className="link" onClick={() => sendCode()} disabled={busy}>{t('resend')}</button>
              <button type="button" className="link" onClick={() => { setStep('email'); setCode(''); }}>{mode === 'email' ? t('changeEmail') : t('changeMobile')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
