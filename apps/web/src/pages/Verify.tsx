import { DragEvent, useRef, useState } from 'react';
import { ApiError } from '../api';
import { formatDate, PageHead } from '../components/ui';

interface Result {
  match: boolean;
  sha256: string;
  kind?: string;
  sealed?: boolean;
  title?: string;
  referenceNo?: string | null;
  completedAt?: string | null;
  signers?: { fullName: string; completedAt: string | null }[];
}

/**
 * "Check a document". Public: a supplier, bank or court can confirm that a PDF is exactly a copy
 * signed through Ruliba Clays eSign. The file is only fingerprinted; it is not kept.
 */
export function VerifyPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function check(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/verify', { method: 'POST', body: form, headers: { 'x-esign-csrf': '1' }, credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body.message ?? 'The check did not work. Try again.');
      setResult(body as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void check(e.dataTransfer.files[0]);
  };

  return (
    <div className="verify-wrap stack">
      <section className={`drop${over ? ' over' : ''}`} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <p style={{ marginBottom: 12 }}>Drop the signed PDF here, or</p>
        <button className="btn btn-primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Checking…' : 'Choose a PDF'}
        </button>
        <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void check(e.target.files?.[0])} />
        <p className="small muted" style={{ marginTop: 12 }}>
          The file is not uploaded for keeping: only its fingerprint is compared with our records.
        </p>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {result && (
        <section className="panel panel-pad" aria-live="polite">
          {result.match ? (
            <div className="verdict good">
              <span className="mark" aria-hidden="true">✓</span>
              <div>
                <h2>This is a genuine {result.kind} from Ruliba Clays eSign</h2>
                <p>It has not been changed since it was {result.sealed ? 'signed and sealed' : 'signed'}.</p>
                <dl className="facts" style={{ marginTop: 12 }}>
                  <dt>Document</dt>
                  <dd>{result.title}</dd>
                  <dt>Reference</dt>
                  <dd>{result.referenceNo ?? 'None'}</dd>
                  <dt>Completed</dt>
                  <dd>{formatDate(result.completedAt)}</dd>
                  <dt>Signed by</dt>
                  <dd>
                    {result.signers?.map((s) => (
                      <div key={s.fullName}>
                        {s.fullName} <span className="muted small">{formatDate(s.completedAt)}</span>
                      </div>
                    ))}
                  </dd>
                </dl>
              </div>
            </div>
          ) : (
            <div className="verdict bad">
              <span className="mark" aria-hidden="true">!</span>
              <div>
                <h2>No match</h2>
                <p>
                  This file is not a copy signed through Ruliba Clays eSign, or it has been changed since (even re-saving or printing to PDF changes it). Ask the sender for the copy
                  they received by email, or contact sign@ruliba.com.
                </p>
              </div>
            </div>
          )}
          <p className="mono small muted fingerprint" style={{ marginTop: 14, wordBreak: 'break-all' }}>
            Fingerprint (SHA-256): {result.sha256}
          </p>
        </section>
      )}
      <p className="small muted">
        Signed copies also carry Ruliba Clays' digital seal, which PDF readers show in their signature panel. To have Adobe Reader show it as trusted, add the{' '}
        <a href="/api/verify/authority-certificate">Ruliba Clays eSign Authority certificate</a> to its trusted certificates.
      </p>
    </div>
  );
}

export function VerifyPage() {
  return (
    <>
      <PageHead title="Check a document" intro="Upload a signed PDF to confirm it is exactly the copy that was signed, with nothing changed." />
      <VerifyPanel />
    </>
  );
}
