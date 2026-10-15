import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

const SEGMENTS: Record<string, string> = {
  all: 'All members',
  active: 'Visited in the last N days',
  inactive: 'Lapsed: no visit in N days',
  never_visited: 'Joined but never visited',
  new: 'Joined in the last N days',
  near_reward: 'Close to a free reward',
  birthday_month: 'Birthday this month',
  tag: 'Has a tag',
  tier: 'In a membership tier',
};

const IDEAS = [
  { name: 'Rainy day treat', message: 'Rainy day? Double stamps on any hot drink + donut combo today only.', segment: 'active' },
  { name: 'New flavour drop', message: 'Our new Matcha Mochi donut lands tomorrow. Members taste it first!', segment: 'all' },
  { name: 'So close!', message: 'You are 2 stamps away from a free donut. See you soon?', segment: 'near_reward' },
  { name: 'We miss you', message: 'It has been a while! Here is $5 off your next box.', segment: 'inactive' },
];

export default function Campaigns() {
  const me = useAdminMe();
  const [list, setList] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', message: '', templateId: '', type: 'all', days: 30, within: 2, tag: '', tierId: '', optInOnly: true, when: '' });
  const [tiers, setTiers] = useState<any[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/campaigns').then(setList);
  useEffect(() => {
    load();
    api('/api/admin/templates').then((t) => setTemplates(t.filter((x: any) => x.active)));
    api('/api/admin/tiers').then(setTiers).catch(() => {});
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  const segment = { type: f.type, days: f.days, within: f.within, tag: f.tag || undefined, tierId: f.type === 'tier' && f.tierId ? f.tierId : undefined, optInOnly: f.optInOnly };
  useEffect(() => {
    api('/api/admin/campaigns/preview', { body: segment }).then((r) => setCount(r.recipients)).catch(() => setCount(null));
  }, [f.type, f.days, f.within, f.tag, f.tierId, f.optInOnly]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/admin/campaigns', {
        body: {
          name: f.name,
          message: f.message,
          templateId: f.templateId || null,
          segment,
          scheduledAt: f.when ? new Date(f.when).toISOString() : null,
        },
      });
      setF({ ...f, name: '', message: '', when: '' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  const owner = me.role === 'owner';
  return (
    <div>
      <h1>Campaigns</h1>
      <p className="muted">
        A campaign puts a message on the lock screen of every member in the segment (through their wallet pass or web push), and can drop a voucher into their Member Center.
        Wallet messages work best when rare and useful: aim for no more than one or two a week.
      </p>
      {owner && (
        <form className="panel form" onSubmit={create}>
          <div className="row wrap">
            {IDEAS.map((i) => (
              <button type="button" key={i.name} className="chip" onClick={() => setF({ ...f, name: i.name, message: i.message, type: i.segment })}>{i.name}</button>
            ))}
          </div>
          <label>Name (shows as the notification title)<input required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Message ({240 - f.message.length} characters left)<textarea required maxLength={240} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></label>
          <div className="row wrap">
            <label>Audience
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {['active', 'inactive', 'new'].includes(f.type) && <label>Days<input type="number" min={1} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} /></label>}
            {f.type === 'near_reward' && <label>Within N stamps<input type="number" min={1} max={19} value={f.within} onChange={(e) => setF({ ...f, within: Number(e.target.value) })} /></label>}
            {f.type === 'tier' && (
              <label>Tier
                <select required value={f.tierId} onChange={(e) => setF({ ...f, tierId: e.target.value })}>
                  <option value="">Choose…</option>
                  {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            {f.type === 'tag' && <label>Tag<input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></label>}
            <label>Attach voucher
              <select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
                <option value="">None</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <label>Schedule (optional)<input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.optInOnly} onChange={(e) => setF({ ...f, optInOnly: e.target.checked })} />Only members who opted in to marketing (required for promotions)</label>
          <p><b>{count ?? '…'}</b> members will receive this.</p>
          <ErrorText error={error} />
          <button className="btn primary">{f.when ? 'Schedule campaign' : 'Save as draft'}</button>
        </form>
      )}
      <table className="table">
        <thead><tr><th>Campaign</th><th>Audience</th><th>Voucher</th><th>Status</th><th>Recipients</th><th>Redeemed</th><th></th></tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td><b>{c.name}</b><br /><small className="muted">{c.message}</small></td>
              <td>{SEGMENTS[c.segment.type] ?? c.segment.type}</td>
              <td>{c.template_title ?? '–'}</td>
              <td>{c.status}{c.scheduled_at && c.status === 'scheduled' ? ` for ${fmtDate(c.scheduled_at, true)}` : ''}{c.sent_at ? ` ${fmtDate(c.sent_at, true)}` : ''}</td>
              <td>{c.recipients}</td>
              <td>{c.template_title ? c.redeemed : '–'}</td>
              <td>
                {owner && ['draft', 'scheduled'].includes(c.status) && (
                  <>
                    <button className="btn primary" onClick={() => confirm(`Send "${c.name}" now? Members will be notified immediately.`) && api(`/api/admin/campaigns/${c.id}/send`, { body: {} }).then(load)}>Send now</button>{' '}
                    <button className="link" onClick={() => api(`/api/admin/campaigns/${c.id}/cancel`, { body: {} }).then(load)}>Cancel</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
