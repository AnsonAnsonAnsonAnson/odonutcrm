import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText, Qr, Spinner } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useStaff, type StaffMe } from '../../staffSession';
import { useAdminMe } from './AdminLayout';

interface Mine {
  email: string;
  twoStep: boolean;
  twoStepSince: string | null;
  backupCodesLeft: number;
  passwordChangedAt: string | null;
  requireTwoStep: boolean;
}

/** Admin → Security (inside the admin layout). */
export default function SecurityPage() {
  return <Security me={useAdminMe()} />;
}

/** The same page for counter staff, who don't have the admin menu. */
export function StaffSecurityPage() {
  const me = useStaff();
  if (!me) return <div className="center-page"><Spinner /></div>;
  return (
    <div className="staff">
      <header className="staff-head">
        <b>{me.program.brand_name} · Account security</b>
        <span className="spacer" />
        <Link to="/staff" className="link">Back to the counter</Link>
      </header>
      <div className="staff-page">
        <Security me={me} />
      </div>
    </div>
  );
}

function Security({ me }: { me: StaffMe }) {
  const [mine, setMine] = useState<Mine | null>(null);
  const load = () => api<Mine>('/api/staff/security').then(setMine);
  useEffect(() => {
    load();
  }, []);
  if (!mine) return <Spinner />;
  const mustSetUp = mine.requireTwoStep && !mine.twoStep;
  return (
    <div className="security">
      <h1>Security</h1>
      {mustSetUp ? (
        <div className="notice warn">
          <Icon name="lock" />
          <span>The owner asks every owner and manager to use two-step sign-in. Set it up below to open the admin area.</span>
        </div>
      ) : (
        <p className="muted">Keep the member list safe: a strong password, two-step sign-in, and a look at who signed in.</p>
      )}
      <div className="two-col">
        <div>
          <TwoStep mine={mine} reload={load} />
          <Password mine={mine} />
          <Devices />
        </div>
        <div>{me.role === 'owner' && !mustSetUp && <TeamPolicy />}</div>
      </div>
      {me.role === 'owner' && !mustSetUp && <ActivityLog />}
    </div>
  );
}

function TwoStep({ mine, reload }: { mine: Mine; reload: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'idle' | 'disable' | 'regen'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <section className="panel">
        <h3><Icon name="check" /> Two-step sign-in is on</h3>
        <p>
          Keep these <b>backup codes</b> somewhere safe (print them, or save them in your password manager). If you lose your phone, each code
          signs you in once.
        </p>
        <ol className="backup-codes">
          {codes.map((c) => <li key={c}><code>{c}</code></li>)}
        </ol>
        <div className="row wrap no-print">
          <button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn primary grow" onClick={() => window.location.reload()}>I've saved them</button>
        </div>
      </section>
    );
  }

  if (mine.twoStep) {
    return (
      <section className="panel">
        <div className="row between">
          <h3>Two-step sign-in</h3>
          <span className="pill ok">On</span>
        </div>
        <p className="muted">
          Since {fmtDate(mine.twoStepSince)}. Signing in asks for a code from your authenticator app. {mine.backupCodesLeft} backup code
          {mine.backupCodesLeft === 1 ? '' : 's'} left.
        </p>
        {mode === 'idle' ? (
          <div className="row wrap">
            <button className="btn" onClick={() => setMode('regen')}>New backup codes</button>
            {!mine.requireTwoStep && <button className="btn danger-link" onClick={() => setMode('disable')}>Turn off</button>}
          </div>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                if (mode === 'disable') {
                  await api('/api/staff/security/two-step/disable', { body: { password } });
                  window.location.reload();
                } else {
                  setCodes((await api<{ backupCodes: string[] }>('/api/staff/security/two-step/backup-codes', { body: { password } })).backupCodes);
                }
              });
            }}
          >
            <label>
              Your password, to confirm
              <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {mode === 'regen' && <p className="fine">Your old backup codes stop working.</p>}
            <ErrorText error={error} />
            <div className="row">
              <button type="button" className="btn" onClick={() => setMode('idle')}>Cancel</button>
              <button className={`btn grow ${mode === 'disable' ? 'danger' : 'primary'}`} disabled={busy}>
                {mode === 'disable' ? 'Turn off two-step sign-in' : 'Make new backup codes'}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  }

  if (!setup) {
    return (
      <section className="panel">
        <div className="row between">
          <h3>Two-step sign-in</h3>
          <span className="pill warn">Off</span>
        </div>
        <p>
          With two-step sign-in, a stolen or guessed password is not enough: signing in also needs a 6-digit code from an app on your phone.
          Banks and Google use the same method.
        </p>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy} onClick={() => run(async () => setSetup(await api('/api/staff/security/two-step/start', { body: {} })))}>
          Turn on two-step sign-in
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <h3>Set up two-step sign-in</h3>
      <ol className="steps">
        <li>
          On your phone, open an authenticator app: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b>, or on an iPhone the built-in{' '}
          <b>Passwords</b> app (Codes tab). Install one from the App Store or Play Store if you have none.
        </li>
        <li>
          Tap <b>+</b> (or <b>Add code</b>) and scan this QR code:
          <div className="qr-box"><Qr value={setup.uri} size={180} /></div>
          <details>
            <summary>Can't scan? Type this key instead</summary>
            <code className="secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          </details>
        </li>
        <li>Type the 6-digit code the app shows:</li>
      </ol>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api<{ backupCodes: string[] }>('/api/staff/security/two-step/confirm', { body: { code } });
            setCodes(r.backupCodes);
            reload();
          });
        }}
      >
        <input
          className="otp-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))}
          aria-label="6-digit code"
        />
        <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : 'Turn on'}</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

function strength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = Math.min(3, Math.floor(pw.length / 5));
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^\w]/.test(pw)) score++;
  if (pw.length < 10) score = Math.min(score, 1);
  return { score: Math.min(4, score), label: ['Too short', 'Weak', 'OK', 'Good', 'Strong'][Math.min(4, score)] };
}

function Password({ mine }: { mine: Mine }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = strength(f.next);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    if (f.next !== f.again) return setError("The two new passwords don't match");
    setBusy(true);
    try {
      await api('/api/staff/security/password', { body: { current: f.current, next: f.next } });
      setF({ current: '', next: '', again: '' });
      setMsg('Password changed. Any other device signed in to this account has been signed out.');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel form" onSubmit={submit}>
      <h3>Password</h3>
      <p className="muted">
        {mine.passwordChangedAt ? `Last changed ${fmtDate(mine.passwordChangedAt)}.` : 'Still the password you were first given: change it.'} Three or four
        unrelated words make a strong password that's easy to remember, like <i>violet tram kettle moon</i>.
      </p>
      <label>Current password<input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
      <label>
        New password
        <input type="password" required minLength={10} autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        {f.next && (
          <span className="meter" data-score={s.score}>
            <span /><span /><span /><span />
            <em>{s.label}</em>
          </span>
        )}
      </label>
      <label>New password again<input type="password" required autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
      <ErrorText error={error} />
      {msg && <p className="success" role="status">{msg}</p>}
      <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : 'Change password'}</button>
    </form>
  );
}

function Devices() {
  const [done, setDone] = useState(false);
  return (
    <section className="panel">
      <h3>Signed-in devices</h3>
      <p className="muted">Left signed in on a shop tablet or someone else's phone? Sign every other device out. This one stays signed in.</p>
      {done ? (
        <p className="success" role="status">Done. Every other device has to sign in again.</p>
      ) : (
        <button className="btn" onClick={() => api('/api/staff/security/sign-out-everywhere', { body: {} }).then(() => setDone(true))}>
          Sign out all other devices
        </button>
      )}
    </section>
  );
}

function TeamPolicy() {
  const [s, setS] = useState<{ requireTwoStep: boolean; managersWithoutTwoStep: { name: string; email: string; role: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/security').then(setS);
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  return (
    <section className="panel">
      <h3>Team rules</h3>
      <label className="check toggle">
        <input
          type="checkbox"
          checked={s.requireTwoStep}
          onChange={(e) => {
            setError(null);
            api('/api/admin/security', { method: 'PATCH', body: { requireTwoStep: e.target.checked } }).then(load, (err) => setError(err.message));
          }}
        />
        <span>
          <b>Require two-step sign-in for owners and managers</b>
          <small className="muted">They can still use the counter, but the admin area (member details, exports, campaigns) waits until they set it up.</small>
        </span>
      </label>
      <ErrorText error={error} />
      {s.managersWithoutTwoStep.length > 0 ? (
        <>
          <p className="fine">Not using two-step sign-in yet:</p>
          <ul className="list small">
            {s.managersWithoutTwoStep.map((m) => <li key={m.email}>{m.name} <span className="muted">· {m.role} · {m.email}</span></li>)}
          </ul>
        </>
      ) : (
        <p className="success">Every owner and manager uses two-step sign-in.</p>
      )}
      <p className="fine">Lost phone or locked out? An owner can reset someone's two-step sign-in or unlock them in <Link to="/admin/team">Team</Link>.</p>
    </section>
  );
}

const NOUNS: Record<string, string> = {
  'customers/:id': 'a member',
  'customers/:id/stamps': 'stamps for a member',
  'customers/:id/vouchers': 'a voucher for a member',
  'customers/:id/message': 'a message to a member',
  'vouchers/:code/void': 'a voucher (voided)',
  templates: 'a reward', 'templates/:id': 'a reward',
  promos: 'a promo code', 'promos/:id': 'a promo code',
  campaigns: 'a campaign', 'campaigns/:id/send': 'a campaign (sent)', 'campaigns/:id/cancel': 'a campaign (cancelled)', 'campaigns/preview': 'a campaign preview',
  program: 'the program settings', 'program/google-sync': 'the Google Wallet design',
  tiers: 'a tier', 'tiers/:id': 'a tier',
  'api-keys': 'a POS API key', 'api-keys/:id': 'a POS API key',
  stores: 'a store', 'stores/:id': 'a store',
  staff: 'a team member', 'staff/:id': 'a team member',
  security: 'the team security rules',
  'test-email': 'a test email',
  'apple-wallet': 'the Apple Wallet setup', 'apple-wallet/csr': 'an Apple certificate request', 'apple-wallet/certificate': 'the Apple certificate',
};

function describe(a: { action: string; details: any }): { text: string; tone?: 'bad' | 'warn' } {
  switch (a.action) {
    case 'login.ok': return { text: `Signed in${a.details?.method && a.details.method !== 'password' ? ` (${a.details.method})` : ''}` };
    case 'login.failed': return { text: `Failed sign-in: ${a.details?.reason ?? 'wrong password'}`, tone: 'warn' };
    case 'login.locked': return { text: `Account locked after ${a.details?.failures ?? 5} wrong tries`, tone: 'bad' };
    case 'login.reset': return { text: 'Password and two-step reset from the server', tone: 'warn' };
    case 'logout': return { text: 'Signed out' };
    case 'password.changed': return { text: 'Changed their password' };
    case 'sessions.revoked': return { text: 'Signed out all other devices' };
    case 'two_step.enabled': return { text: 'Turned on two-step sign-in' };
    case 'two_step.disabled': return { text: 'Turned off two-step sign-in', tone: 'warn' };
    case 'two_step.backup_codes': return { text: 'Made new backup codes' };
    case 'stamp.undo': return { text: `Undid ${a.details?.removed ?? ''} stamp${a.details?.removed === 1 ? '' : 's'} added by mistake${a.details?.vouchersVoided ? ' (and the reward it gave)' : ''}`, tone: 'warn' };
    case 'voucher.unredeem': return { text: `Put back voucher ${a.details?.code ?? ''} redeemed by mistake`, tone: 'warn' };
  }
  if (a.action.startsWith('export ')) return { text: 'Downloaded the member list (CSV)', tone: 'warn' };
  const [method, route] = a.action.split(' ');
  const verb = { POST: route?.includes('/send') || route === 'test-email' ? 'Sent' : 'Created', PATCH: 'Changed', PUT: 'Changed', DELETE: 'Deleted' }[method] ?? method;
  const fields = a.details?.fields?.length ? ` (${a.details.fields.join(', ')})` : '';
  return { text: `${verb} ${NOUNS[route] ?? route}${fields}`, tone: method === 'DELETE' ? 'warn' : undefined };
}

function device(ua: string | null): string {
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? (ua.includes('iPad') ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' on ') || 'Other';
}

function ActivityLog() {
  const [kind, setKind] = useState<'all' | 'sign-in' | 'changes'>('all');
  const [rows, setRows] = useState<any[] | null>(null);
  const [more, setMore] = useState(false);
  const page = 50;
  const fetchPage = (before?: number) => api<any[]>(`/api/admin/activity-log?limit=${page}&kind=${kind}${before ? `&before=${before}` : ''}`);
  useEffect(() => {
    setRows(null);
    fetchPage().then((r) => {
      setRows(r);
      setMore(r.length === page);
    });
  }, [kind]);

  return (
    <section className="panel activity">
      <div className="row between wrap">
        <div>
          <h3>Activity log</h3>
          <p className="muted">Every sign-in and every change in the admin area: who, what, when and from where.</p>
        </div>
        <div className="tabs">
          {(['all', 'sign-in', 'changes'] as const).map((k) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {{ all: 'Everything', 'sign-in': 'Sign-ins', changes: 'Changes' }[k]}
            </button>
          ))}
        </div>
      </div>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="empty">Nothing here yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const d = describe(r);
                return (
                  <tr key={r.id} className={d.tone ? `tone-${d.tone}` : ''}>
                    <td className="nowrap">{fmtDate(r.at, true)}</td>
                    <td>{r.who ?? <span className="muted">unknown</span>}</td>
                    <td>{d.text}</td>
                    <td className="muted">{[r.ip, device(r.user_agent)].filter(Boolean).join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {more && rows && (
        <button
          className="btn"
          onClick={() =>
            fetchPage(rows.at(-1).id).then((r) => {
              setRows([...rows, ...r]);
              setMore(r.length === page);
            })
          }
        >
          Show older
        </button>
      )}
    </section>
  );
}
