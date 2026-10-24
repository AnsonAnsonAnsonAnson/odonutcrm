import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from './api';

export interface StaffMe {
  id: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
  storeId: string | null;
  store: { id: string; name: string } | null;
  promo: { multiplier: number; label: string; endsAt: string | null } | null;
  security: { twoStep: boolean; twoStepRequired: boolean };
  program: { stamps_required: number; max_stamps_per_scan: number; spend_per_stamp: number; brand_name: string; background_color: string; foreground_color: string };
}

/** Loads the signed-in staff member or redirects to the staff login. */
export function useStaff(): StaffMe | null {
  const [me, setMe] = useState<StaffMe | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = (wait: number) =>
      api<StaffMe>('/api/staff/me')
        .then((m) => live && setMe(m))
        .catch((e) => {
          if (!live) return;
          if (e instanceof ApiError && e.status === 401) nav(`/staff/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true });
          // A shaky connection at the counter: keep trying quietly instead of spinning forever.
          else timer = setTimeout(() => load(Math.min(wait * 2, 30_000)), wait);
        });
    load(2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return me;
}
