import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtMoney } from '../../api';
import { Spinner } from '../../components/ui';
import { Icon } from '../../components/icons';
import type { Group } from './Groups';
import { VOUCHER_SOURCE } from './labels';

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

function pct(a: number, b: number) {
  return b ? `${Math.round((a / b) * 100)}%` : '–';
}

/** Change against the previous 30 days, e.g. "+12% vs last month". */
function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (!before || now == null) return <span className="muted">No earlier data yet</span>;
  const change = Math.round(((now - before) / before) * 100);
  const cls = change > 0 ? 'up' : change < 0 ? 'down' : '';
  return <span className={`delta ${cls}`}>{change > 0 ? '+' : ''}{change}% <span className="muted">vs previous 30 days</span></span>;
}

function Bars({ data, field, label, money }: { data: any[]; field: string; label: string; money?: boolean }) {
  const max = Math.max(1, ...data.map((d) => d[field]));
  const total = data.reduce((n, d) => n + d[field], 0);
  const fmt = (n: number) => (money ? fmtMoney(Math.round(n)) : n);
  return (
    <div className="chart">
      <div className="row between">
        <h3>{label}</h3>
        <span className="chart-total">{fmt(total)} <small>in 30 days</small></span>
      </div>
      <div className="chart-bars">
        {total === 0 && <p className="chart-empty">Nothing yet. This fills in as members join and visit.</p>}
        {data.map((d) => (
          <div key={d.day} className="chart-bar" title={`${d.day}: ${fmt(d[field])}`}>
            <div style={{ height: `${(d[field] / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="axis"><span>{data[0]?.day.slice(5)}</span><span>{data.at(-1)?.day.slice(5)}</span></div>
    </div>
  );
}

// Groups worth checking every week, in the order the research suggests acting on them.
const WATCH = ['joined_no_visit', 'one_visit', 'near_reward', 'reward_waiting', 'at_risk', 'lapsed'];

export default function Dashboard() {
  const [d, setD] = useState<any>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    api('/api/admin/dashboard').then(setD);
    api('/api/admin/groups').then(setGroups).catch(() => {});
  }, []);
  if (!d) return <Spinner />;
  const t = d.totals;
  const sp = d.spend;
  const freq = [
    ['Not yet', t.freq_0],
    ['1 visit', t.freq_1],
    ['2 visits', t.freq_2],
    ['3–5 visits', t.freq_3_5],
    ['6+ visits', t.freq_6],
  ] as const;
  const maxFreq = Math.max(1, ...freq.map(([, n]) => n));
  const maxDist = Math.max(1, ...d.distribution.map((x: any) => x.cards));
  const watch = WATCH.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as Group[];
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>The last 30 days. The numbers that matter most are whether people come back, not just how many join.</p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><small>Members</small><b>{t.members}</b><span>+{t.new_7d} this week · +{t.new_30d} this month</span></div>
        <div className="kpi"><small>Active members</small><b>{t.active_30d}</b><span>{pct(t.active_30d, t.members)} visited in 30 days</span></div>
        <div className="kpi"><small>Repeat rate</small><b>{pct(t.repeat_visitors, t.ever_visited)}</b><span>of buyers came back at least once</span></div>
        <div className="kpi"><small>Visits</small><b>{sp.visits_30d}</b><Delta now={sp.visits_30d} before={sp.visits_prev_30d} /></div>
        <div className="kpi"><small>Money tracked</small><b>{fmtMoney(Math.round(sp.spend_30d))}</b><Delta now={sp.spend_30d} before={sp.spend_prev_30d} /></div>
        <div className="kpi"><small>Average bill</small><b>{sp.avg_bill_30d != null ? fmtMoney(Math.round(sp.avg_bill_30d)) : '–'}</b><Delta now={sp.avg_bill_30d} before={sp.avg_bill_prev_30d} /></div>
        <div className="kpi"><small>Rewards used</small><b>{t.vouchers_redeemed_30d}</b><span>{pct(d.redemption.redeemed, d.redemption.issued)} of vouchers used (90 days)</span></div>
        <div className="kpi"><small>Cards on phones</small><b>{t.apple_passes + t.google_passes}</b><span>{t.apple_passes} Apple · {t.google_passes} Google · {t.opted_in} get offers</span></div>
      </div>

      <div className="charts">
        <Bars data={d.daily} field="visits" label="Visits per day" />
        <Bars data={d.daily} field="spend" label="Money tracked per day" money />
        <Bars data={d.daily} field="signups" label="New members per day" />
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="row between">
            <h3>Groups to act on</h3>
            <Link to="/admin/groups" className="link">All groups</Link>
          </div>
          <p className="muted">These are the customers whose habits a message can still change.</p>
          <ul className="watch">
            {watch.map((g) => (
              <li key={g.id}>
                <span className="group-icon sm"><Icon name={g.icon} size={16} /></span>
                <Link to={`/admin/members?group=${g.id}`}><b>{g.name}</b><small className="muted">{g.description}</small></Link>
                <span className="watch-n">{g.members}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3>How often members come</h3>
          <p className="muted">Moving people from 1 visit to 2 is where a loyalty card earns its keep.</p>
          {freq.map(([label, n]) => (
            <div key={label} className="hbar">
              <span>{label}</span>
              <div><div style={{ width: `${(n / maxFreq) * 100}%` }} /></div>
              <b>{n}</b>
            </div>
          ))}
          <h3>Where members are on the card</h3>
          {d.distribution.length === 0 && <p className="empty">No cards yet.</p>}
          {d.distribution.map((x: any) => (
            <div key={x.stamps} className="hbar">
              <span>{x.stamps} stamps</span>
              <div><div style={{ width: `${(x.cards / maxDist) * 100}%` }} /></div>
              <b>{x.cards}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="two-col">
        <div className="panel">
          <h3>Retention by month joined</h3>
          <p className="muted">Of the people who joined each month, how many came back.</p>
          <table>
            <thead><tr><th>Joined</th><th className="num">Members</th><th className="num">Came back</th><th className="num">Still visiting after 30 days</th></tr></thead>
            <tbody>
              {d.cohorts.length === 0 && <tr><td colSpan={4} className="empty">No members yet.</td></tr>}
              {d.cohorts.map((c: any) => (
                <tr key={c.cohort}><td className="nowrap">{monthName(c.cohort)}</td><td className="num">{c.members}</td><td className="num">{pct(c.returned, c.members)}</td><td className="num">{pct(c.retained_30d, c.members)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Vouchers by type (90 days)</h3>
          <p className="muted">A voucher only works if people use it.</p>
          <table>
            <thead><tr><th>Type</th><th className="num">Given</th><th className="num">Used</th><th className="num">Rate</th></tr></thead>
            <tbody>
              {d.sources.length === 0 && <tr><td colSpan={4} className="empty">No vouchers given in the last 90 days.</td></tr>}
              {d.sources.map((s: any) => (
                <tr key={s.source}><td>{VOUCHER_SOURCE[s.source] ?? s.source}</td><td className="num">{s.issued}</td><td className="num">{s.redeemed}</td><td className="num">{pct(s.redeemed, s.issued)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
