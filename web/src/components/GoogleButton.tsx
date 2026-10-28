import { useEffect, useRef, useState } from 'react';

// Google's own "Continue with Google" button (Google Identity Services). Google hands the page a
// signed ID token, which the server checks before signing the member in.
declare global {
  interface Window {
    google?: any;
  }
}

let loader: Promise<void> | null = null;
function loadGsi() {
  loader ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null;
      reject(new Error('Google sign-in could not load'));
    };
    document.head.appendChild(s);
  });
  return loader;
}

/** Instagram, Facebook, LINE and WeChat open links in their own browser, where Google blocks sign-in. */
export const inAppBrowser = () => /Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|WhatsApp/i.test(navigator.userAgent);

export function GoogleButton({ clientId, locale, onCredential }: { clientId: string; locale: string; onCredential: (token: string) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadGsi()
      .then(() => {
        if (!live || !slot.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r: { credential: string }) => cb.current(r.credential),
          ux_mode: 'popup',
          use_fedcm_for_button: true,
        });
        window.google.accounts.id.renderButton(slot.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: Math.min(slot.current.offsetWidth || 360, 400),
          locale: locale === 'zh-HK' ? 'zh_HK' : 'en',
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [clientId, locale]);

  if (failed) return null;
  return <div className="google-slot" ref={slot} />;
}
