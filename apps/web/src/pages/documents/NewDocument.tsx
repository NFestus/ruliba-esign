import { DATE_LOCALES, SENSITIVITIES, SENSITIVITY_LABELS } from '@ruliba/shared';
import { useQuery } from '@tanstack/react-query';
import { DragEvent, FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiUpload, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { ErrorBox, Field, PageHead, TextField } from '../../components/ui';
import { DocumentDetail } from './types';

interface DocType {
  id: string;
  code: string;
  name: string;
  eSignAllowed: boolean;
  active: boolean;
}

const MB = 1024 * 1024;

export function NewDocumentPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api<DocType[]>('/document-types') });
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [typeId, setTypeId] = useState('');
  const [sensitivity, setSensitivity] = useState<string>('INTERNAL');
  const [locale, setLocale] = useState('en-GB');
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const allowed = types.data?.filter((t) => t.active && t.eSignAllowed) ?? [];
  const blocked = types.data?.filter((t) => t.active && !t.eSignAllowed) ?? [];

  function choose(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!/\.(pdf|docx?)$/i.test(f.name)) return setError(new Error('Choose a PDF or a Word document (.docx or .doc).'));
    if (f.size > 25 * MB) return setError(new Error('The file is larger than 25 MB. Compress it or split it first.'));
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.(pdf|docx?)$/i, '').replace(/[_-]+/g, ' ').trim());
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    choose(e.dataTransfer.files?.[0]);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('title', title);
      form.append('documentTypeId', typeId);
      form.append('sensitivity', sensitivity);
      form.append('locale', locale);
      form.append('file', file);
      const doc = await apiUpload<DocumentDetail>('/documents', form);
      navigate(`/documents/${doc.id}/prepare`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const err = error instanceof ApiError ? error : null;

  return (
    <>
      <PageHead title="New document" intro="PDF or Word. Word documents are turned into PDF first; the original is kept with its fingerprint. Every file is checked and refused if it contains scripts." />
      <form className="panel panel-pad upload-form" onSubmit={submit} noValidate>
        <label
          className={`dropzone${drag ? ' over' : ''}${file ? ' has-file' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <input type="file" accept=".pdf,.doc,.docx,application/pdf" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
          {file ? (
            <>
              <b>{file.name}</b>
              <span className="muted">{(file.size / MB).toFixed(1)} MB. Choose another file to replace it.</span>
            </>
          ) : (
            <>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
              </svg>
              <b>Drop a PDF or Word document here, or choose one</b>
              <span className="muted">Up to 25 MB</span>
            </>
          )}
        </label>
        <ErrorBox error={error} />
        {!user?.departmentId && <div className="alert alert-warn">Your account has no department, so documents cannot get a reference number. Ask the administrator to set it.</div>}
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={err?.fieldError('title')} maxLength={200} />
        <div className="grid-2">
          <Field label="Document type" id="type" error={err?.fieldError('documentTypeId')}>
            <select id="type" className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Choose…</option>
              {allowed.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How sensitive" id="sens">
            <select id="sens" className="input" value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
              {SENSITIVITIES.map((s) => (
                <option key={s} value={s}>
                  {SENSITIVITY_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="How dates are written" id="loc">
          <select id="loc" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
            {Object.entries(DATE_LOCALES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {blocked.length > 0 && <p className="small muted">Not available for e-signature: {blocked.map((b) => b.name.replace(/ \(not for e-signature\)/, '')).join(', ')}. Use the paper process for these.</p>}
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy || !file || !typeId || title.trim().length < 2}>
            {busy ? 'Checking the file…' : 'Continue: add signers'}
          </button>
        </div>
      </form>
    </>
  );
}
