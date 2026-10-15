import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText, Spinner, StampGrid } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

export function Members() {
  const me = useAdminMe();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: any[]; total: number } | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      api(`/api/admin/customers?q=${encodeURIComponent(q)}&sort=${sort}&page=${page}`).then(setData);
    }, 250);
    return () => clearTimeout(id);
  }, [q, sort, page]);
  return (
    <div>
      <div className="row between">
        <h1>Members {data && <small className="muted">({data.total})</small>}</h1>
        {me.role === 'owner' && <a className="btn" href="/api/admin/customers.csv">Export CSV</a>}
      </div>
      <div className="row">
        <input placeholder="Search name, email or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="recent">Newest</option>
          <option value="last_visit">Last visit</option>
          <option value="visits">Most visits</option>
          <option value="stamps">Most stamps</option>
        </select>
      </div>
      {!data ? <Spinner /> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Stamps</th><th>Visits</th><th>Last visit</th><th>Wallet</th><th>Opt-in</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/admin/members/${r.id}`}>{r.first_name} {r.last_name}</Link></td>
                <td>{r.email}</td>
                <td>{r.stamps}</td>
                <td>{r.visit_count}</td>
                <td>{fmtDate(r.last_visit_at)}</td>
                <td>{[r.apple_saved && 'Apple', r.google_saved && 'Google'].filter(Boolean).join(', ') || '–'}</td>
                <td>{r.marketing_opt_in ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > 50 && (
        <div className="row">
          <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page}</span>
          <button className="btn" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

export function MemberDetail() {
  const { id } = useParams();
  const me = useAdminMe();
  const [d, setD] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [adj, setAdj] = useState({ delta: 1, note: '' });
  const [msg, setMsg] = useState({ title: '', body: '' });
  const [tpl, setTpl] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');

  const load = () =>
    api(`/api/admin/customers/${id}`).then((r) => {
      setD(r);
      setTags(r.customer.tags.join(', '));
      setNotes(r.customer.notes);
    });
  useEffect(() => {
    load();
    api('/api/admin/templates').then((t) => setTemplates(t.filter((x: any) => x.active)));
  }, [id]);

  async function act(fn: () => Promise<any>, success: string) {
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(success);
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  if (!d) return <Spinner />;
  const c = d.customer;
  return (
    <div>
      <Link to="/admin/members" className="link">← Members</Link>
      <h1>{c.first_name} {c.last_name}</h1>
      <p className="muted">
        {c.email} · {c.phone} · joined {fmtDate(c.created_at)} · birthday {c.birthday ?? '–'}
        {c.referred_by_name && ` · referred by ${c.referred_by_name}`} · {c.referrals} referral(s)
      </p>
      <ErrorText error={error} />
      {ok && <p className="success">{ok}</p>}
      <div className="two-col">
        <div className="panel">
          <StampGrid stamps={c.stamps} required={me.program.stamps_required} />
          <p><b>{c.stamps}</b> stamps now · {c.lifetime_stamps} lifetime · {c.rewards_earned} cards completed · {c.visit_count} visits</p>
          <p className="muted">
            Apple Wallet: {c.apple_saved ? 'yes' : 'no'} · Google Wallet: {c.google_saved ? 'yes' : 'no'} · Web push: {c.web_push ? 'yes' : 'no'} · Marketing: {c.marketing_opt_in ? 'opted in' : 'opted out'}
          </p>
          <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/stamps`, { body: adj }), 'Stamps updated'); }}>
            <input type="number" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: Number(e.target.value) })} style={{ width: 80 }} />
            <input placeholder="Reason (required)" required value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
            <button className="btn">Adjust stamps</button>
          </form>
          <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/vouchers`, { body: { templateId: tpl } }), 'Voucher sent'); }}>
            <select required value={tpl} onChange={(e) => setTpl(e.target.value)}>
              <option value="">Choose a voucher…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button className="btn">Gift voucher</button>
          </form>
          <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/message`, { body: msg }), 'Message sent'); }}>
            <input placeholder="Message title" required maxLength={60} value={msg.title} onChange={(e) => setMsg({ ...msg, title: e.target.value })} />
            <input placeholder="Message (shows on their lock screen)" required maxLength={240} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
            <button className="btn">Send push message</button>
          </form>
          <form className="stack" onSubmit={(e: FormEvent) => {
            e.preventDefault();
            act(() => api(`/api/admin/customers/${id}`, { method: 'PATCH', body: { tags: tags.split(',').map((s) => s.trim()).filter(Boolean), notes } }), 'Saved');
          }}>
            <label>Tags (comma separated)<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
            <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            <button className="btn">Save</button>
          </form>
          {me.role === 'owner' && (
            <button className="btn danger-link" onClick={() => {
              if (confirm('Permanently delete this member and all their data?')) {
                act(() => api(`/api/admin/customers/${id}`, { method: 'DELETE' }), 'Deleted').then(() => history.back());
              }
            }}>Delete member</button>
          )}
        </div>
        <div className="panel">
          <h3>Vouchers</h3>
          <table>
            <tbody>
              {d.vouchers.map((v: any) => (
                <tr key={v.code}>
                  <td>{v.title}<br /><small className="muted">{v.code} · {v.source.replace('_', ' ')}</small></td>
                  <td>{v.status}{v.status === 'active' && ` until ${fmtDate(v.expires_at)}`}</td>
                  <td>{v.status === 'active' && <button className="link" onClick={() => confirm('Void this voucher?') && act(() => api(`/api/admin/vouchers/${v.code}/void`, { body: {} }), 'Voucher voided')}>Void</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Activity</h3>
          <ul className="list small">
            {d.history.map((h: any, i: number) => (
              <li key={i} className="row between">
                <span>{h.type === 'stamp' ? `${h.delta > 0 ? '+' : ''}${h.delta} stamp (${h.detail})` : `${h.type === 'voucher_issued' ? 'Got' : 'Used'} ${h.detail}`}{h.store ? ` · ${h.store}` : ''}</span>
                <time className="muted">{fmtDate(h.at, true)}</time>
              </li>
            ))}
          </ul>
          <h3>Messages sent</h3>
          <ul className="list small">
            {d.notifications.map((n: any, i: number) => (
              <li key={i}><b>{n.title}</b> {n.body} <small className="muted">· {fmtDate(n.created_at, true)} · {n.channels.join(', ') || 'no device reached'}</small></li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
