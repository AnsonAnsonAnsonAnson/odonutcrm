import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from './api';

export interface StaffMe {
  id: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
  storeId: string | null;
  store: { id: string; name: string } | null;
  program: { stamps_required: number; max_stamps_per_scan: number; brand_name: string };
}

/** Loads the signed-in staff member or redirects to the staff login. */
export function useStaff(): StaffMe | null {
  const [me, setMe] = useState<StaffMe | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    api<StaffMe>('/api/staff/me')
      .then(setMe)
      .catch((e: ApiError) => {
        if (e.status === 401) nav(`/staff/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true });
      });
  }, []);
  return me;
}
