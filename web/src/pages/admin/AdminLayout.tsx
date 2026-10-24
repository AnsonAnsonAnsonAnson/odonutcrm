import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { Spinner } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useStaff, type StaffMe } from '../../staffSession';
import { createContext, useContext, useEffect, useState } from 'react';

const StaffCtx = createContext<StaffMe | null>(null);
export const useAdminMe = () => useContext(StaffCtx)!;

const ROLE = { owner: 'Owner', manager: 'Manager', staff: 'Staff' } as const;

function Item({ to, icon, children, end }: { to: string; icon: string; children: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}>
      <Icon name={icon} /> <span>{children}</span>
    </NavLink>
  );
}

export default function AdminLayout() {
  const me = useStaff();
  const nav = useNavigate();
  const loc = useLocation();
  const [problem, setProblem] = useState<string | null>(null);
  // Any admin request that fails without its own error message lands here, so a page never just
  // spins forever: an expired sign-in goes back to the sign-in page, anything else shows a banner.
  useEffect(() => {
    const onFail = (e: PromiseRejectionEvent) => {
      const err = e.reason;
      if (err instanceof ApiError && err.status === 401) {
        e.preventDefault();
        nav('/staff/login');
      } else if (err instanceof ApiError || err instanceof TypeError) {
        e.preventDefault();
        setProblem(err instanceof ApiError ? err.message : 'Could not reach the server. Check the internet connection and try again.');
      }
    };
    window.addEventListener('unhandledrejection', onFail);
    return () => window.removeEventListener('unhandledrejection', onFail);
  }, [nav]);
  useEffect(() => setProblem(null), [loc.pathname]);
  if (!me) return <div className="center-page"><Spinner /></div>;
  if (me.role === 'staff') {
    return (
      <div className="center-page">
        <p>The admin area is for managers and owners.</p>
        <NavLink to="/staff" className="btn">Go to the counter</NavLink>
      </div>
    );
  }
  // The owner requires two-step sign-in and this account hasn't set it up: only the Security page opens.
  const mustSetUp = me.security.twoStepRequired && !me.security.twoStep;
  if (mustSetUp && loc.pathname !== '/admin/security') return <Navigate to="/admin/security" replace />;
  const owner = me.role === 'owner';
  const initials = me.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <StaffCtx.Provider value={me}>
      <div className="admin">
        <aside className="admin-nav no-print">
          <div className="admin-brand"><img src="/icon.svg" alt="" width={32} height={32} /><span>{me.program.brand_name}<small>Club admin</small></span></div>
          {!mustSetUp && (
            <nav>
              <p className="nav-group">Overview</p>
              <Item to="/admin" icon="dashboard" end>Dashboard</Item>
              <Item to="/admin/members" icon="members">Members</Item>
              <Item to="/admin/groups" icon="layers">Groups</Item>
              <p className="nav-group">Marketing</p>
              <Item to="/admin/campaigns" icon="campaigns">Campaigns</Item>
              <Item to="/admin/rewards" icon="rewards">Rewards & promos</Item>
              <Item to="/admin/tiers" icon="tiers">Tiers</Item>
              <Item to="/admin/poster" icon="print">Print kit</Item>
              <p className="nav-group">Setup</p>
              <Item to="/admin/settings" icon="settings">Program & automations</Item>
              {owner && <Item to="/admin/stores" icon="stores">Stores</Item>}
              {owner && <Item to="/admin/team" icon="team">Team</Item>}
              {owner && <Item to="/admin/apple-wallet" icon="wallet">Apple Wallet</Item>}
              {owner && <Item to="/admin/integrations" icon="plug">POS integration</Item>}
              <Item to="/admin/security" icon="shield">Security</Item>
            </nav>
          )}
          <div className="nav-foot">
            {!mustSetUp && <Item to="/staff" icon="counter">Counter (stamp)</Item>}
            <div className="nav-me">
              <span className="nav-avatar" aria-hidden>{initials}</span>
              <span className="nav-me-text">
                <b>{me.name}</b>
                <small>{ROLE[me.role]}</small>
              </span>
              <button
                className="icon-btn"
                title="Sign out"
                aria-label="Sign out"
                onClick={async () => {
                  await api('/api/staff/logout', { body: {} });
                  nav('/staff/login');
                }}
              >
                <Icon name="logout" />
              </button>
            </div>
          </div>
        </aside>
        <main className="admin-main">
          {!me.security.twoStep && !mustSetUp && loc.pathname !== '/admin/security' && (
            <div className="notice no-print">
              <Icon name="shield" />
              <span>Protect this account: turn on two-step sign-in so a stolen password alone can't get in.</span>
              <NavLink to="/admin/security" className="btn small">Set it up</NavLink>
            </div>
          )}
          {problem && (
            <div className="notice warn no-print" role="alert">
              <Icon name="shield" />
              <span>{problem}</span>
              <button className="btn small" onClick={() => location.reload()}>Reload</button>
              <button className="link" onClick={() => setProblem(null)}>Dismiss</button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </StaffCtx.Provider>
  );
}
