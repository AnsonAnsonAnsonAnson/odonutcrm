import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { ErrorText } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

const blank = { name: '', minStamps: 0, perks: '', upgradeTemplateId: '', color: '#3B1F14' };

export default function Tiers() {
  const me = useAdminMe();
  const owner = me.role === 'owner';
  const [tiers, setTiers] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [program, setProgram] = useState<any>(null);
  const [f, setF] = useState<any>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/tiers').then(setTiers);
  useEffect(() => {
    load();
    api('/api/admin/templates').then((t) => setTemplates(t.filter((x: any) => x.active)));
    api('/api/admin/program').then((r) => setProgram(r.program));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(editing ? `/api/admin/tiers/${editing}` : '/api/admin/tiers', {
        method: editing ? 'PATCH' : 'POST',
        body: { ...f, minStamps: Number(f.minStamps), upgradeTemplateId: f.upgradeTemplateId || null },
      });
      setF(blank);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this tier? Members in it move to the tier below at the next daily review.')) return;
    setError(null);
    try {
      await api(`/api/admin/tiers/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <div>
      <h1>Membership tiers</h1>
      <p className="muted">
        Regulars move up a tier when they collect enough stamps
        {program ? ` in the last ${program.tier_window_days} days` : ''}. The tier shows on their wallet card and Member Center, and
        an optional voucher lands the first time they reach it. Members are reviewed every day, so lapsed members drop back down.
        {program && !program.tiers_enabled && <b> Tiers are switched off in Program & automations.</b>}
      </p>
      <table className="table">
        <thead><tr><th>Tier</th><th>From</th><th>Perks</th><th>Upgrade voucher</th><th>Members</th><th></th></tr></thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.id}>
              <td><span className="tier-pill" style={{ background: t.color }}>{t.name}</span></td>
              <td>{t.min_stamps} stamps</td>
              <td>{t.perks || '–'}</td>
              <td>{t.upgrade_title ?? '–'}</td>
              <td>{t.members}</td>
              <td>
                {owner && (
                  <>
                    <button className="link" onClick={() => { setEditing(t.id); setF({ name: t.name, minStamps: t.min_stamps, perks: t.perks, upgradeTemplateId: t.upgrade_template_id ?? '', color: t.color }); }}>Edit</button>{' '}
                    <button className="link" onClick={() => remove(t.id)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner && (
        <form className="panel form" onSubmit={save}>
          <h3>{editing ? 'Edit tier' : 'Add tier'}</h3>
          <div className="row wrap">
            <label>Name<input required maxLength={30} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label>Stamps needed<input type="number" min={0} required value={f.minStamps} onChange={(e) => setF({ ...f, minStamps: e.target.value })} /></label>
            <label>Colour<input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></label>
            <label>Upgrade voucher
              <select value={f.upgradeTemplateId} onChange={(e) => setF({ ...f, upgradeTemplateId: e.target.value })}>
                <option value="">None</option>
                {templates.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            </label>
          </div>
          <label>Perks (shown to members)<input maxLength={300} value={f.perks} onChange={(e) => setF({ ...f, perks: e.target.value })} placeholder="Free topping every visit" /></label>
          <ErrorText error={error} />
          <div className="row">
            <button className="btn primary">Save tier</button>
            {editing && <button type="button" className="btn" onClick={() => { setEditing(null); setF(blank); }}>Cancel</button>}
          </div>
        </form>
      )}
      {!owner && <ErrorText error={error} />}
    </div>
  );
}
