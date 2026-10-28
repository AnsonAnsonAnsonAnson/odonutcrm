import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type PublicConfig } from './api';

const Ctx = createContext<PublicConfig | null>(null);
const STORE_KEY = 'od_config';

// The last settings this phone saw, so a returning visitor's page draws at once instead of
// waiting for the server; fresh settings replace them a moment later.
function remembered(): PublicConfig | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PublicConfig) : null;
  } catch {
    return null;
  }
}

function apply(c: PublicConfig) {
  document.documentElement.style.setProperty('--brand', c.backgroundColor);
  document.documentElement.style.setProperty('--brand-ink', c.foregroundColor);
  document.title = `${c.brandName} Club`;
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(() => {
    const c = remembered();
    if (c) apply(c);
    return c;
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<PublicConfig>('/api/public/config')
      .then((c) => {
        setCfg(c);
        apply(c);
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(c));
        } catch {}
      })
      .catch(() => setFailed(true));
  }, []);
  if (!cfg && failed) return <div className="center-page"><p>We could not reach the server. Please try again shortly.</p></div>;
  if (!cfg) return <div className="center-page"><span className="spinner" /></div>;
  return <Ctx.Provider value={cfg}>{children}</Ctx.Provider>;
}

export const useConfig = () => useContext(Ctx)!;
