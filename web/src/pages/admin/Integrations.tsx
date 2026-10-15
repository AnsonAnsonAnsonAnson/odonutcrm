import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText } from '../../components/ui';

export default function Integrations() {
  const [keys, setKeys] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', storeId: '' });
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/api-keys').then(setKeys);
  useEffect(() => {
    load();
    api('/api/admin/stores').then(setStores);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api('/api/admin/api-keys', { body: { name: f.name, storeId: f.storeId || null } });
      setCreated(r.key);
      setF({ name: '', storeId: '' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? The till using it stops stamping straight away.')) return;
    await api(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
    load();
  }

  const base = `${location.origin}/api/pos/v1`;

  return (
    <div>
      <h1>POS integration</h1>
      <p className="muted">
        Give your till (POS) an API key and it can stamp cards automatically after each paid order, look up members by phone, and redeem
        vouchers, without staff scanning anything. Each order id stamps only once, so retries are safe.
      </p>
      <table className="table">
        <thead><tr><th>Key</th><th>Store</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className={k.revoked_at ? 'dim' : ''}>
              <td><b>{k.name}</b><br /><small className="muted code-sm">{k.prefix}…</small></td>
              <td>{k.store_name ?? 'Any'}</td>
              <td>{fmtDate(k.created_at)}</td>
              <td>{k.last_used_at ? fmtDate(k.last_used_at, true) : 'Never'}</td>
              <td>{k.revoked_at ? <span className="muted">Revoked</span> : <button className="link" onClick={() => revoke(k.id)}>Revoke</button>}</td>
            </tr>
          ))}
          {keys.length === 0 && <tr><td colSpan={5} className="muted">No keys yet.</td></tr>}
        </tbody>
      </table>
      {created && (
        <div className="panel">
          <h3>Copy this key now</h3>
          <p className="muted">It is shown only once. Paste it into your POS settings; if you lose it, revoke it and make a new one.</p>
          <p className="code wrap-any">{created}</p>
          <div className="row">
            <button className="btn" onClick={() => navigator.clipboard.writeText(created)}>Copy</button>
            <button className="btn" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}
      <form className="panel form" onSubmit={create}>
        <h3>New API key</h3>
        <div className="row wrap">
          <label className="grow">Name<input required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Central shop till" /></label>
          <label>Store
            <select value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}>
              <option value="">Any store</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <ErrorText error={error} />
        <button className="btn primary">Create key</button>
      </form>
      <div className="panel">
        <h3>For your POS developer</h3>
        <p className="muted">Send <code>Authorization: Bearer &lt;key&gt;</code> with every request. Full reference in docs/02-system-plan.md.</p>
        <pre className="pre">{`GET  ${base}/members/lookup?phone=91234567   (or ?qrToken=CARDCODE)
POST ${base}/stamps          {"member":{"phone":"91234567"},"orderId":"A1001","count":1}
GET  ${base}/vouchers/CODE
POST ${base}/vouchers/redeem {"code":"CODE"}`}</pre>
      </div>
    </div>
  );
}
