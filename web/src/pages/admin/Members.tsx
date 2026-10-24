import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, fmtAgo, fmtDate, fmtMoney } from '../../api';
import { ErrorText, Spinner, StampGrid } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useAdminMe } from './AdminLayout';
import type { Group } from './Groups';
import { VOUCHER_SOURCE } from './labels';

const initials = (first: string, last: string) => `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || '?';

export function Members() {
  const me = useAdminMe();
  const [params, setParams] = useSearchParams();
  const group = params.get('group') ?? '';
  const [groups, setGroups] = useState<Group[]>([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: any[]; total: number } | null>(null);
  useEffect(() => {
    api('/api/admin/groups').then(setGroups).catch(() => {});
  }, []);
  useEffect(() => {
    const id = setTimeout(() => {
      api(`/api/admin/customers?q=${encodeURIComponent(q)}&sort=${sort}&page=${page}${group ? `&group=${group}` : ''}`).then(setData);
    }, 250);
    return () => clearTimeout(id);
  }, [q, sort, page, group]);
  const current = groups.find((g) => g.id === group);
  const setGroup = (id: string) => {
    setPage(1);
    setParams(id ? { group: id } : {});
  };
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Members {data && <small className="muted">({data.total})</small>}</h1>
          <p>{current ? `${current.name}: ${current.description}` : 'Everyone who has joined the club.'}</p>
        </div>
        <div className="actions">
          {current && me.role === 'owner' && <Link className="btn primary" to={`/admin/campaigns?group=${current.id}`}>Message this group</Link>}
          {me.role === 'owner' && (
            <a className="btn" href={`/api/admin/customers.csv${group ? `?group=${group}` : ''}`}><Icon name="download" size={16} /> Export CSV</a>
          )}
        </div>
      </div>
      <div className="filters">
        <div className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search name, email or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">All members</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members})</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="recent">Newest</option>
          <option value="last_visit">Last visit</option>
          <option value="visits">Most visits</option>
          <option value="spend">Most spent</option>
          <option value="stamps">Most stamps</option>
        </select>
      </div>
      {!data ? <Spinner /> : (
        <div className="table table-scroll">
          <table>
            <thead><tr><th>Member</th><th>Tier</th><th className="num">Stamps</th><th className="num">Visits</th><th className="num">Spent</th><th>Last visit</th><th>Wallet</th><th>Offers</th></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={8} className="empty">No members match.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/members/${r.id}`} className="who">
                      <span className="avatar-sm">{initials(r.first_name, r.last_name)}</span>
                      <span><b>{r.first_name} {r.last_name}</b><small>{r.email}</small></span>
                    </Link>
                  </td>
                  <td>{r.tier ? <span className="pill">{r.tier}</span> : '–'}</td>
                  <td className="num">{r.stamps}</td>
                  <td className="num">{r.visit_count}</td>
                  <td className="num">{fmtMoney(r.total_spend)}</td>
                  <td>{r.last_visit_at ? fmtAgo(r.last_visit_at) : <span className="muted">Not yet</span>}</td>
                  <td>{[r.apple_saved && 'Apple', r.google_saved && 'Google'].filter(Boolean).join(', ') || '–'}</td>
                  <td>{r.marketing_opt_in ? <span className="pill ok">Yes</span> : <span className="pill">No</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 50 && (
        <div className="row">
          <button className="btn" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {Math.ceil(data.total / 50)}</span>
          <button className="btn" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

const SOURCE = VOUCHER_SOURCE;

function timelineText(h: any) {
  if (h.type === 'stamp') {
    const n = `${h.delta > 0 ? '+' : ''}${h.delta} stamp${Math.abs(h.delta) === 1 ? '' : 's'}`;
    if (h.detail === 'purchase') return { icon: 'receipt', title: h.amount != null ? `Visit, ${fmtMoney(h.amount)} bill` : 'Visit', sub: n };
    if (h.detail === 'bonus') return { icon: 'star', title: h.note || 'Bonus stamps', sub: n };
    return { icon: 'history', title: h.note ? `Adjusted: ${h.note}` : 'Stamps adjusted', sub: n };
  }
  if (h.type === 'voucher_issued') return { icon: 'gift', title: `Received ${h.detail}`, sub: SOURCE[h.note] ?? '' };
  return { icon: 'ticket', title: `Used ${h.detail}`, sub: '' };
}

export function MemberDetail() {
  const { id } = useParams();
  const me = useAdminMe();
  const [d, setD] = useState<any>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [tab, setTab] = useState<'activity' | 'vouchers' | 'messages'>('activity');
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
    api('/api/admin/groups').then(setGroups).catch(() => {});
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
  const s = d.stats;
  const activeVouchers = d.vouchers.filter((v: any) => v.status === 'active' && new Date(v.expires_at) > new Date());
  const memberGroups = groups.filter((g) => d.groups.includes(g.id));
  const facts = [
    ['Stamps now', `${c.stamps} / ${me.program.stamps_required}`],
    ['Visits', c.visit_count],
    ['Total spent', fmtMoney(c.total_spend)],
    ['Average bill', s.avg_bill != null ? fmtMoney(Math.round(s.avg_bill * 100) / 100) : '–'],
    ['Last visit', c.last_visit_at ? fmtAgo(c.last_visit_at) : 'Not yet'],
    ['Rewards earned', c.rewards_earned],
  ];
  return (
    <div className="profile">
      <Link to="/admin/members" className="back-link"><Icon name="arrowLeft" size={16} /> Members</Link>
      <div className="profile-head">
        <span className="avatar-lg">{initials(c.first_name, c.last_name)}</span>
        <div className="profile-id">
          <h1>{c.first_name} {c.last_name} {c.tier && <span className="tier-pill">{c.tier}</span>}</h1>
          <p className="muted">
            Member since {fmtDate(c.created_at)}
            {s.first_visit && ` · first visit ${fmtDate(s.first_visit)}`}
            {c.referred_by_name && <> · referred by <Link to={`/admin/members/${c.referred_by}`}>{c.referred_by_name}</Link></>}
          </p>
          {memberGroups.length > 0 && (
            <div className="pills">
              {memberGroups.map((g) => <Link key={g.id} to={`/admin/members?group=${g.id}`} className="pill accent">{g.name}</Link>)}
            </div>
          )}
        </div>
      </div>
      <ErrorText error={error} />
      {ok && <p className="notice ok"><Icon name="check" /><span>{ok}</span></p>}

      <div className="facts">
        {facts.map(([label, value]) => (
          <div key={label as string}><small>{label}</small><b>{value}</b></div>
        ))}
      </div>

      <div className="profile-grid">
        <div>
          <div className="panel">
            <h3>Contact</h3>
            <dl className="dl">
              <dt><Icon name="mail" size={16} /> Email</dt><dd className="wrap-any">{c.email}</dd>
              <dt><Icon name="phone" size={16} /> Mobile</dt><dd>{c.phone || '–'}</dd>
              <dt><Icon name="cake" size={16} /> Birthday</dt><dd>{c.birthday ? fmtDate(c.birthday) : '–'}</dd>
              <dt><Icon name="bell" size={16} /> Offers</dt><dd>{c.marketing_opt_in ? 'Agreed to receive offers' : 'No marketing'}</dd>
              <dt><Icon name="wallet" size={16} /> Card on</dt>
              <dd>{[c.apple_saved && 'Apple Wallet', c.google_saved && 'Google Wallet', c.web_push && 'web push'].filter(Boolean).join(', ') || 'Web only'}</dd>
              <dt><Icon name="users" size={16} /> Referrals</dt><dd>{c.referrals} friend{c.referrals === 1 ? '' : 's'} joined</dd>
            </dl>
            {d.referred.length > 0 && (
              <ul className="list small">
                {d.referred.map((r: any) => (
                  <li key={r.id} className="row between"><Link to={`/admin/members/${r.id}`}>{r.first_name} {r.last_name}</Link><span className="muted">{r.visit_count} visits</span></li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h3>Card</h3>
            <StampGrid stamps={c.stamps} required={me.program.stamps_required} />
            <p className="fine">{c.lifetime_stamps} stamps in total · {c.rewards_earned} full cards · {s.visits_90d} visits in the last 90 days</p>
            <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/stamps`, { body: adj }), 'Stamps updated'); }}>
              <input type="number" aria-label="Stamps to add or remove" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: Number(e.target.value) })} style={{ width: 76 }} />
              <input placeholder="Reason (required)" required value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} className="grow" />
              <button className="btn">Adjust</button>
            </form>
          </div>

          <div className="panel">
            <h3>Send something</h3>
            <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/vouchers`, { body: { templateId: tpl } }), 'Voucher sent'); }}>
              <select required value={tpl} onChange={(e) => setTpl(e.target.value)} className="grow">
                <option value="">Choose a voucher…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <button className="btn">Gift voucher</button>
            </form>
            <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api(`/api/admin/customers/${id}/message`, { body: msg }), 'Message sent'); }}>
              <input placeholder="Message title" required maxLength={60} value={msg.title} onChange={(e) => setMsg({ ...msg, title: e.target.value })} />
              <input placeholder="Message (shows on their lock screen)" required maxLength={240} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
              <button className="btn">Send message</button>
            </form>
          </div>

          <div className="panel">
            <h3>Notes and tags</h3>
            <form className="stack" onSubmit={(e: FormEvent) => {
              e.preventDefault();
              act(() => api(`/api/admin/customers/${id}`, { method: 'PATCH', body: { tags: tags.split(',').map((s) => s.trim()).filter(Boolean), notes } }), 'Saved');
            }}>
              <label>Tags (comma separated)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. office order, allergy: nuts" /></label>
              <label>Notes (staff only)<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
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
        </div>

        <div className="panel">
          <div className="seg" role="tablist">
            <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
            <button className={tab === 'vouchers' ? 'on' : ''} onClick={() => setTab('vouchers')}>Vouchers {activeVouchers.length > 0 && <span className="badge">{activeVouchers.length}</span>}</button>
            <button className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>Messages</button>
          </div>
          {tab === 'activity' && (
            <ol className="timeline">
              {d.history.length === 0 && <li className="empty">Nothing yet.</li>}
              {d.history.map((h: any, i: number) => {
                const t = timelineText(h);
                return (
                  <li key={i}>
                    <span className="tl-icon"><Icon name={t.icon} size={16} /></span>
                    <div>
                      <b>{t.title}</b>
                      <small className="muted">{[t.sub, h.store, h.staff && `by ${h.staff}`].filter(Boolean).join(' · ')}</small>
                    </div>
                    <time className="muted">{fmtDate(h.at, true)}</time>
                  </li>
                );
              })}
            </ol>
          )}
          {tab === 'vouchers' && (
            <table>
              <tbody>
                {d.vouchers.length === 0 && <tr><td className="empty">No vouchers yet.</td></tr>}
                {d.vouchers.map((v: any) => {
                  const live = v.status === 'active' && new Date(v.expires_at) > new Date();
                  return (
                    <tr key={v.code}>
                      <td><b>{v.title}</b><br /><small className="muted">{v.code} · {SOURCE[v.source] ?? v.source}</small></td>
                      <td>
                        {live ? <span className="pill ok">Until {fmtDate(v.expires_at)}</span>
                          : v.status === 'redeemed' ? <span className="pill">Used {fmtDate(v.redeemed_at)}</span>
                          : v.status === 'void' ? <span className="pill bad">Voided</span>
                          : <span className="pill warn">Expired</span>}
                      </td>
                      <td className="num">{live && <button className="link" onClick={() => confirm('Void this voucher?') && act(() => api(`/api/admin/vouchers/${v.code}/void`, { body: {} }), 'Voucher voided')}>Void</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {tab === 'messages' && (
            <ul className="list small">
              {d.notifications.length === 0 && <li className="empty">No messages sent yet.</li>}
              {d.notifications.map((n: any, i: number) => (
                <li key={i}><b>{n.title}</b> {n.body} <br /><small className="muted">{fmtDate(n.created_at, true)} · {n.channels.join(', ') || 'no device reached'}</small></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
