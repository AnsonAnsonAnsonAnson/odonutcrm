import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfigProvider } from './config';
import { I18nProvider } from './i18n';
import { Spinner } from './components/ui';
import Join from './pages/customer/Join';
import Member from './pages/customer/Member';
import AddToWallet from './pages/customer/AddToWallet';
import './styles.css';

// Staff and admin screens load on demand so the member site stays light on mobile data.
const StaffLogin = lazy(() => import('./pages/staff/StaffLogin'));
const StaffScan = lazy(() => import('./pages/staff/StaffScan'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Members = lazy(() => import('./pages/admin/Members').then((m) => ({ default: m.Members })));
const MemberDetail = lazy(() => import('./pages/admin/Members').then((m) => ({ default: m.MemberDetail })));
const Campaigns = lazy(() => import('./pages/admin/Campaigns'));
const Rewards = lazy(() => import('./pages/admin/Rewards'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Stores = lazy(() => import('./pages/admin/Stores'));
const Team = lazy(() => import('./pages/admin/Team'));
const Tiers = lazy(() => import('./pages/admin/Tiers'));
const Integrations = lazy(() => import('./pages/admin/Integrations'));
const Poster = lazy(() => import('./pages/admin/Poster'));
const Privacy = lazy(() => import('./pages/customer/Privacy'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <I18nProvider>
        <BrowserRouter>
          <Suspense fallback={<div className="center-page"><Spinner /></div>}>
            <Routes>
              <Route path="/" element={<Join />} />
              <Route path="/me" element={<Member />} />
              <Route path="/me/wallet" element={<AddToWallet />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/staff/login" element={<StaffLogin />} />
              <Route path="/staff" element={<StaffScan />} />
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="members" element={<Members />} />
                <Route path="members/:id" element={<MemberDetail />} />
                <Route path="campaigns" element={<Campaigns />} />
                <Route path="rewards" element={<Rewards />} />
                <Route path="settings" element={<Settings />} />
                <Route path="stores" element={<Stores />} />
                <Route path="team" element={<Team />} />
                <Route path="tiers" element={<Tiers />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="poster" element={<Poster />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </I18nProvider>
    </ConfigProvider>
  </StrictMode>,
);
