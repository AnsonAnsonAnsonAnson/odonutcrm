import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { ErrorText, Spinner } from '../../components/ui';
import { Icon } from '../../components/icons';

/** Only same-site paths, so a crafted link can't send someone to another website after signing in. */
function safeNext(next: string | null): string | null {
  return next && /^\/(?![/\\])/.test(next) ? next : null;
}

export default function StaffLogin() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (role: string) => nav(safeNext(params.get('next')) ?? (role === 'staff' ? '/staff' : '/admin'), { replace: true });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const r = await api<{ status: string; role: string }>('/api/staff/login', { body: { email, password } });
        if (r.status === 'two_step') {
          setStep('code');
          setPassword('');
        } else done(r.role);
      } else {
        const r = await api<{ role: string }>('/api/staff/login/two-step', { body: { code } });
        done(r.role);
      }
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'expired') {
        setStep('password');
        setCode('');
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page staff-bg">
      <form className="form panel login" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        {step === 'password' ? (
          <>
            <h1>Staff sign in</h1>
            <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus /></label>
            <label>
              Password
              <span className="input-with-btn">
                <input type={show ? 'text' : 'password'} required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
                  <Icon name={show ? 'eyeOff' : 'eye'} />
                </button>
              </span>
            </label>
          </>
        ) : (
          <>
            <h1>Two-step sign-in</h1>
            <p className="muted">
              {backup ? 'Type one of your backup codes (like 7KQM-X2PD). Each works once.' : 'Open your authenticator app and type the 6-digit code for this account.'}
            </p>
            <input
              className="otp-input"
              autoFocus
              required
              inputMode={backup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={backup ? 'XXXX-XXXX' : '123456'}
              maxLength={backup ? 12 : 7}
              value={code}
              onChange={(e) => setCode(backup ? e.target.value.toUpperCase() : e.target.value.replace(/[^\d]/g, ''))}
              aria-label={backup ? 'Backup code' : '6-digit code'}
            />
            <button type="button" className="link" onClick={() => { setBackup(!backup); setCode(''); setError(null); }}>
              {backup ? 'Use the authenticator app instead' : 'Lost your phone? Use a backup code'}
            </button>
          </>
        )}
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : step === 'password' ? 'Sign in' : 'Continue'}</button>
        {step === 'password' ? (
          <p className="fine">Forgot your password? Ask the owner to reset it in Admin → Team.</p>
        ) : (
          <button type="button" className="link subtle" onClick={() => { setStep('password'); setCode(''); setError(null); }}>Back</button>
        )}
      </form>
    </div>
  );
}
