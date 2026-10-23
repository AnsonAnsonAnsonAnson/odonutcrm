import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../../api';
import { ErrorText, Modal } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fable', 'garnet', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'maple', 'nectar', 'orbit', 'pepper', 'quartz', 'river', 'saffron', 'tundra', 'velvet', 'willow', 'zephyr', 'cobalt', 'meadow', 'pebble', 'tiger', 'violet', 'window', 'copper'];

/** A temporary password that's easy to read out: three random words and a number. */
function suggestPassword() {
  const r = new Uint32Array(4);
  crypto.getRandomValues(r);
  return `${WORDS[r[0] % WORDS.length]}-${WORDS[r[1] % WORDS.length]}-${WORDS[r[2] % WORDS.length]}-${(r[3] % 90) + 10}`;
}

const ROLE_HELP = 'Staff can stamp cards and redeem vouchers. Managers also see members and the dashboard. Owners change settings, send campaigns and manage the team.';

export default function Team() {
  const me = useAdminMe();
  const [staff, setStaff] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [f, setF] = useState({ email: '', name: '', role: 'staff', storeId: '', password: suggestPassword() });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<any | null>(null);
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
      setNotice(`Added ${f.name}. Give them their email and the temporary password "${f.password}"; they change it in Security after signing in.`);
      setF({ email: '', name: '', role: 'staff', storeId: '', password: suggestPassword() });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }
  const patch = (id: string, body: any, done?: string) =>
    api(`/api/admin/staff/${id}`, { method: 'PATCH', body }).then(
      () => {
        setError(null);
        if (done) setNotice(done);
        return load();
      },
      (e) => setError(e.message),
    );

  return (
    <div>
      <h1>Team</h1>
      <p className="muted">{ROLE_HELP}</p>
      <ErrorText error={error} />
      {notice && <p className="notice ok" role="status">{notice}</p>}
      <div className="table table-scroll">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Store</th><th>Security</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'dim'}>
                <td><b>{s.name}</b>{s.id === me.id && <span className="muted"> (you)</span>}<br /><small className="muted">{s.email}</small></td>
                <td>
                  <select value={s.role} disabled={s.id === me.id} onChange={(e) => patch(s.id, { role: e.target.value })} aria-label={`Role for ${s.name}`}>
                    <option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option>
                  </select>
                </td>
                <td>
                  <select value={s.store_id ?? ''} onChange={(e) => patch(s.id, { storeId: e.target.value || null })} aria-label={`Store for ${s.name}`}>
                    <option value="">Any</option>
                    {stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                  </select>
                </td>
                <td>
                  <div className="pills">
                    {!s.active && <span className="pill">Disabled</span>}
                    {s.locked && <span className="pill bad">Locked</span>}
                    <span className={`pill ${s.two_step ? 'ok' : s.role === 'staff' ? '' : 'warn'}`}>{s.two_step ? 'Two-step on' : 'Two-step off'}</span>
                  </div>
                </td>
                <td className="nowrap">{s.last_login_at ? fmtDate(s.last_login_at, true) : <span className="muted">never</span>}</td>
                <td>
                  <div className="actions">
                    {s.locked && <button className="btn small" onClick={() => patch(s.id, { unlock: true }, `${s.name} can sign in again.`)}>Unlock</button>}
                    {s.id !== me.id && (
                      <>
                        <button className="btn small" onClick={() => setResetFor(s)}>Reset password</button>
                        {s.two_step && (
                          <button
                            className="btn small"
                            onClick={() => confirm(`Turn off two-step sign-in for ${s.name}? Do this if they lost their phone; they can set it up again after signing in.`) && patch(s.id, { resetTwoStep: true }, `Two-step sign-in reset for ${s.name}.`)}
                          >
                            Reset two-step
                          </button>
                        )}
                        <button className="btn small" onClick={() => patch(s.id, { signOut: true }, `${s.name} was signed out of every device.`)}>Sign out</button>
                        <button className={`btn small ${s.active ? 'danger-link' : ''}`} onClick={() => patch(s.id, { active: !s.active })}>{s.active ? 'Disable' : 'Enable'}</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="panel form" onSubmit={add}>
        <h3>Add a team member</h3>
        <div className="grid-form">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></select></label>
          <label>Store<select value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}><option value="">Any</option>{stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}</select></label>
          <label className="wide">
            Temporary password
            <span className="input-with-btn">
              <input type="text" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
              <button type="button" className="btn small" onClick={() => setF({ ...f, password: suggestPassword() })}>New</button>
            </span>
          </label>
        </div>
        <button className="btn primary">Add team member</button>
      </form>

      <ResetPassword person={resetFor} onClose={() => setResetFor(null)} onDone={(pw) => {
        setNotice(`New temporary password for ${resetFor.name}: "${pw}". They were signed out everywhere and should change it after signing in.`);
        setResetFor(null);
        load();
      }} />
    </div>
  );
}

function ResetPassword({ person, onClose, onDone }: { person: any | null; onClose: () => void; onDone: (pw: string) => void }) {
  const [pw, setPw] = useState(suggestPassword());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPw(suggestPassword());
    setError(null);
  }, [person?.id]);
  return (
    <Modal open={!!person} onClose={onClose} title={person ? `Reset ${person.name}'s password` : ''}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          api(`/api/admin/staff/${person.id}`, { method: 'PATCH', body: { password: pw } }).then(() => onDone(pw), (err) => setError(err.message));
        }}
      >
        <p className="muted">They'll be signed out of every device and can sign in with this password straight away.</p>
        <label>
          New temporary password
          <span className="input-with-btn">
            <input type="text" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} />
            <button type="button" className="btn small" onClick={() => setPw(suggestPassword())}>New</button>
          </span>
        </label>
        <ErrorText error={error} />
        <button className="btn primary">Reset password</button>
      </form>
    </Modal>
  );
}
