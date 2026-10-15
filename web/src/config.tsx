import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type PublicConfig } from './api';

const Ctx = createContext<PublicConfig | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<PublicConfig>('/api/public/config')
      .then((c) => {
        setCfg(c);
        document.documentElement.style.setProperty('--brand', c.backgroundColor);
        document.documentElement.style.setProperty('--brand-ink', c.foregroundColor);
        document.title = `${c.brandName} Club`;
      })
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <div className="center-page"><p>We could not reach the server. Please try again shortly.</p></div>;
  if (!cfg) return <div className="center-page"><span className="spinner" /></div>;
  return <Ctx.Provider value={cfg}>{children}</Ctx.Provider>;
}

export const useConfig = () => useContext(Ctx)!;
