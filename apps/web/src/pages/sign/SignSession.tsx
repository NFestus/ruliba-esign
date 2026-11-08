import { FIELD_LABELS } from '@ruliba/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, signApi } from '../../api';
import { PdfPages } from '../../components/PdfPages';
import { SignatureMethod, SignaturePad } from '../../components/SignaturePad';
import { StampOption, StampPicker } from '../../components/StampPicker';
import { Dialog, ErrorBox, Field } from '../../components/ui';

interface SignField {
  id: string;
  type: 'SIGNATURE' | 'INITIALS' | 'STAMP' | 'DATE_SIGNED' | 'NAME' | 'TEXT' | 'CHECKBOX' | 'DROPDOWN';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string | null;
  options: string[] | null;
}

interface SessionView {
  document: { title: string; referenceNo: string | null; senderName: string; message: string | null; pageCount: number; sha256: string; dateToday: string };
  recipient: { name: string; email: string; consentAt: string | null; via: 'email-code' | 'account' };
  consent: { version: string; text: string };
  fields: SignField[];
  savedSignatures: ('SIGNATURE' | 'INITIALS')[];
}

type Value = { value?: string; image?: string; method?: SignatureMethod; stampId?: string };
const IMAGE_FIELDS = ['SIGNATURE', 'INITIALS', 'STAMP'];

/**
 * The signer's screen. Works the same for outside signers (after the emailed code) and for staff
 * signing from their dashboard. Built for a phone first: one column, big targets, a bar at the
 * bottom that always says what is left to do.
 */
export function SignSession({ signToken, onFinished }: { signToken: string; onFinished: (r: { documentCompleted: boolean; declined?: boolean }) => void }) {
  const s = useMemo(() => signApi(signToken), [signToken]);
  const [view, setView] = useState<SessionView | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pad, setPad] = useState<SignField | null>(null);
  const [applyAll, setApplyAll] = useState(true);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [stamps, setStamps] = useState<StampOption[]>([]);

  useEffect(() => {
    s.get<SessionView>('').then((v) => {
      setView(v);
      if (v.recipient.via === 'account' && v.fields.some((f) => f.type === 'STAMP')) s.get<StampOption[]>('/stamps').then(setStamps, setError);
    }, setError);
    s.file().then(setPdf, setError);
  }, [s]);

  if (error && !view) return <ErrorBox error={error} />;
  if (!view) return <p className="muted">Opening the document…</p>;

  const needs = (f: SignField) => {
    if (f.type === 'NAME' || f.type === 'DATE_SIGNED' || f.type === 'CHECKBOX') return false;
    if (!f.required) return false;
    const v = values[f.id];
    return IMAGE_FIELDS.includes(f.type) ? !v?.image : !v?.value?.trim();
  };
  const todo = view.fields.filter(needs);
  const required = view.fields.filter((f) => f.required && !['NAME', 'DATE_SIGNED', 'CHECKBOX'].includes(f.type));
  const consented = !!view.recipient.consentAt;

  async function consent() {
    setBusy(true);
    setError(null);
    try {
      const r = await s.post<{ consentAt: string }>('/consent', { version: view!.consent.version });
      setView({ ...view!, recipient: { ...view!.recipient, consentAt: r.consentAt } });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function setSig(f: SignField, image: string, method: SignatureMethod) {
    const same = applyAll ? view!.fields.filter((x) => x.type === f.type) : [f];
    setValues((v) => ({ ...v, ...Object.fromEntries(same.map((x) => [x.id, { image, method }])) }));
    setPad(null);
  }

  function setStamp(f: SignField, image: string, stampId?: string) {
    const same = applyAll ? view!.fields.filter((x) => x.type === 'STAMP') : [f];
    setValues((v) => ({ ...v, ...Object.fromEntries(same.map((x) => [x.id, { image, stampId }])) }));
    setPad(null);
  }

  async function applySaved(f: SignField) {
    try {
      const r = await s.get<{ image: string; method: SignatureMethod }>(`/saved-signature?kind=${f.type}`);
      setSig(f, r.image, r.method);
    } catch (e) {
      setError(e);
    }
  }

  function next() {
    const f = todo[0];
    if (!f) return;
    document.querySelector(`[data-field="${f.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (IMAGE_FIELDS.includes(f.type)) setPad(f);
    else (document.querySelector(`[data-field="${f.id}"] input, [data-field="${f.id}"] select`) as HTMLElement | null)?.focus();
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const r = await s.post<{ documentCompleted: boolean }>('/complete', {
        values: view!.fields
          .filter((f) => !['NAME', 'DATE_SIGNED'].includes(f.type))
          .map((f) => ({ fieldId: f.id, value: f.type === 'CHECKBOX' ? String(values[f.id]?.value === 'true') : (values[f.id]?.value ?? null), image: f.type === 'STAMP' && values[f.id]?.stampId ? null : (values[f.id]?.image ?? null), method: values[f.id]?.method ?? null, stampId: values[f.id]?.stampId ?? null })),
      });
      onFinished(r);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await s.post('/decline', { reason });
      onFinished({ documentCompleted: false, declined: true });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const fieldLabel = (f: SignField) => f.label || FIELD_LABELS[f.type];

  return (
    <div className="sign-session">
      <header className="sign-head">
        <h1>{view.document.title}</h1>
        <p className="muted">
          From {view.document.senderName}, Ruliba Clays{view.document.referenceNo ? `. Reference ${view.document.referenceNo}` : ''}.
        </p>
        {view.document.message && <blockquote className="sender-note">{view.document.message}</blockquote>}
      </header>

      {!consented ? (
        <section className="panel panel-pad consent">
          <h2>Before you sign</h2>
          <p style={{ margin: '10px 0 14px' }}>{view.consent.text}</p>
          <label className="consent-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to sign electronically</span>
          </label>
          <ErrorBox error={error} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <button className="btn-link" onClick={() => setDeclining(true)}>
              Decline to sign
            </button>
            <button className="btn btn-primary" disabled={!agree || busy} onClick={consent}>
              Continue to the document
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            You can read the whole document before you agree.{' '}
            <button className="btn-link small" onClick={() => document.querySelector('.pdf-pages')?.scrollIntoView({ behavior: 'smooth' })}>
              Show it
            </button>
          </p>
        </section>
      ) : (
        <p className="small muted sign-intro">
          Tap each highlighted box to fill it in. {required.length > 0 && `${required.length - todo.length} of ${required.length} done.`}
        </p>
      )}

      <div className="sign-pages">
        <PdfPages
          data={pdf}
          maxWidth={900}
          overlay={(page, size) =>
            view.fields
              .filter((f) => f.page === page)
              .map((f) => {
                const v = values[f.id];
                // Same rule as the signed copy (pdf/stamp.ts): 72% of the box height, at most 14 pt.
                const fontSize = Math.max(7, Math.min((f.height * size.height) / size.scale * 0.72, 14) * size.scale);
                const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%`, fontSize };
                const cls = `sign-field${needs(f) ? ' todo' : ' filled'}${!consented ? ' locked' : ''}`;
                if (f.type === 'STAMP')
                  return (
                    <button key={f.id} data-field={f.id} className={`${cls} stamp`} style={style} disabled={!consented} onClick={() => setPad(f)} aria-label={`${fieldLabel(f)}${v?.image ? ' (done, tap to change)' : ''}`}>
                      {v?.image ? <img src={v.image} alt="" /> : <span>Stamp here</span>}
                    </button>
                  );
                if (f.type === 'SIGNATURE' || f.type === 'INITIALS')
                  return (
                    <button key={f.id} data-field={f.id} className={cls} style={style} disabled={!consented} onClick={() => setPad(f)} aria-label={`${fieldLabel(f)}${v?.image ? ' (done, tap to change)' : ''}`}>
                      {v?.image ? <img src={v.image} alt="" /> : <span>{f.type === 'INITIALS' ? 'Initials' : 'Sign here'}</span>}
                    </button>
                  );
                if (f.type === 'NAME' || f.type === 'DATE_SIGNED')
                  return (
                    <div key={f.id} data-field={f.id} className="sign-field auto" style={style} title="Filled in automatically">
                      <span>{f.type === 'NAME' ? view.recipient.name : view.document.dateToday}</span>
                    </div>
                  );
                if (f.type === 'CHECKBOX')
                  return (
                    <label key={f.id} data-field={f.id} className={`${cls} check`} style={style} title={fieldLabel(f)}>
                      <input type="checkbox" disabled={!consented} checked={v?.value === 'true'} onChange={(e) => setValues((x) => ({ ...x, [f.id]: { value: String(e.target.checked) } }))} aria-label={fieldLabel(f)} />
                    </label>
                  );
                if (f.type === 'DROPDOWN')
                  return (
                    <div key={f.id} data-field={f.id} className={cls} style={style}>
                      <select disabled={!consented} value={v?.value ?? ''} onChange={(e) => setValues((x) => ({ ...x, [f.id]: { value: e.target.value } }))} aria-label={fieldLabel(f)}>
                        <option value="">{fieldLabel(f)}…</option>
                        {(f.options ?? []).map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </div>
                  );
                return (
                  <div key={f.id} data-field={f.id} className={cls} style={style}>
                    <input disabled={!consented} placeholder={fieldLabel(f)} value={v?.value ?? ''} maxLength={500} onChange={(e) => setValues((x) => ({ ...x, [f.id]: { value: e.target.value } }))} aria-label={fieldLabel(f)} />
                  </div>
                );
              })
          }
        />
      </div>

      {consented && (
        <div className="sign-bar">
          <div className="sign-bar-inner">
            <span className="small">{todo.length ? `${todo.length} left to fill in` : 'Everything is filled in.'}</span>
            <button className="btn-link small" onClick={() => setDeclining(true)}>
              Decline
            </button>
            {todo.length ? (
              <button className="btn btn-secondary" onClick={next}>
                Next field
              </button>
            ) : (
              <button className="btn btn-primary" onClick={finish} disabled={busy}>
                {busy ? 'Signing…' : 'Finish signing'}
              </button>
            )}
          </div>
          {error instanceof ApiError && <div className="alert alert-error sign-bar-error" role="alert">{error.message}</div>}
        </div>
      )}

      {pad?.type === 'STAMP' && (
        <Dialog title={view.recipient.via === 'account' ? 'Apply a Ruliba stamp' : 'Your company stamp'} onClose={() => setPad(null)}>
          <StampPicker staff={view.recipient.via === 'account'} stamps={stamps} onCancel={() => setPad(null)} onDone={(r) => setStamp(pad, r.image, r.stampId)} />
          {view.fields.filter((f) => f.type === 'STAMP').length > 1 && (
            <label className="checks" style={{ marginTop: 10 }}>
              <span>
                <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} /> Use it for all {view.fields.filter((f) => f.type === 'STAMP').length} stamp boxes
              </span>
            </label>
          )}
        </Dialog>
      )}

      {pad && pad.type !== 'STAMP' && (
        <Dialog title={pad.type === 'INITIALS' ? 'Your initials' : 'Your signature'} onClose={() => setPad(null)}>
          {view.savedSignatures.includes(pad.type as 'SIGNATURE' | 'INITIALS') && (
            <button className="btn btn-secondary btn-block" style={{ marginBottom: 14 }} onClick={() => applySaved(pad)}>
              Use my saved {pad.type === 'INITIALS' ? 'initials' : 'signature'}
            </button>
          )}
          <SignaturePad kind={pad.type as 'SIGNATURE' | 'INITIALS'} defaultName={view.recipient.name} submitLabel="Use this" onCancel={() => setPad(null)} onDone={(r) => setSig(pad, r.image, r.method)} />
          {view.fields.filter((f) => f.type === pad.type).length > 1 && (
            <label className="checks" style={{ marginTop: 10 }}>
              <span>
                <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} /> Use it for all {view.fields.filter((f) => f.type === pad.type).length} {pad.type === 'INITIALS' ? 'initials' : 'signature'} boxes
              </span>
            </label>
          )}
        </Dialog>
      )}

      {declining && (
        <Dialog title="Decline to sign?" onClose={() => setDeclining(false)}>
          <p style={{ marginBottom: 12 }}>Signing stops for everyone and the sender is told your reason. You cannot undo this.</p>
          <Field label="Why are you declining?" id="reason" hint="For example: the price on page 2 is wrong.">
            <textarea id="reason" className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row-end">
            <button className="btn btn-secondary" onClick={() => setDeclining(false)}>
              Go back
            </button>
            <button className="btn btn-danger" disabled={reason.trim().length < 3 || busy} onClick={decline}>
              Decline to sign
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
