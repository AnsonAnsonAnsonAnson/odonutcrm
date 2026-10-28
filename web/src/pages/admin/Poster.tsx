import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Qr } from '../../components/ui';
import { useAdminMe } from './AdminLayout';

type Format = 'poster' | 'tent' | 'sheet';

/** Printable in-store kit: A4 counter poster, fold-in-half table tent, and a staff cheat sheet. */
export default function Poster() {
  const me = useAdminMe();
  const [format, setFormat] = useState<Format>('poster');
  const [promos, setPromos] = useState<any[]>([]);
  const [program, setProgram] = useState<any>(null);
  const [promo, setPromo] = useState('');
  const [headline, setHeadline] = useState('Join the Donut Club');
  const [sub, setSub] = useState('Scan, add the card to your phone and start collecting stamps. Your first stamp is on us!');
  useEffect(() => {
    api('/api/admin/promos').then((p) => setPromos(p.filter((x: any) => x.active)));
    api('/api/admin/program').then((r) => setProgram(r.program));
  }, []);
  const url = `${location.origin}/${promo ? `?promo=${encodeURIComponent(promo)}` : ''}`;
  const reward = me.program.stamps_required;
  const per = Number(me.program.spend_per_stamp) || 0;
  const earn = per > 0 ? `$${per} = 1 stamp · ` : '';
  const prize = program?.reward_summary ?? 'a free treat';
  const colors = { background: me.program.background_color, color: me.program.foreground_color };

  const panel = (
    <>
      <img src="/icon.svg" alt="" width={90} height={90} />
      <h2>{headline}</h2>
      <p>{sub}</p>
      <div className="poster-qr"><Qr value={url} size={220} /></div>
      <p className="poster-reward">{earn}{reward} stamps = {prize}{promo && ' · plus a welcome gift'}</p>
      <small>{url.replace(/^https?:\/\//, '')}</small>
    </>
  );

  return (
    <div>
      <div className="no-print">
        <h1>Print kit</h1>
        <p className="muted">Everything for the counter. Customers scan the QR to join; pick a promo code to give poster sign-ups a gift and to count how many joined from it.</p>
        <div className="tabs">
          {([['poster', 'A4 counter poster'], ['tent', 'Table tent (fold in half)'], ['sheet', 'Staff cheat sheet']] as const).map(([k, v]) => (
            <button key={k} className={format === k ? 'chip on' : 'chip'} onClick={() => setFormat(k)}>{v}</button>
          ))}
        </div>
        {format !== 'sheet' && (
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
          </div>
        )}
        <button className="btn primary" onClick={() => window.print()}>Print</button>
      </div>

      {format === 'poster' && (
        <section className="poster" style={colors}>
          <img src="/icon.svg" alt="" width={110} height={110} />
          <h2>{headline}</h2>
          <p>{sub}</p>
          <div className="poster-qr"><Qr value={url} size={300} /></div>
          <p className="poster-steps">1 Scan · 2 Sign up · 3 Add to Apple or Google Wallet</p>
          <p className="poster-reward">{earn}{reward} stamps = {prize}{promo && ' · plus a welcome gift today'}</p>
          <small>{url.replace(/^https?:\/\//, '')}</small>
        </section>
      )}

      {format === 'tent' && (
        <section className="tent">
          <div className="tent-panel flip" style={colors}>{panel}</div>
          <div className="tent-fold no-print-line">fold here</div>
          <div className="tent-panel" style={colors}>{panel}</div>
        </section>
      )}

      {format === 'sheet' && (
        <section className="sheet-print">
          <h2>{me.program.brand_name} Club: counter cheat sheet</h2>
          <h3>Every customer</h3>
          <ol>
            <li>Ask: <b>"Are you an {me.program.brand_name} Club member?"</b></li>
            <li><b>Member:</b> scan the QR on their wallet card or phone. No phone? Search their mobile number.</li>
            <li>{per > 0 ? <>Type the bill total; the screen works out the stamps (${per} each, rounded down). Tap <b>Add stamps</b>.</> : <>Set the number of qualifying items, then tap <b>Add stamps</b>.</>} Check the screen shows the new total.</li>
            <li><b>Not a member:</b> point at the poster. "Scan, it takes 30 seconds, and you get a free topping today." Stamp their first purchase once they have joined.</li>
          </ol>
          <h3>Using a reward</h3>
          <ol>
            <li>Scan the voucher QR in their Member Center (or type the code).</li>
            <li>Check the name and expiry on screen, tap <b>Redeem</b>, then hand over the item.</li>
            <li>Never redeem from a screenshot or a code read out loud without scanning or typing it.</li>
          </ol>
          <h3>Rules</h3>
          <ul>
            <li>{per > 0 ? `One stamp for every $${per} on one bill.` : 'One stamp per qualifying item.'} At most {me.program.max_stamps_per_scan} per scan{program?.stamp_cooldown_seconds ? `; the same card cannot be stamped again for ${program.stamp_cooldown_seconds} seconds` : ''}.</li>
            <li>Never stamp without a purchase. Every stamp records who added it and when.</li>
            <li>Mistake? Tell a manager; they fix it in Admin → Members → Adjust stamps with a reason.</li>
            {program?.stamp_multiplier > 1 && <li>While "{program.multiplier_label}" is on, add the real {per > 0 ? 'bill total' : 'number of items'}: the bonus is added automatically.</li>}
          </ul>
          <h3>Common questions</h3>
          <ul>
            <li><b>"Do I need an app?"</b> No. The card lives in Apple Wallet or Google Wallet, or in the browser.</li>
            <li><b>"I lost my card."</b> Sign in again at the join page with the same email; the card and stamps come back.</li>
            <li><b>"Where are my rewards?"</b> Member Center → My Vouchers. They also show on the wallet card.</li>
            <li><b>"Stop the messages."</b> Member Center → avatar → switch off offers. Or delete the account there.</li>
          </ul>
          <p className="muted">Counter screen: {location.origin}/staff</p>
        </section>
      )}
    </div>
  );
}
