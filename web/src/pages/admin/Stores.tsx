import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { ErrorText } from '../../components/ui';

const blank = { name: '', address: '', latitude: '', longitude: '', relevantText: '', active: true };

export default function Stores() {
  const [stores, setStores] = useState<any[]>([]);
  const [f, setF] = useState<any>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/api/admin/stores').then(setStores);
  useEffect(() => void load(), []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const num = (v: string) => (v === '' || v === null ? null : Number(v));
    try {
      await api(editing ? `/api/admin/stores/${editing}` : '/api/admin/stores', {
        method: editing ? 'PATCH' : 'POST',
        body: { ...f, address: f.address || null, relevantText: f.relevantText || null, latitude: num(f.latitude), longitude: num(f.longitude) },
      });
      setF(blank);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <div>
      <h1>Stores</h1>
      <p className="muted">Add each shop's coordinates and the wallet card pops up on members' lock screens when they walk nearby (iOS shows it within roughly 100 m).</p>
      <table className="table">
        <thead><tr><th>Store</th><th>Location</th><th>Lock-screen text</th><th></th></tr></thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'dim'}>
              <td><b>{s.name}</b><br /><small className="muted">{s.address}</small></td>
              <td>{s.latitude != null ? `${s.latitude}, ${s.longitude}` : '–'}</td>
              <td>{s.relevant_text ?? '–'}</td>
              <td><button className="link" onClick={() => { setEditing(s.id); setF({ name: s.name, address: s.address ?? '', latitude: s.latitude ?? '', longitude: s.longitude ?? '', relevantText: s.relevant_text ?? '', active: s.active }); }}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="panel form" onSubmit={save}>
        <h3>{editing ? 'Edit store' : 'Add store'}</h3>
        <div className="row wrap">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="grow">Address<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        </div>
        <div className="row wrap">
          <label>Latitude<input value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} placeholder="22.2819" /></label>
          <label>Longitude<input value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} placeholder="114.1582" /></label>
          <label className="grow">Lock-screen text<input maxLength={100} value={f.relevantText} onChange={(e) => setF({ ...f, relevantText: e.target.value })} placeholder="Fresh donuts just out of the fryer! Show your card." /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active</label>
        <ErrorText error={error} />
        <button className="btn primary">Save store</button>
      </form>
    </div>
  );
}
