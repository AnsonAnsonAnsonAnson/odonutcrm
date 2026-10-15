import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

const blank = { title: '', description: '', kind: 'free_item', value: 0, validDays: 30, active: true };

export default function Rewards() {
  const me = useAdminMe();
  const owner = me.role === 'owner';
  const [templates, setTemplates] = useState<any[]>([]);
  const [promos, setPromos] = useState<any[]>([]);
  const [t, setT] = useState<any>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [p, setP] = useState({ code: '', templateId: '', maxUses: '', endsAt: '' });
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api('/api/admin/templates').then(setTemplates);
    api('/api/admin/promos').then(setPromos);
  };
  useEffect(load, []);

  async function saveTemplate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(editing ? `/api/admin/templates/${editing}` : '/api/admin/templates', { method: editing ? 'PATCH' : 'POST', body: { ...t, value: Number(t.value), validDays: Number(t.validDays) } });
      setT(blank);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  async function savePromo(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/admin/promos', {
        body: { code: p.code, templateId: p.templateId, maxUses: p.maxUses ? Number(p.maxUses) : null, endsAt: p.endsAt ? new Date(p.endsAt).toISOString() : null },
      });
      setP({ code: '', templateId: '', maxUses: '', endsAt: '' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <div>
      <h1>Rewards & promo codes</h1>
      <ErrorText error={error} />
      <div className="two-col">
        <div>
          <h2>Voucher types</h2>
          <table className="table">
            <thead><tr><th>Voucher</th><th>Valid</th><th>Issued</th><th>Redeemed</th><th></th></tr></thead>
            <tbody>
              {templates.map((x) => (
                <tr key={x.id} className={x.active ? '' : 'dim'}>
                  <td><b>{x.title}</b><br /><small className="muted">{x.description}</small></td>
                  <td>{x.valid_days} days</td>
                  <td>{x.issued}</td>
                  <td>{x.redeemed}</td>
                  <td>{owner && <button className="link" onClick={() => { setEditing(x.id); setT({ title: x.title, description: x.description, kind: x.kind, value: x.value, validDays: x.valid_days, active: x.active }); }}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {owner && (
            <form className="panel form" onSubmit={saveTemplate}>
              <h3>{editing ? 'Edit voucher type' : 'New voucher type'}</h3>
              <label>Title<input required value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></label>
              <label>Description<input value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} /></label>
              <div className="row">
                <label>Kind<select value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value })}><option value="free_item">Free item</option><option value="cash">Cash off</option><option value="percent">% off</option></select></label>
                <label>Value<input type="number" min={0} value={t.value} onChange={(e) => setT({ ...t, value: e.target.value })} /></label>
                <label>Valid for (days)<input type="number" min={1} value={t.validDays} onChange={(e) => setT({ ...t, validDays: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Active</label>
              <div className="row">
                <button className="btn primary">Save</button>
                {editing && <button type="button" className="link" onClick={() => { setEditing(null); setT(blank); }}>Cancel</button>}
              </div>
            </form>
          )}
        </div>
        <div>
          <h2>Promo codes</h2>
          <p className="muted">Members type these in the Member Center to unlock a voucher. Great for Instagram, Xiaohongshu, KOL and flyer campaigns: give each channel its own code to see which one works.</p>
          <table className="table">
            <thead><tr><th>Code</th><th>Gives</th><th>Used</th><th>Ends</th><th></th></tr></thead>
            <tbody>
              {promos.map((x) => (
                <tr key={x.id} className={x.active ? '' : 'dim'}>
                  <td><b>{x.code}</b></td>
                  <td>{x.template_title}</td>
                  <td>{x.uses}{x.max_uses ? ` / ${x.max_uses}` : ''}</td>
                  <td>{x.ends_at ? fmtDate(x.ends_at) : '–'}</td>
                  <td>{owner && <button className="link" onClick={() => api(`/api/admin/promos/${x.id}`, { method: 'PATCH', body: { active: !x.active } }).then(load)}>{x.active ? 'Disable' : 'Enable'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {owner && (
            <form className="panel form" onSubmit={savePromo}>
              <h3>New promo code</h3>
              <div className="row">
                <label>Code<input required value={p.code} onChange={(e) => setP({ ...p, code: e.target.value.toUpperCase() })} placeholder="IGSUMMER" /></label>
                <label>Voucher<select required value={p.templateId} onChange={(e) => setP({ ...p, templateId: e.target.value })}><option value="">Choose…</option>{templates.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
              </div>
              <div className="row">
                <label>Max uses<input type="number" min={1} value={p.maxUses} onChange={(e) => setP({ ...p, maxUses: e.target.value })} placeholder="Unlimited" /></label>
                <label>Ends<input type="datetime-local" value={p.endsAt} onChange={(e) => setP({ ...p, endsAt: e.target.value })} /></label>
              </div>
              <button className="btn primary">Create code</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
