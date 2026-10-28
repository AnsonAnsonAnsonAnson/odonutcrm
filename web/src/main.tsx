import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfigProvider } from './config';
import { I18nProvider } from './i18n';
import { Spinner } from './components/ui';
import Join from './pages/customer/Join';
import '@fontsource-variable/inter';
import './styles.css';

// Only the sign-up page is in the first download; everything else loads when it is opened, so the
// member site starts fast on mobile data.
const Member = lazy(() => import('./pages/customer/Member'));
const AddToWallet = lazy(() => import('./pages/customer/AddToWallet'));
const StaffLogin = lazy(() => import('./pages/staff/StaffLogin'));
const StaffScan = lazy(() => import('./pages/staff/StaffScan'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AppleWallet = lazy(() => import('./pages/admin/AppleWallet'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Members = lazy(() => import('./pages/admin/Members').then((m) => ({ default: m.Members })));
const MemberDetail = lazy(() => import('./pages/admin/Members').then((m) => ({ default: m.MemberDetail })));
const Campaigns = lazy(() => import('./pages/admin/Campaigns'));
const Groups = lazy(() => import('./pages/admin/Groups'));
const Rewards = lazy(() => import('./pages/admin/Rewards'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Stores = lazy(() => import('./pages/admin/Stores'));
const Team = lazy(() => import('./pages/admin/Team'));
const Tiers = lazy(() => import('./pages/admin/Tiers'));
const Integrations = lazy(() => import('./pages/admin/Integrations'));
const Poster = lazy(() => import('./pages/admin/Poster'));
const Security = lazy(() => import('./pages/admin/Security'));
const StaffSecurity = lazy(() => import('./pages/admin/Security').then((m) => ({ default: m.StaffSecurityPage })));
const Privacy = lazy(() => import('./pages/customer/Privacy'));

// Returning members are sent straight on to their card: fetch those screens in the background
// once the first page is up, so the hop is instant.
if (!/^\/(admin|staff)/.test(location.pathname)) {
  const prefetch = () => {
    void import('./pages/customer/Member');
    void import('./pages/customer/AddToWallet');
  };
  if ('requestIdleCallback' in window) requestIdleCallback(prefetch, { timeout: 3000 });
  else setTimeout(prefetch, 1500);
}

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
              <Route path="/staff/security" element={<StaffSecurity />} />
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="members" element={<Members />} />
                <Route path="members/:id" element={<MemberDetail />} />
                <Route path="groups" element={<Groups />} />
                <Route path="campaigns" element={<Campaigns />} />
                <Route path="rewards" element={<Rewards />} />
                <Route path="settings" element={<Settings />} />
                <Route path="stores" element={<Stores />} />
                <Route path="team" element={<Team />} />
                <Route path="tiers" element={<Tiers />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="apple-wallet" element={<AppleWallet />} />
                <Route path="poster" element={<Poster />} />
                <Route path="security" element={<Security />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </I18nProvider>
    </ConfigProvider>
  </StrictMode>,
);
