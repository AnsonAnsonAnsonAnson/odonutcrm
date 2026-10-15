import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Spinner } from '../../components/ui';
import { useStaff, type StaffMe } from '../../staffSession';
import { createContext, useContext } from 'react';

const StaffCtx = createContext<StaffMe | null>(null);
export const useAdminMe = () => useContext(StaffCtx)!;

export default function AdminLayout() {
  const me = useStaff();
  const nav = useNavigate();
  if (!me) return <div className="center-page"><Spinner /></div>;
  if (me.role === 'staff') {
    return (
      <div className="center-page">
        <p>The admin area is for managers and owners.</p>
        <NavLink to="/staff" className="btn">Go to the counter</NavLink>
      </div>
    );
  }
  const owner = me.role === 'owner';
  return (
    <StaffCtx.Provider value={me}>
      <div className="admin">
        <aside className="admin-nav no-print">
          <div className="admin-brand"><img src="/icon.svg" alt="" width={32} height={32} /> {me.program.brand_name}</div>
          <NavLink to="/admin" end>Dashboard</NavLink>
          <NavLink to="/admin/members">Members</NavLink>
          <NavLink to="/admin/campaigns">Campaigns</NavLink>
          <NavLink to="/admin/rewards">Rewards & promos</NavLink>
          <NavLink to="/admin/tiers">Tiers</NavLink>
          <NavLink to="/admin/poster">Counter poster</NavLink>
          <NavLink to="/admin/settings">Program & automations</NavLink>
          {owner && <NavLink to="/admin/stores">Stores</NavLink>}
          {owner && <NavLink to="/admin/team">Team</NavLink>}
          {owner && <NavLink to="/admin/integrations">POS integration</NavLink>}
          <NavLink to="/staff">Counter (stamp)</NavLink>
          <button
            className="link"
            onClick={async () => {
              await api('/api/staff/logout', { body: {} });
              nav('/staff/login');
            }}
          >
            Sign out
          </button>
        </aside>
        <main className="admin-main">
          <Outlet />
        </main>
      </div>
    </StaffCtx.Provider>
  );
}
