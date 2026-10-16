import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Spinner } from '../../components/ui';

function pct(a: number, b: number) {
  return b ? `${Math.round((a / b) * 100)}%` : '–';
}

function Bars({ data, field, label }: { data: any[]; field: string; label: string }) {
  const max = Math.max(1, ...data.map((d) => d[field]));
  return (
    <div className="chart">
      <h3>{label}</h3>
      <div className="bars">
        {data.map((d) => (
          <div key={d.day} className="bar" title={`${d.day}: ${d[field]}`}>
            <div style={{ height: `${(d[field] / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="axis"><span>{data[0]?.day.slice(5)}</span><span>{data.at(-1)?.day.slice(5)}</span></div>
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api('/api/admin/dashboard').then(setD);
  }, []);
  if (!d) return <Spinner />;
  const t = d.totals;
  const kpis = [
    ['Members', t.members, `+${t.new_7d} this week`],
    ['Active (30 days)', t.active_30d, pct(t.active_30d, t.members) + ' of members'],
    ['Repeat rate', pct(t.repeat_visitors, t.ever_visited), 'visited 2+ times'],
    ['Stamps (30 days)', t.stamps_30d, `${t.cards_completed_30d} cards completed`],
    ['Vouchers redeemed (30 days)', t.vouchers_redeemed_30d, `${t.vouchers_issued_30d} issued`],
    ['Redemption rate (90 days)', pct(d.redemption.redeemed, d.redemption.issued), `${d.redemption.redeemed}/${d.redemption.issued}`],
    ['Wallet passes', t.apple_passes + t.google_passes, `${t.apple_passes} Apple · ${t.google_passes} Google`],
    ['Opted in to offers', t.opted_in, `${t.web_push} also on web push`],
  ];
  const maxDist = Math.max(1, ...d.distribution.map((x: any) => x.cards));
  return (
    <div>
      <h1>Dashboard</h1>
      <div className="kpis">
        {kpis.map(([label, value, sub]) => (
          <div key={label} className="kpi">
            <small>{label}</small>
            <b>{value}</b>
            <span className="muted">{sub}</span>
          </div>
        ))}
      </div>
      <div className="charts">
        <Bars data={d.daily} field="signups" label="New members per day" />
        <Bars data={d.daily} field="stamps" label="Stamps per day" />
        <Bars data={d.daily} field="redemptions" label="Redemptions per day" />
      </div>
      <div className="two-col">
        <div className="panel">
          <h3>Where members are on the card</h3>
          <p className="muted">Members close to a reward are your best push targets.</p>
          {d.distribution.map((x: any) => (
            <div key={x.stamps} className="hbar">
              <span>{x.stamps} stamps</span>
              <div><div style={{ width: `${(x.cards / maxDist) * 100}%` }} /></div>
              <b>{x.cards}</b>
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>Monthly cohorts</h3>
          <table>
            <thead><tr><th>Joined</th><th>Members</th><th>Came back</th><th>Still visiting after 30 days</th></tr></thead>
            <tbody>
              {d.cohorts.map((c: any) => (
                <tr key={c.cohort}><td>{c.cohort}</td><td>{c.members}</td><td>{pct(c.returned, c.members)}</td><td>{pct(c.retained_30d, c.members)}</td></tr>
              ))}
            </tbody>
          </table>
          <h3>Vouchers by source (90 days)</h3>
          <table>
            <thead><tr><th>Source</th><th>Issued</th><th>Redeemed</th><th>Rate</th></tr></thead>
            <tbody>
              {d.sources.map((s: any) => (
                <tr key={s.source}><td>{s.source.replace('_', ' ')}</td><td>{s.issued}</td><td>{s.redeemed}</td><td>{pct(s.redeemed, s.issued)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
