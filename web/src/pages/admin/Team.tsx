import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText } from '../../components/ui';

export default function Team() {
  const [staff, setStaff] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [f, setF] = useState({ email: '', name: '', role: 'staff', storeId: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/staff').then(setStaff);
  useEffect(() => {
    load();
    api('/api/admin/stores').then(setStores);
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/admin/staff', { body: { ...f, storeId: f.storeId || null } });
      setF({ email: '', name: '', role: 'staff', storeId: '', password: '' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }
  const patch = (id: string, body: any) => api(`/api/admin/staff/${id}`, { method: 'PATCH', body }).then(load, (e) => setError(e.message));

  return (
    <div>
      <h1>Team</h1>
      <p className="muted">Staff can stamp cards and redeem vouchers. Managers also see members and the dashboard. Owners change settings, send campaigns and manage the team.</p>
      <ErrorText error={error} />
      <table className="table">
        <thead><tr><th>Name</th><th>Role</th><th>Store</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'dim'}>
              <td><b>{s.name}</b><br /><small className="muted">{s.email}</small></td>
              <td>
                <select value={s.role} onChange={(e) => patch(s.id, { role: e.target.value })}>
                  <option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option>
                </select>
              </td>
              <td>
                <select value={s.store_id ?? ''} onChange={(e) => patch(s.id, { storeId: e.target.value || null })}>
                  <option value="">Any</option>
                  {stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
              </td>
              <td>{s.last_login_at ? fmtDate(s.last_login_at, true) : 'never'}</td>
              <td>
                <button className="link" onClick={() => patch(s.id, { active: !s.active })}>{s.active ? 'Disable' : 'Enable'}</button>{' '}
                <button className="link" onClick={() => { const pw = prompt('New password (10+ characters)'); if (pw) patch(s.id, { password: pw }); }}>Reset password</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="panel form" onSubmit={add}>
        <h3>Add a team member</h3>
        <div className="row wrap">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></select></label>
          <label>Store<select value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}><option value="">Any</option>{stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}</select></label>
          <label>Temporary password<input type="text" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        </div>
        <button className="btn primary">Add</button>
      </form>
    </div>
  );
}
