import { useEffect, useRef, useState, type ReactNode } from 'react';

// Hand-drawn line-art donut in the style of the O! Donut illustration: cream dough and icing with
// lines in the card's text colour (currentColor). Same drawing as the Wallet pass strip.
const disc = (r: number) => `M50 ${50 - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}z`;
const hole = (r: number) => `M50 ${50 - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}z`;
const icing = `M${Array.from({ length: 85 }, (_, i) => {
  const t = (i / 84) * Math.PI * 2;
  const r = 32 + 2.4 * Math.sin(7 * t + 0.6);
  return `${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`;
}).join('L')}z`;
const sprinkles = [[34, 33, 30], [60, 30, -40], [70, 52, 75], [58, 71, 15], [36, 66, -60], [27, 48, 95]];

export function Donut({ filled, size = 48 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className={filled ? 'donut on' : 'donut'}>
      {filled ? (
        <g stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" fillRule="evenodd">
          <path d={disc(42) + hole(12.5)} fill="#F4D49E" strokeWidth="2.8" />
          <path d={icing + hole(12.5)} fill="#FFF4DC" strokeWidth="2.4" />
          <g strokeWidth="2.4">
            {sprinkles.map(([x, y, a]) => (
              <line key={`${x}${y}`} x1={x - 3} y1={y} x2={x + 3} y2={y} transform={`rotate(${a} ${x} ${y})`} />
            ))}
          </g>
        </g>
      ) : (
        <g className="ring" fill="none" stroke="currentColor" strokeOpacity="0.42" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="0.1 6.2">
          <circle cx="50" cy="50" r="41" />
          <circle cx="50" cy="50" r="12.5" />
        </g>
      )}
    </svg>
  );
}

/** The O! Donut wordmark from the brand illustration, drawn in the current text colour. Falls back
 *  to plain text if the shop renames itself in Settings. */
export function Wordmark({ name, height = 22 }: { name: string; height?: number }) {
  if (name.replace(/\s+/g, '').toLowerCase() !== 'o!donut') return <span className="wordmark-text">{name}</span>;
  return <span className="wordmark" role="img" aria-label={name} style={{ height, width: Math.round(height * 6.5) }} />;
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
