import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Qr } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

/** A printable A4 counter sign with the join QR code, optionally carrying a promo code. */
export default function Poster() {
  const me = useAdminMe();
  const [promos, setPromos] = useState<any[]>([]);
  const [promo, setPromo] = useState('');
  const [headline, setHeadline] = useState('Join the Donut Club');
  const [sub, setSub] = useState('Scan, add the card to your phone and collect a stamp with every donut.');
  useEffect(() => {
    api('/api/admin/promos').then((p) => setPromos(p.filter((x: any) => x.active)));
  }, []);
  const url = `${location.origin}/${promo ? `?promo=${encodeURIComponent(promo)}` : ''}`;
  const reward = me.program.stamps_required;

  return (
    <div>
      <div className="no-print">
        <h1>Counter poster</h1>
        <p className="muted">Print this and put it by the till. Customers scan it to join. Attach a promo code to give new members a sign-up gift.</p>
        <div className="panel form">
          <div className="row wrap">
            <label className="grow">Headline<input value={headline} onChange={(e) => setHeadline(e.target.value)} /></label>
            <label>Promo code
              <select value={promo} onChange={(e) => setPromo(e.target.value)}>
                <option value="">None</option>
                {promos.map((p) => <option key={p.id} value={p.code}>{p.code}</option>)}
              </select>
            </label>
          </div>
          <label>Line under the headline<input value={sub} onChange={(e) => setSub(e.target.value)} /></label>
          <button className="btn primary" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      <section className="poster" style={{ background: me.program.background_color, color: me.program.foreground_color }}>
        <img src="/icon.svg" alt="" width={110} height={110} />
        <h2>{headline}</h2>
        <p>{sub}</p>
        <div className="poster-qr"><Qr value={url} size={300} /></div>
        <p className="poster-steps">1 Scan · 2 Sign up · 3 Add to Apple or Google Wallet</p>
        <p className="poster-reward">{reward} stamps = a free treat{promo && ' · plus a welcome gift today'}</p>
        <small>{url.replace(/^https?:\/\//, '')}</small>
      </section>
    </div>
  );
}
