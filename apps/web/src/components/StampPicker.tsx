import { useState } from 'react';

export interface StampOption {
  id: string;
  name: string;
  image: string; // PNG data URL
}

/**
 * Turns a photo or scan of a stamp into a PNG the server accepts: scaled down, and the white paper
 * made transparent so the stamp sits on the page like real ink.
 */
export async function stampFileToPng(file: File, max = 600): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 5_000_000) throw new Error('Choose a PNG or JPG picture under 5 MB.');
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
  } catch {
    throw new Error('That picture could not be opened. Try another.');
  }
  const scale = Math.min(max / img.width, max / img.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  const px = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < px.data.length; i += 4) if (px.data[i] > 215 && px.data[i + 1] > 215 && px.data[i + 2] > 215) px.data[i + 3] = 0;
  ctx.putImageData(px, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * Staff choose one of the Ruliba stamps they are allowed to use. Outside signers upload their own.
 */
export function StampPicker({
  staff,
  stamps,
  onDone,
  onCancel,
}: {
  staff: boolean;
  stamps: StampOption[];
  onDone: (r: { image: string; stampId?: string }) => void;
  onCancel: () => void;
}) {
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (staff)
    return (
      <div>
        {stamps.length ? (
          <>
            <p style={{ marginBottom: 12 }}>Choose the stamp to apply. Only the stamps the administrator allows you are listed.</p>
            <div className="stamp-choices">
              {stamps.map((s) => (
                <button key={s.id} className="stamp-choice" onClick={() => onDone({ image: s.image, stampId: s.id })}>
                  <img src={s.image} alt="" />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="alert alert-warn">No Ruliba stamp is assigned to you, so you cannot fill this box. Ask the administrator (Settings, Stamps), or ask the sender to remove the stamp box.</div>
        )}
        <div className="row-end">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <p style={{ marginBottom: 12 }}>Upload a clear photo or scan of your company stamp. A stamp on white paper works best.</p>
      <label className="btn btn-secondary">
        Choose a picture
        <input
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={async (e) => {
            setError(null);
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              setUploaded(await stampFileToPng(f));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </label>
      {uploaded && (
        <div className="stamp-preview">
          <img src={uploaded} alt="Your stamp" />
        </div>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="row-end">
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!uploaded} onClick={() => uploaded && onDone({ image: uploaded })}>
          Use this stamp
        </button>
      </div>
    </div>
  );
}
