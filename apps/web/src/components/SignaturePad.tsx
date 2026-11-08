import { useEffect, useRef, useState } from 'react';

export type SignatureMethod = 'DRAWN' | 'TYPED' | 'UPLOADED';
export interface SignatureResult {
  image: string; // PNG data URL
  method: SignatureMethod;
}

const W = 600;
const H = 200;
const INK = '#1a1f3a';

/** Signature-style script fonts for typed signatures (bundled in main.tsx). The first is the default. */
export const SIGNATURE_FONTS = [
  { family: 'Great Vibes', label: 'Flowing' },
  { family: 'Mr Dafoe', label: 'Bold' },
  { family: 'Dancing Script', label: 'Simple' },
] as const;
type SignatureFont = (typeof SIGNATURE_FONTS)[number]['family'];
const fontCss = (family: string, px: number) => `400 ${px}px "${family}"`;

/** Crops a canvas to its drawn content plus a margin, so signatures sit nicely in their box. */
function trimmed(c: HTMLCanvasElement): string | null {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 8;
  const out = document.createElement('canvas');
  out.width = Math.min(width, x1 - x0 + 2 * pad);
  out.height = Math.min(height, y1 - y0 + 2 * pad);
  out.getContext('2d')!.drawImage(c, Math.max(0, x0 - pad), Math.max(0, y0 - pad), out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/**
 * Draw (finger, pen or mouse), type (rendered in a handwriting font), or upload an image.
 * Whatever the method, the result is a PNG, which is what the server accepts.
 */
export function SignaturePad({
  kind,
  defaultName,
  onDone,
  onCancel,
  submitLabel,
}: {
  kind: 'SIGNATURE' | 'INITIALS';
  defaultName: string;
  onDone: (r: SignatureResult) => void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [tab, setTab] = useState<SignatureMethod>('DRAWN');
  const [typed, setTyped] = useState(kind === 'INITIALS' ? initials(defaultName) : defaultName);
  const [font, setFont] = useState<SignatureFont>(SIGNATURE_FONTS[0].family);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || tab !== 'DRAWN') return;
    const ctx = c.getContext('2d')!;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.2;
  }, [tab]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = point(e);
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(drawing.current.x, drawing.current.y, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    setHasInk(true);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = point(e);
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(drawing.current.x, drawing.current.y);
    const mid = { x: (drawing.current.x + p.x) / 2, y: (drawing.current.y + p.y) / 2 };
    ctx.quadraticCurveTo(drawing.current.x, drawing.current.y, mid.x, mid.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    drawing.current = p;
  };
  const up = () => (drawing.current = null);

  const clear = () => {
    canvas.current?.getContext('2d')!.clearRect(0, 0, W, H);
    setHasInk(false);
  };

  async function typedPng() {
    await document.fonts.load(fontCss(font, 72), typed);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    // Script fonts have long swashes: leave room on every side, then trim to the ink.
    let size = 92;
    ctx.font = fontCss(font, size);
    while (ctx.measureText(typed.trim()).width > W - 60 && size > 30) ctx.font = fontCss(font, (size -= 4));
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    ctx.fillText(typed.trim(), 30, H / 2);
    return trimmed(c);
  }

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 3_000_000) {
      setError('Choose a PNG or JPG picture under 3 MB.');
      return;
    }
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const scale = Math.min(W / img.width, H / img.height, 1);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    // Make a white paper background transparent so the signature sits on the page, not in a box.
    const px = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i] > 225 && px.data[i + 1] > 225 && px.data[i + 2] > 225) px.data[i + 3] = 0;
    ctx.putImageData(px, 0, 0);
    URL.revokeObjectURL(img.src);
    setUploaded(trimmed(c));
  }

  async function submit() {
    setError(null);
    const image = tab === 'DRAWN' ? (canvas.current ? trimmed(canvas.current) : null) : tab === 'TYPED' ? await typedPng() : uploaded;
    if (!image) {
      setError(tab === 'DRAWN' ? 'Draw your signature in the box first.' : tab === 'TYPED' ? 'Type your name first.' : 'Choose a picture first.');
      return;
    }
    onDone({ image, method: tab });
  }

  const ready = tab === 'DRAWN' ? hasInk : tab === 'TYPED' ? typed.trim().length > 0 : !!uploaded;
  const what = kind === 'INITIALS' ? 'initials' : 'signature';

  return (
    <div className="sigpad">
      <div className="seg" role="tablist" aria-label={`How to make your ${what}`}>
        {(
          [
            ['DRAWN', 'Draw'],
            ['TYPED', 'Type'],
            ['UPLOADED', 'Upload'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} type="button">
            {l}
          </button>
        ))}
      </div>

      {tab === 'DRAWN' && (
        <>
          <canvas
            ref={canvas}
            width={W}
            height={H}
            className="sig-canvas"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            aria-label={`Draw your ${what} here`}
          />
          <p className="small muted">Use your finger, a pen or the mouse.</p>
        </>
      )}
      {tab === 'TYPED' && (
        <>
          <input className="input" value={typed} maxLength={60} onChange={(e) => setTyped(e.target.value)} aria-label={`Your ${what}`} />
          <div className="sig-preview typed" aria-hidden="true" style={{ fontFamily: `"${font}", cursive` }}>
            {typed || ' '}
          </div>
          <div className="sig-styles" role="radiogroup" aria-label="Signature style">
            {SIGNATURE_FONTS.map((f) => (
              <button
                key={f.family}
                type="button"
                role="radio"
                aria-checked={font === f.family}
                aria-label={`${f.label} style`}
                className={font === f.family ? 'on' : ''}
                onClick={() => setFont(f.family)}
                style={{ fontFamily: `"${f.family}", cursive` }}
              >
                {typed.trim() || 'Your name'}
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'UPLOADED' && (
        <>
          <input className="input" type="file" accept="image/png,image/jpeg" onChange={(e) => onFile(e.target.files?.[0])} aria-label={`Picture of your ${what}`} />
          {uploaded && <img className="sig-preview" src={uploaded} alt={`Your uploaded ${what}`} />}
          <p className="small muted">A photo of your signature on white paper works best.</p>
        </>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="row-end">
        {tab === 'DRAWN' && hasInk && (
          <button type="button" className="btn btn-secondary" onClick={clear}>
            Clear
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!ready}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 3);
}
