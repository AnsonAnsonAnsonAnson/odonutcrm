import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { ErrorText, Spinner } from '../../components/ui';

export default function StaffLogin() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<{ role: string }>('/api/staff/login', { body: { email, password } });
      const next = params.get('next');
      nav(next && next.startsWith('/') ? next : me.role === 'staff' ? '/staff' : '/admin', { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page staff-bg">
      <form className="form panel" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>Staff sign in</h1>
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : 'Sign in'}</button>
      </form>
    </div>
  );
}
