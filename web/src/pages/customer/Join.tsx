import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { useConfig } from '../../config';
import { LangButton, useI18n } from '../../i18n';
import { ErrorText, Spinner, Wordmark } from '../../components/ui';
import { Rules } from '../../components/Rules';
import { GoogleButton, inAppBrowser } from '../../components/GoogleButton';
import { Icon } from '../../components/icons';

// One screen to sign in or join, like the big apps: "Continue with Google", or an email code.
// New members then fill in a short profile (and confirm their mobile by text when SMS is on).
type Step = 'start' | 'code' | 'signup';
const COUNTRY_CODES = ['+852', '+853', '+86', '+886', '+65', '+44', '+1'];

export default function Join() {
  const cfg = useConfig();
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<Step>('start');
  const [email, setEmail] = useState('');
  const [account, setAccount] = useState('');
  const [mode, setMode] = useState<'email' | 'phone'>('email');
  const [cc, setCc] = useState('+852');
  const [mobile, setMobile] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [phoneSentTo, setPhoneSentTo] = useState<string | null>(null);
  const [showReferral, setShowReferral] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    country: '+852',
    phone: '',
    phoneCode: '',
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
    if (saved) {
      setForm((f) => ({ ...f, referralCode: saved! }));
      setShowReferral(true);
    }
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
    setErrorCode(null);
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setError(err.issues?.length ? err.issues.map((i) => i.message).join('. ') : err.message);
      setErrorCode(err.code ?? null);
    } finally {
      setBusy(false);
    }
  }

  const fullPhone = (c: string, n: string) => `${c}${n.replace(/\D/g, '').replace(/^0+/, '')}`;
  const phone = fullPhone(cc, mobile);
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

  type AuthResult = { status: 'ok' } | { status: 'signup'; email: string; firstName?: string; lastName?: string };
  async function afterAuth(r: AuthResult) {
    if (r.status === 'ok') {
      await claimPromo();
      nav('/me', { replace: true });
      return;
    }
    setAccount(r.email);
    setForm((f) => ({ ...f, firstName: f.firstName || r.firstName || '', lastName: f.lastName || r.lastName || '' }));
    setStep('signup');
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
    run(async () => afterAuth(await api<AuthResult>('/api/auth/verify', { body: { ...who, code } })));
  };

  const google = (credential: string) => run(async () => afterAuth(await api<AuthResult>('/api/auth/google', { body: { credential } })));

  const signupPhone = fullPhone(form.country, form.phone);
  const sendPhoneCode = () =>
    run(async () => {
      const r = await api<{ required: boolean }>('/api/auth/signup/phone-code', { body: { phone: signupPhone, locale } });
      if (r.required) setPhoneSentTo(signupPhone);
    });

  const signup = (e: FormEvent) => {
    e.preventDefault();
    const pad = (s: string) => s.padStart(2, '0');
    run(async () => {
      const r = await api<{ welcomeVouchers: { title: string }[]; welcomeStamps: number; welcomeAlreadyClaimed: boolean }>('/api/auth/signup', {
        body: {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: signupPhone,
          phoneCode: cfg.verifyPhone ? form.phoneCode : undefined,
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
      nav('/me/wallet', {
        replace: true,
        state: { welcome: [...r.welcomeVouchers, ...gifts], welcomeStamps: r.welcomeStamps, welcomeClaimed: r.welcomeAlreadyClaimed },
      });
    });
  };

  const set = (k: keyof typeof form) => (e: any) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  // The first screen shows the brand illustration, so its top bar only needs the language switch.
  const top = (brand = true) => (
    <header className="auth-top">
      {brand && <Wordmark name={cfg.brandName} height={20} />}
      <LangButton />
    </header>
  );

  if (step === 'signup') {
    const phoneReady = !cfg.verifyPhone || (phoneSentTo === signupPhone && form.phoneCode.length === 6);
    return (
      <div className="auth">
        {top()}
        <main className="auth-card">
          <h1>{t('finishProfile')}</h1>
          <p className="lead">{t('finishLead')}</p>
          <div className="as-chip">
            <span className="avatar-sm">{account.slice(0, 1).toUpperCase()}</span>
            {t('signedInAs')} <b>{account}</b>
          </div>
          <form className="form" onSubmit={signup}>
            <div className="pair">
              <label>{t('firstName')}<input required value={form.firstName} onChange={set('firstName')} autoComplete="given-name" /></label>
              <label>{t('lastName')}<input required value={form.lastName} onChange={set('lastName')} autoComplete="family-name" /></label>
            </div>
            <label>
              {t('mobile')}
              <div className="row">
                <select value={form.country} onChange={set('country')} className="cc" aria-label="Country code">
                  {COUNTRY_CODES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <input required inputMode="tel" value={form.phone} onChange={set('phone')} autoComplete="tel-national" />
                {cfg.verifyPhone && (
                  <button type="button" className="btn" disabled={busy || form.phone.replace(/\D/g, '').length < 6} onClick={sendPhoneCode}>
                    {t('sendCode')}
                  </button>
                )}
              </div>
              <span className="field-note">{t('onePerNumber')}</span>
            </label>
            {cfg.verifyPhone && phoneSentTo === signupPhone && (
              <label>
                {t('textCode')}
                <input
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="otp"
                  value={form.phoneCode}
                  onChange={(e) => setForm((f) => ({ ...f, phoneCode: e.target.value.replace(/\D/g, '') }))}
                  autoFocus
                />
                <span className="field-note">{t('textSent').replace('{p}', phoneSentTo)}</span>
              </label>
            )}
            <fieldset>
              <legend>{t('dob')}</legend>
              <div className="row">
                <input required placeholder="YYYY" inputMode="numeric" maxLength={4} value={form.year} onChange={set('year')} aria-label="Year" />
                <input required placeholder="MM" inputMode="numeric" maxLength={2} value={form.month} onChange={set('month')} aria-label="Month" />
                <input required placeholder="DD" inputMode="numeric" maxLength={2} value={form.day} onChange={set('day')} aria-label="Day" />
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('gender')}</legend>
              <div className="radios">
                {(['female', 'male', 'other', 'undisclosed'] as const).map((g) => (
                  <label key={g} className="radio">
                    <input type="radio" name="gender" required value={g} checked={form.gender === g} onChange={set('gender')} />
                    {t(g === 'undisclosed' ? 'preferNot' : g)}
                  </label>
                ))}
              </div>
            </fieldset>
            {showReferral ? (
              <label>{t('referral')}<input value={form.referralCode} onChange={set('referralCode')} /></label>
            ) : (
              <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setShowReferral(true)}>{t('haveReferral')}</button>
            )}
            <label className="check"><input type="checkbox" checked={form.marketingOptIn} onChange={set('marketingOptIn')} />{t('optIn')}</label>
            <label className="check"><input type="checkbox" required checked={form.acceptTerms} onChange={set('acceptTerms')} />{t('acceptTerms')}</label>
            <ErrorText error={error} />
            {errorCode === 'phone_taken' && (
              <button
                type="button"
                className="link"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  setStep('start');
                  setError(null);
                  if (cfg.smsSignIn) {
                    setMode('phone');
                    setCc(form.country);
                    setMobile(form.phone);
                  }
                }}
              >
                {t('signInInstead')}
              </button>
            )}
            <button className="btn primary block" disabled={busy || !phoneReady}>{busy ? <Spinner /> : t('join')}</button>
            <p className="fine">
              {cfg.terms} {cfg.privacyPolicy && <Link to="/privacy">{t('privacy')}</Link>}
            </p>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="auth">
      {top(false)}
      <main className="auth-card has-hero">
        <img src="/brand/illustration.webp" alt="" width={1600} height={800} className="hero" />
        <h1>{t('joinTitle').replace('{brand}', cfg.brandName)}</h1>
        <p className="lead">{t('joinLead')}</p>
        <Rules joining />
        {cfg.stampPromo && (
          <p className="promo-note">
            <Icon name="star" size={16} />
            <span><b>{cfg.stampPromo.label}</b>: {t('promoMultiplier').replace('{m}', String(cfg.stampPromo.multiplier))}</span>
          </p>
        )}
        {promo && <p className="promo-note"><Icon name="gift" size={16} /><span>{t('promoWaiting').replace('{c}', promo)}</span></p>}

        {step === 'start' ? (
          <>
            {cfg.googleClientId && mode === 'email' && (
              <>
                {inAppBrowser() ? <p className="hint">{t('inAppGoogle')}</p> : <GoogleButton clientId={cfg.googleClientId} locale={locale} onCredential={google} />}
                <div className="or">{t('or')}</div>
              </>
            )}
            <form className="form" onSubmit={sendCode}>
              {mode === 'email' ? (
                <input type="email" required autoComplete="email" placeholder={t('emailAddress')} aria-label={t('emailAddress')} value={email} onChange={(e) => setEmail(e.target.value)} />
              ) : (
                <label>
                  {t('mobile')}
                  <div className="row">
                    <select value={cc} onChange={(e) => setCc(e.target.value)} className="cc" aria-label="Country code">
                      {COUNTRY_CODES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                    <input required inputMode="tel" autoComplete="tel-national" value={mobile} onChange={(e) => setMobile(e.target.value)} />
                  </div>
                  <span className="field-note">{t('mobileHint')}</span>
                </label>
              )}
              <ErrorText error={error} />
              <button className="btn primary block" disabled={busy}>{busy ? <Spinner /> : t('continue')}</button>
              {cfg.smsSignIn && (
                <button type="button" className="link" onClick={() => { setMode(mode === 'email' ? 'phone' : 'email'); setError(null); }}>
                  {mode === 'email' ? t('useMobile') : t('useEmail')}
                </button>
              )}
            </form>
          </>
        ) : (
          <form className="form" onSubmit={verify}>
            <h2 style={{ margin: 0 }}>{mode === 'email' ? t('checkEmail') : t('checkPhone')}</h2>
            <p className="muted" style={{ margin: 0 }}>{t('codeSent')} <b>{mode === 'email' ? email : phone}</b></p>
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              className="otp"
              aria-label={t('code')}
              placeholder="••••••"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            <ErrorText error={error} />
            <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : t('verify')}</button>
            <div className="links">
              <button type="button" className="link" onClick={() => sendCode()} disabled={busy}>{t('resend')}</button>
              <button type="button" className="link subtle" onClick={() => { setStep('start'); setCode(''); }}>{mode === 'email' ? t('changeEmail') : t('changeMobile')}</button>
            </div>
          </form>
        )}
      </main>
      <p className="fine auth-foot">
        {t('agreeLine')} {cfg.privacyPolicy && <Link to="/privacy">{t('privacy')}</Link>}
      </p>
    </div>
  );
}
