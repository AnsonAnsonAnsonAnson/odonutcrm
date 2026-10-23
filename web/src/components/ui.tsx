import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Donut({ filled, size = 48 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className={filled ? 'donut on' : 'donut'}>
      <circle cx="50" cy="50" r="48" fill="#fff" />
      <circle cx="50" cy="50" r="40" fill={filled ? '#E3A869' : '#D9D9D9'} />
      <circle cx="50" cy="50" r="36" fill={filled ? '#F25C8A' : '#C4C4C4'} />
      {filled && (
        <g>
          <rect x="26" y="30" width="9" height="3" rx="1.5" fill="#fff" transform="rotate(20 30 31)" />
          <rect x="62" y="26" width="9" height="3" rx="1.5" fill="#FFD23F" transform="rotate(-30 66 27)" />
          <rect x="70" y="56" width="9" height="3" rx="1.5" fill="#3BCEAC" transform="rotate(60 74 57)" />
          <rect x="40" y="72" width="9" height="3" rx="1.5" fill="#fff" transform="rotate(10 44 73)" />
          <rect x="22" y="58" width="9" height="3" rx="1.5" fill="#FFD23F" transform="rotate(-50 26 59)" />
        </g>
      )}
      <circle cx="50" cy="50" r="12" fill="#fff" />
    </svg>
  );
}

export function StampGrid({ stamps, required }: { stamps: number; required: number }) {
  const cols = required <= 5 ? required : Math.ceil(required / 2);
  return (
    <div className="stamp-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {Array.from({ length: required }, (_, i) => (
        <Donut key={i} filled={i < stamps} />
      ))}
    </div>
  );
}

export function Qr({ value, size = 220 }: { value: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    // The QR library loads only on pages that show a code.
    import('qrcode')
      .then((m) => (m.default ?? m).toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' }))
      .then((url) => live && setSrc(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt="QR code" className="qr" /> : <div style={{ width: size, height: size }} />;
}

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        {title && <h2 className="modal-title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/** Camera QR scanner using jsQR on video frames (works in every modern mobile browser). */
export function Scanner({ onResult, paused }: { onResult: (text: string) => void; paused?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const cb = useRef(onResult);
  cb.current = onResult;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let jsQR: typeof import('jsqr').default;
    (async () => {
      try {
        jsQR = (await import('jsqr')).default;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const loop = () => {
          if (stopped) return;
          const c = canvas.current!;
          if (!pausedRef.current && v.readyState === v.HAVE_ENOUGH_DATA) {
            const w = 480;
            const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            const now = Date.now();
            if (code?.data && (code.data !== last.current.text || now - last.current.at > 4000)) {
              last.current = { text: code.data, at: now };
              navigator.vibrate?.(60);
              cb.current(code.data);
            }
          }
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (e: any) {
        setError(e?.name === 'NotAllowedError' ? 'Camera permission was denied. Enter the code below instead.' : 'Camera is not available. Enter the code below instead.');
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scanner">
      {error ? <p className="scanner-error">{error}</p> : <video ref={video} playsInline muted />}
      <canvas ref={canvas} hidden />
      {!error && <div className="scanner-frame" />}
    </div>
  );
}
