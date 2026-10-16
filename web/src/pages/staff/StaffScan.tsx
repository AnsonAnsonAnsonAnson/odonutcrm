import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, fmtDate, newKey } from '../../api';
import { ErrorText, Scanner, Spinner, StampGrid } from '../../components/ui';
import { useStaff } from '../../staffSession';

interface Summary {
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string | null;
    visit_count: number;
    last_visit_at: string | null;
    birthday: string | null;
    card_id: string;
    qr_token: string;
    stamps: number;
    stamps_required: number;
    tier: string | null;
  };
  vouchers: { code: string; title: string; description: string; expires_at: string }[];
}
type ScanResult = (Summary & { type: 'card' }) | (Summary & { type: 'voucher'; voucher: { code: string; status: string; title: string; expires_at: string } });

export default function StaffScan() {
  const me = useStaff();
  const nav = useNavigate();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState('');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [matches, setMatches] = useState<Summary[]>([]);

  const loadActivity = useCallback(() => api('/api/staff/activity').then(setActivity).catch(() => {}), []);
  useEffect(() => {
    if (me) loadActivity();
  }, [me]);

  const scan = useCallback(async (code: string) => {
    setError(null);
    setFlash(null);
    setMatches([]);
    try {
      const r = await api<ScanResult>('/api/staff/scan', { body: { code } });
      setResult(r);
      setCount(1);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    const q = manual.trim();
    if (!q) return;
    if (/^(ODC-|V)[A-Z0-9-]+$/i.test(q)) return scan(q);
    setError(null);
    try {
      const rows = await api<Summary[]>(`/api/staff/lookup?q=${encodeURIComponent(q)}`);
      if (!rows.length) setError('No member found with that phone number or email');
      else if (rows.length === 1) setResult({ type: 'card', ...rows[0] });
      else setMatches(rows);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  async function stamp() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ stamps: number; stampsRequired: number; rewards: { title: string }[]; tierUpgrade: string | null; bonus: number }>('/api/staff/stamp', {
        body: { cardId: result.customer.card_id, count, idempotencyKey: newKey() },
      });
      let msg = r.rewards.length
        ? `🎉 Card complete! ${r.rewards.map((x) => x.title).join(', ')} issued. Now ${r.stamps}/${r.stampsRequired}.`
        : `✓ ${count + r.bonus} stamp${count + r.bonus > 1 ? 's' : ''} added${r.bonus ? ` (${count} + ${r.bonus} bonus)` : ''}. Now ${r.stamps}/${r.stampsRequired}.`;
      if (r.tierUpgrade) msg += ` ⭐ Now a ${r.tierUpgrade} member!`;
      await scan(result.customer.qr_token);
      setFlash(msg);
      loadActivity();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function redeem(code: string, title: string) {
    if (!confirm(`Redeem "${title}" now? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/staff/redeem', { body: { code } });
      const qr = result!.customer.qr_token;
      await scan(qr);
      setFlash(`✓ ${title} redeemed`);
      loadActivity();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/api/staff/logout', { body: {} });
    nav('/staff/login', { replace: true });
  }

  if (!me) return <div className="center-page"><Spinner /></div>;
  const c = result?.customer;
  const max = me.program.max_stamps_per_scan;

  return (
    <div className="staff">
      <header className="staff-head">
        <b>{me.program.brand_name} · Counter</b>
        <span className="muted">{me.name}{me.store ? ` @ ${me.store.name}` : ''}</span>
        <span className="spacer" />
        {me.role !== 'staff' && <Link to="/admin" className="link">Admin</Link>}
        <button className="link" onClick={logout}>Sign out</button>
      </header>
      {me.promo && <div className="promo-strip">⭐ {me.promo.label} is on: every purchase stamp counts {me.promo.multiplier}×. Add the real number of items; the bonus is automatic.</div>}

      <div className="staff-grid">
        <section>
          <Scanner onResult={scan} paused={busy} />
          <form className="row" onSubmit={lookup}>
            <input placeholder="Card / voucher code, phone or email" value={manual} onChange={(e) => setManual(e.target.value)} />
            <button className="btn">Find</button>
          </form>
          {matches.length > 1 && (
            <ul className="list">
              {matches.map((m) => (
                <li key={m.customer.id}>
                  <button className="link" onClick={() => { setResult({ type: 'card', ...m }); setMatches([]); }}>
                    {m.customer.first_name} {m.customer.last_name} · {m.customer.phone}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel result">
          <ErrorText error={error} />
          {flash && <p className="success big">{flash}</p>}
          {!c && !error && <p className="muted">Scan the QR on the member's wallet card or voucher.</p>}
          {c && (
            <>
              <h2>{c.first_name} {c.last_name} {c.tier && <span className="tier-pill">{c.tier}</span>}</h2>
              <p className="muted">
                {c.visit_count} visit{c.visit_count === 1 ? '' : 's'}
                {c.last_visit_at && ` · last ${fmtDate(c.last_visit_at)}`}
                {c.birthday && c.birthday.slice(5) === new Date().toISOString().slice(5, 10) && ' · 🎂 Birthday today!'}
              </p>
              <StampGrid stamps={c.stamps} required={c.stamps_required} />
              <p className="count"><b>{c.stamps}</b> / {c.stamps_required} stamps</p>

              {result?.type === 'voucher' && (
                <div className="voucher-check">
                  <h3>Scanned voucher: {result.voucher.title}</h3>
                  {result.voucher.status === 'active' && new Date(result.voucher.expires_at) > new Date() ? (
                    <button className="btn primary" disabled={busy} onClick={() => redeem(result.voucher.code, result.voucher.title)}>
                      Redeem {result.voucher.title}
                    </button>
                  ) : (
                    <p className="error">This voucher is {result.voucher.status === 'active' ? 'expired' : result.voucher.status}.</p>
                  )}
                </div>
              )}

              <div className="stepper">
                <button className="btn" onClick={() => setCount(Math.max(1, count - 1))} aria-label="Fewer">−</button>
                <span>{count}</span>
                <button className="btn" onClick={() => setCount(Math.min(max, count + 1))} aria-label="More">+</button>
                <button className="btn primary grow" disabled={busy} onClick={stamp}>
                  {busy ? <Spinner /> : `Add ${count} stamp${count > 1 ? 's' : ''}`}
                </button>
              </div>

              <h3>Vouchers</h3>
              {result!.vouchers.length === 0 && <p className="muted">No active vouchers.</p>}
              <ul className="list">
                {result!.vouchers.map((v) => (
                  <li key={v.code} className="row between">
                    <span><b>{v.title}</b><br /><small className="muted">until {fmtDate(v.expires_at)} · {v.code}</small></span>
                    <button className="btn" disabled={busy} onClick={() => redeem(v.code, v.title)}>Redeem</button>
                  </li>
                ))}
              </ul>
              <button className="link" onClick={() => { setResult(null); setFlash(null); }}>Next customer</button>
            </>
          )}
        </section>

        <section className="panel">
          <h3>Last 24 hours</h3>
          <ul className="list small">
            {activity.map((a, i) => (
              <li key={i} className="row between">
                <span>{a.type === 'stamp' ? `+${a.delta} · ${a.customer}` : `🎁 ${a.customer}`}</span>
                <time className="muted">{fmtDate(a.at, true).slice(11)}</time>
              </li>
            ))}
            {activity.length === 0 && <li className="muted">Nothing yet today.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
