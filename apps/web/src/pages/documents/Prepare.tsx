import { FIELD_DEFAULT_SIZE, FIELD_LABELS } from '@ruliba/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiBytes } from '../../api';
import { PdfPages, PageSize } from '../../components/PdfPages';
import { IconSearch } from '../../components/icons';
import { Dialog, ErrorBox, Field as FormField, TextField } from '../../components/ui';
import { SIGNER_COLOURS } from '../../labels';
import { DocumentDetail, Field, pageCountOf } from './types';

type Step = 'signers' | 'fields' | 'send';
type Mode = 'SEQUENTIAL' | 'PARALLEL' | 'MIXED';

interface Draft {
  key: string;
  id?: string;
  role: 'SIGNER' | 'CC';
  fullName: string;
  email: string;
  stepOrder: number;
  /** Ruliba staff account (signs from the dashboard or the link) rather than someone outside Ruliba. */
  internal?: boolean;
  /** Staff account still waiting for activation: they activate first, then sign. */
  pending?: boolean;
}

const newKey = () => crypto.randomUUID();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PreparePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const docQ = useQuery({ queryKey: ['document', id], queryFn: () => api<DocumentDetail>(`/documents/${id}`) });
  const pdfQ = useQuery({ queryKey: ['document-pdf', id], queryFn: () => apiBytes(`/documents/${id}/files/prepared`), staleTime: Infinity });
  const [step, setStep] = useState<Step>('signers');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('SEQUENTIAL');
  const [people, setPeople] = useState<Draft[]>([]);
  const [fields, setFields] = useState<(Field & { key: string })[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(30);
  const [reminder, setReminder] = useState<number | null>(3);
  const [counterparty, setCounterparty] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const loaded = useRef(false);
  const settingsQ = useQuery({ queryKey: ['approval-settings'], queryFn: () => api<{ currency: string | null }>('/settings/approval'), retry: false });

  const doc = docQ.data;
  useEffect(() => {
    if (!doc || loaded.current) return;
    loaded.current = true;
    if (doc.status !== 'DRAFT') {
      navigate(`/documents/${doc.id}`, { replace: true });
      return;
    }
    setMode(doc.routingMode);
    setPeople(doc.recipients.filter((r) => r.role !== 'APPROVER').map((r) => ({ key: r.id, id: r.id, role: r.role as 'SIGNER' | 'CC', fullName: r.fullName, email: r.email, stepOrder: r.stepOrder, internal: !r.isExternal })));
    setFields(doc.fields.map((f) => ({ ...f, key: f.id ?? newKey() })));
    setSubject(doc.emailSubject ?? '');
    setMessage(doc.emailMessage ?? '');
    setCounterparty(doc.counterparty ?? '');
    setValue(doc.contractValue === null ? '' : String(Number(doc.contractValue)));
    setCurrency(doc.currency ?? '');
    if (doc.recipients.length && doc.fields.length) setStep('fields');
  }, [doc, navigate]);

  const signers = people.filter((p) => p.role === 'SIGNER');
  const colourOf = (recipientId: string) => SIGNER_COLOURS[Math.max(0, signers.findIndex((s) => s.id === recipientId)) % SIGNER_COLOURS.length];

  /** Saves the signer list. The server returns real ids for new people; fields are re-pointed at them. */
  const saveSigners = useCallback(async () => {
    const res = await api<DocumentDetail>(`/documents/${id}/recipients`, {
      method: 'PUT',
      body: { routingMode: mode, recipients: people.map((p) => ({ id: p.id, role: p.role, fullName: p.fullName.trim(), email: p.email.trim(), stepOrder: p.stepOrder })) },
    });
    const byEmail = new Map(res.recipients.map((r) => [r.email, r]));
    const next = people.map((p) => ({ ...p, id: byEmail.get(p.email.trim().toLowerCase())?.id }));
    setPeople(next);
    const valid = new Set(res.recipients.filter((r) => r.role === 'SIGNER').map((r) => r.id));
    setFields((fs) => fs.filter((f) => valid.has(f.recipientId)));
    qc.setQueryData(['document', id], res);
    return res;
  }, [id, mode, people, qc]);

  const saveFields = useCallback(async () => {
    const res = await api<DocumentDetail>(`/documents/${id}/fields`, {
      method: 'PUT',
      body: { fields: fields.map(({ key: _k, id: _i, ...f }) => ({ ...f, label: f.label || null, options: f.type === 'DROPDOWN' ? f.options : null })) },
    });
    qc.setQueryData(['document', id], res);
    return res;
  }, [fields, id, qc]);

  const numericValue = value.trim() === '' ? null : Number(value.replace(/[\s,]/g, ''));
  const valueProblem = numericValue !== null && (!Number.isFinite(numericValue) || numericValue < 0) ? 'Enter the amount in figures, e.g. 25000000.' : null;
  const saveDetails = useCallback(async () => {
    if (valueProblem) throw new Error(valueProblem);
    await api(`/documents/${id}`, {
      method: 'PATCH',
      body: {
        emailSubject: subject.trim() || null,
        emailMessage: message.trim() || null,
        counterparty: counterparty.trim() || null,
        contractValue: numericValue,
        currency: numericValue === null ? null : (currency.trim() || settingsQ.data?.currency || 'RWF').toUpperCase(),
      },
    });
    void qc.invalidateQueries({ queryKey: ['approval-preview', id] });
  }, [id, subject, message, counterparty, numericValue, currency, settingsQ.data, valueProblem, qc]);
  const needsApproval = !!doc?.documentType.requiresApproval;
  const previewQ = useQuery({
    queryKey: ['approval-preview', id],
    enabled: step === 'send' && needsApproval,
    queryFn: () => api<{ required: boolean; problem: string | null; policyName?: string; steps: { label: string; approverName: string }[] }>(`/documents/${id}/approval-preview`),
  });

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      await fn();
      if (okMsg) setSaved(okMsg);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const signersProblem = useMemo(() => {
    if (!signers.length) return 'Add at least one signer.';
    for (const p of people) {
      if (p.fullName.trim().length < 2) return 'Enter a full name for everyone.';
      if (!EMAIL.test(p.email.trim())) return `Check the email for ${p.fullName || 'each person'}.`;
    }
    const emails = signers.map((s) => s.email.trim().toLowerCase());
    if (new Set(emails).size !== emails.length) return 'The same email appears twice. Each signer needs their own email.';
    return null;
  }, [people, signers]);

  const missingSignature = signers.filter((s) => !fields.some((f) => f.recipientId === s.id && (f.type === 'SIGNATURE' || f.type === 'INITIALS')));

  async function goTo(next: Step) {
    if (next === step) return;
    if (step === 'signers' && !(await run(saveSigners))) return;
    if (step === 'fields' && !(await run(saveFields))) return;
    if (step === 'send' && !(await run(saveDetails))) return;
    setStep(next);
  }

  async function saveDraft() {
    await run(async () => {
      if (step === 'signers') await saveSigners();
      if (step === 'fields') await saveFields();
      if (step === 'send') await saveDetails();
    }, 'Draft saved.');
  }

  async function send() {
    const ok = await run(async () => {
      await saveDetails();
      await api(`/documents/${id}/send`, { body: { emailSubject: subject.trim() || null, emailMessage: message.trim() || null, expiresInDays: days, reminderEveryDays: reminder } });
    });
    if (ok) {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/documents/${id}?sent=1`, { replace: true });
    }
  }

  if (docQ.error) return <ErrorBox error={docQ.error} />;
  if (!doc) return <p className="muted">Opening the document…</p>;

  const steps: { key: Step; label: string }[] = [
    { key: 'signers', label: 'Signers' },
    { key: 'fields', label: 'Fields' },
    { key: 'send', label: 'Send' },
  ];
  const idx = steps.findIndex((s) => s.key === step);

  return (
    <div className="prepare">
      <header className="prepare-bar panel">
        <Link to="/documents" className="icon-btn" aria-label="Back to documents">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <div className="prepare-title">
          <b>{doc.title}</b>
          <span className="muted small">
            {pageCountOf(doc)} {pageCountOf(doc) === 1 ? 'page' : 'pages'}, draft
          </span>
        </div>
        <ol className="stepper" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.key} className={i < idx ? 'done' : i === idx ? 'current' : ''}>
              <button type="button" onClick={() => goTo(s.key)} disabled={saving || (s.key !== 'signers' && !!signersProblem)} aria-current={i === idx ? 'step' : undefined}>
                <span className="step-dot">{i < idx ? '✓' : i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="row">
          <button className="btn btn-secondary" onClick={saveDraft} disabled={saving}>
            Save draft
          </button>
          {step !== 'send' ? (
            <button className="btn btn-primary" onClick={() => goTo(steps[idx + 1].key)} disabled={saving || !!signersProblem}>
              Next: {steps[idx + 1].label}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={saving || !!signersProblem || missingSignature.length > 0 || !!valueProblem}>
              {saving ? 'Sending…' : needsApproval ? 'Send for approval' : 'Send for signing'}
            </button>
          )}
        </div>
      </header>
      <ErrorBox error={error} />
      {saved && <div className="alert alert-ok" role="status">{saved}</div>}

      {step === 'signers' && (
        <SignersStep mode={mode} setMode={setMode} people={people} setPeople={setPeople} problem={signersProblem} colours={(i) => SIGNER_COLOURS[i % SIGNER_COLOURS.length]} />
      )}
      {step === 'fields' && <FieldsStep pdf={pdfQ.data ?? null} pageCount={pageCountOf(doc)} signers={signers} fields={fields} setFields={setFields} colourOf={colourOf} />}
      {step === 'send' && (
        <div className="grid-2 send-step">
          <section className="panel panel-pad">
            <h2>Check before sending</h2>
            <ul className="checklist">
              {signers.map((s) => {
                const n = fields.filter((f) => f.recipientId === s.id).length;
                const ok = !missingSignature.includes(s);
                return (
                  <li key={s.key} className={ok ? 'ok' : 'bad'}>
                    <span className="chip" style={{ background: colourOf(s.id!) }} aria-hidden="true" />
                    <span>
                      <b>{s.fullName}</b> <span className="muted">{s.email}</span>
                      <br />
                      <span className="small">
                        {mode === 'PARALLEL' ? 'Signs at the same time as the others' : `Step ${s.stepOrder}`}, {n} {n === 1 ? 'field' : 'fields'}
                        {!ok && <b className="danger"> — needs a signature field</b>}
                      </span>
                    </span>
                  </li>
                );
              })}
              {people
                .filter((p) => p.role === 'CC')
                .map((p) => (
                  <li key={p.key}>
                    <span className="chip chip-cc" aria-hidden="true" />
                    <span>
                      <b>{p.fullName}</b> <span className="muted">{p.email}</span>
                      <br />
                      <span className="small">Gets the signed copy</span>
                    </span>
                  </li>
                ))}
            </ul>
            {missingSignature.length > 0 && (
              <button className="btn btn-secondary" onClick={() => goTo('fields')}>
                Back to fields
              </button>
            )}
            <p className="small muted" style={{ marginTop: 14 }}>
              {needsApproval
                ? 'The reference number is given when the last approver approves. Once sent, the document cannot be edited; an approver can return it to you for changes.'
                : 'Sending gives this document its reference number. After that it cannot be edited: to change something, cancel it and send a new one.'}
            </p>
            <button className="btn-link small" style={{ marginTop: 6 }} onClick={() => setTemplateOpen(true)} disabled={!!signersProblem || missingSignature.length > 0}>
              Save as a template for next time
            </button>
          </section>
          <section className="panel panel-pad">
            <h2>Contract details</h2>
            <div style={{ marginTop: 14 }}>
              <TextField label="Supplier or partner" placeholder="e.g. Kigali Builders Ltd" value={counterparty} maxLength={200} onChange={(e) => setCounterparty(e.target.value)} onBlur={() => void run(saveDetails)} />
              <FormField label="Contract value" id="value" hint={needsApproval ? 'Decides who needs to approve.' : 'Optional.'} error={valueProblem ?? undefined}>
                <div className="input-row">
                  <input id="value" className="input" inputMode="decimal" placeholder="0" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => void run(saveDetails)} aria-invalid={valueProblem ? true : undefined} />
                  <input aria-label="Currency" className="input" maxLength={3} placeholder={settingsQ.data?.currency ?? 'RWF'} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} onBlur={() => void run(saveDetails)} />
                </div>
              </FormField>
            </div>
            {needsApproval && (
              <div style={{ marginTop: 6 }}>
                <h3>Approval before signing</h3>
                {previewQ.data?.problem ? (
                  <div className="alert alert-warn" style={{ marginTop: 8 }}>{previewQ.data.problem}</div>
                ) : previewQ.data ? (
                  <>
                    <p className="small muted">{doc.documentType.name} documents are approved in this order before the signers are emailed:</p>
                    <ol className="approval-steps">
                      {previewQ.data.steps.map((st, i) => (
                        <li key={i}>
                          <span className="n">{i + 1}</span>
                          <span>
                            <b>{st.approverName}</b> <span className="muted small">{st.label}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="small muted">Checking who approves…</p>
                )}
              </div>
            )}
          </section>
          <section className="panel panel-pad">
            <h2>Email to signers</h2>
            <div style={{ marginTop: 14 }}>
              <TextField label="Subject" placeholder={`Please sign: ${doc.title}`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
              <FormField label="Message" id="msg" hint="Optional. Shown in the invitation email.">
                <textarea id="msg" className="input" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add a short note for your signers" />
              </FormField>
              <FormField label="Signing links stop working after" id="days">
                <select id="days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[7, 14, 30, 60, 90].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Remind people who have not signed" id="remind">
                <select id="remind" className="input" value={reminder ?? 0} onChange={(e) => setReminder(Number(e.target.value) || null)}>
                  <option value={0}>No reminders</option>
                  {[1, 2, 3, 5, 7].map((d) => (
                    <option key={d} value={d}>
                      Every {d} {d === 1 ? 'day' : 'days'}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          </section>
        </div>
      )}
      {templateOpen && <SaveTemplateDialog documentId={id!} title={doc.title} people={signers} onClose={() => setTemplateOpen(false)} onSaved={(n) => { setTemplateOpen(false); setSaved(`Saved as the template “${n}”. Find it under Templates.`); }} />}
    </div>
  );
}

function SaveTemplateDialog({ documentId, title, people, onClose, onSaved }: { documentId: string; title: string; people: Draft[]; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(title);
  const [shared, setShared] = useState(false);
  const [roles, setRoles] = useState<Record<string, string>>(() => Object.fromEntries(people.map((p, i) => [p.id!, p.email.endsWith('@ruliba.com') ? p.fullName : i === people.length - 1 ? 'Supplier' : ''])));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/templates', { body: { documentId, name: name.trim(), shared, roles: people.map((p) => ({ recipientId: p.id, roleName: (roles[p.id!] ?? '').trim() })) } });
      onSaved(name.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Save as a template" onClose={onClose}>
      <p style={{ marginBottom: 12 }}>The file, fields and signing order are kept. Name each signer by their role, so next time you only fill in who it is.</p>
      <ErrorBox error={error} />
      <TextField label="Template name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
      {people.map((p) => (
        <TextField key={p.key} label={`Role of ${p.fullName}`} placeholder="e.g. Supplier, Finance Director" value={roles[p.id!] ?? ''} maxLength={80} onChange={(e) => setRoles((r) => ({ ...r, [p.id!]: e.target.value }))} />
      ))}
      <label className="checks" style={{ margin: '4px 0 16px' }}>
        <span>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with every department (otherwise only yours)
        </span>
      </label>
      <div className="row-end">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || name.trim().length < 2 || people.some((p) => (roles[p.id!] ?? '').trim().length < 2)} onClick={save}>
          Save template
        </button>
      </div>
    </Dialog>
  );
}

// ───────────────────────── Step 1: signers ─────────────────────────

interface Suggestion {
  fullName: string;
  email: string;
  note: string;
}

function useContactSuggestions(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['contact-suggest', term],
    enabled: term.length >= 2,
    queryFn: async (): Promise<Suggestion[]> => {
      const contacts = await api<{ fullName: string; email: string; company: string | null }[]>(`/contacts?q=${encodeURIComponent(term)}`);
      return contacts.map((c) => ({ fullName: c.fullName, email: c.email, note: c.company ?? 'Sent to before' })).slice(0, 8);
    },
  });
}

interface StaffSigner {
  id: string;
  fullName: string;
  email: string;
  jobTitle: string | null;
  department: { name: string } | null;
  pending: boolean;
}

/** Internal: pick Ruliba staff with the Signer role, or add a colleague who has no account yet. */
function InternalPicker({ taken, onAdd }: { taken: Set<string>; onAdd: (p: { fullName: string; email: string; pending: boolean }) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const staff = useQuery({
    queryKey: ['staff-signers', q.trim()],
    queryFn: () => api<StaffSigner[]>(`/users/directory?signers=1&q=${encodeURIComponent(q.trim())}`),
  });

  async function createColleague(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ fullName: string; email: string; pending: boolean; existing: boolean }>('/users/signers', { body: { fullName: name.trim(), email: email.trim() } });
      onAdd({ fullName: r.fullName, email: r.email, pending: r.pending });
      setNotice(
        r.existing
          ? `${r.fullName} already has an eSign account and was added.`
          : `${r.fullName} was added. We emailed them a link to activate their account; they can sign once it is active.`,
      );
      setName('');
      setEmail('');
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['staff-signers'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="internal-picker">
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}
      <label className="search">
        <span className="sr-only">Search Ruliba staff</span>
        <IconSearch />
        <input className="input" type="search" placeholder="Search Ruliba staff by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ul className="staff-list" aria-label="Ruliba staff who can sign">
        {staff.data?.map((u) => {
          const already = taken.has(u.email);
          return (
            <li key={u.id}>
              <div>
                <b>{u.fullName}</b> {u.pending && <span className="badge badge-off">Waiting for activation</span>}
                <div className="small muted">
                  {u.email}
                  {(u.jobTitle ?? u.department?.name) ? ` · ${u.jobTitle ?? u.department?.name}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={already} onClick={() => onAdd({ fullName: u.fullName, email: u.email, pending: u.pending })}>
                {already ? 'Added' : 'Add'}
              </button>
            </li>
          );
        })}
        {staff.data?.length === 0 && <li className="muted small">No staff with the Signer role match “{q}”.</li>}
      </ul>
      {adding ? (
        <form className="add-person add-colleague" onSubmit={createColleague} noValidate>
          <ErrorBox error={error} />
          <TextField label="Full name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
          <TextField label="Work email" type="email" placeholder="name@ruliba.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <div className="row-end" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || name.trim().length < 2 || !EMAIL.test(email.trim())}>
              {busy ? 'Adding…' : 'Add colleague'}
            </button>
          </div>
          <p className="small muted" style={{ gridColumn: '1 / -1' }}>
            They get an eSign account with the Signer role and an email to activate it. They can sign once their account is active.
          </p>
        </form>
      ) : (
        <button type="button" className="btn-link" onClick={() => (setAdding(true), setNotice(null))}>
          Not in the list? Add a new colleague
        </button>
      )}
    </div>
  );
}

function SignersStep({
  mode,
  setMode,
  people,
  setPeople,
  problem,
  colours,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  people: Draft[];
  setPeople: (p: Draft[]) => void;
  problem: string | null;
  colours: (i: number) => string;
}) {
  const [kind, setKind] = useState<'INTERNAL' | 'EXTERNAL'>('INTERNAL');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);
  const suggest = useContactSuggestions(name.length >= email.length ? name : email);
  const taken = new Set(people.map((p) => p.email.trim().toLowerCase()));

  const renumber = (list: Draft[]) => {
    let n = 0;
    return list.map((p) => (mode === 'SEQUENTIAL' ? { ...p, stepOrder: p.role === 'CC' ? 1 : ++n } : mode === 'PARALLEL' ? { ...p, stepOrder: 1 } : p));
  };
  const update = (list: Draft[]) => setPeople(renumber(list));

  function addPerson(p: { fullName: string; email: string; internal: boolean; pending?: boolean }) {
    const mail = p.email.trim().toLowerCase();
    if (taken.has(mail)) return;
    const maxStep = Math.max(0, ...people.map((x) => x.stepOrder));
    update([...people, { key: newKey(), role: 'SIGNER', fullName: p.fullName.trim(), email: mail, stepOrder: mode === 'MIXED' ? maxStep + 1 : 1, internal: p.internal, pending: p.pending }]);
  }

  function add(s?: Suggestion) {
    const fullName = (s?.fullName ?? name).trim();
    const mail = (s?.email ?? email).trim().toLowerCase();
    if (fullName.length < 2 || !EMAIL.test(mail)) return;
    addPerson({ fullName, email: mail, internal: false });
    setName('');
    setEmail('');
    setOpen(false);
  }

  const move = (i: number, d: -1 | 1) => {
    const next = [...people];
    const [p] = next.splice(i, 1);
    next.splice(i + d, 0, p);
    update(next);
  };

  useEffect(() => {
    setPeople(renumber(people));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const signerIndex = (p: Draft) => people.filter((x) => x.role === 'SIGNER').indexOf(p);
  const summary =
    mode === 'PARALLEL'
      ? 'Everyone gets the invitation at once and can sign in any order.'
      : mode === 'SEQUENTIAL'
        ? `Invitations go out in this order: ${people.filter((p) => p.role === 'SIGNER').map((p) => p.fullName.split(' ')[0]).join(', then ') || '…'}. Each person is emailed when the one before them has signed.`
        : 'People with the same step number sign at the same time; the next step starts when they have all signed.';

  return (
    <div className="signers-step">
      <section className="panel panel-pad">
        <h2>Who needs to sign?</h2>
        <p className="muted">Add Ruliba staff or people outside Ruliba, and choose whether they sign one after another or all at once.</p>
        <div className="mode-cards" role="radiogroup" aria-label="Signing order">
          {(
            [
              ['SEQUENTIAL', 'One after another', 'Each signer is invited only when the previous one finishes.'],
              ['PARALLEL', 'All at once', 'Everyone gets the invite right away, in any order.'],
              ['MIXED', 'In groups', 'Give people step numbers; the same number signs together.'],
            ] as const
          ).map(([k, t, d]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} className={`mode-card${mode === k ? ' on' : ''}`} onClick={() => setMode(k)}>
              <b>{t}</b>
              <span>{d}</span>
            </button>
          ))}
        </div>

        <ol className="people">
          {people.map((p, i) => (
            <li key={p.key} className="person">
              <span className="person-step" style={{ background: p.role === 'SIGNER' ? colours(signerIndex(p)) : 'var(--line)' }}>
                {p.role === 'CC' ? 'cc' : mode === 'PARALLEL' ? '•' : p.stepOrder}
              </span>
              <div className="person-main">
                <input className="input input-plain" aria-label={`Name of signer ${i + 1}`} value={p.fullName} onChange={(e) => update(people.map((x) => (x.key === p.key ? { ...x, fullName: e.target.value } : x)))} />
                <input
                  className="input input-plain muted"
                  aria-label={`Email of ${p.fullName || `signer ${i + 1}`}`}
                  type="email"
                  value={p.email}
                  readOnly={p.internal}
                  onChange={(e) => update(people.map((x) => (x.key === p.key ? { ...x, email: e.target.value } : x)))}
                />
                <span className="person-kind small">
                  <span className={`badge ${p.internal ? 'badge-ok' : 'badge-off'}`}>{p.internal ? 'Ruliba staff' : 'Outside Ruliba'}</span>
                  {p.pending && <span className="badge badge-off">Activates first</span>}
                </span>
              </div>
              <select className="input input-sm" aria-label={`What ${p.fullName} does`} value={p.role} onChange={(e) => update(people.map((x) => (x.key === p.key ? { ...x, role: e.target.value as Draft['role'] } : x)))}>
                <option value="SIGNER">Signs</option>
                <option value="CC">Gets a copy</option>
              </select>
              {mode === 'MIXED' && p.role === 'SIGNER' && (
                <input
                  className="input input-sm step-input"
                  type="number"
                  min={1}
                  max={20}
                  aria-label={`Step for ${p.fullName}`}
                  value={p.stepOrder}
                  onChange={(e) => update(people.map((x) => (x.key === p.key ? { ...x, stepOrder: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } : x)))}
                />
              )}
              <div className="person-actions">
                <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${p.fullName} up`}>
                  ↑
                </button>
                <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === people.length - 1} aria-label={`Move ${p.fullName} down`}>
                  ↓
                </button>
                <button type="button" className="icon-btn" onClick={() => update(people.filter((x) => x.key !== p.key))} aria-label={`Remove ${p.fullName}`}>
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>

        <div className="seg" role="tablist" aria-label="Who is signing" style={{ marginTop: 8 }}>
          {(
            [
              ['INTERNAL', 'Internal (Ruliba staff)'],
              ['EXTERNAL', 'External (outside Ruliba)'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>

        {kind === 'INTERNAL' ? (
          <InternalPicker taken={taken} onAdd={(p) => addPerson({ ...p, internal: true })} />
        ) : (
          <form
            className="add-person"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <div className="suggest-wrap">
              <TextField label="Full name" placeholder="Full name" value={name} onChange={(e) => (setName(e.target.value), setOpen(true))} autoComplete="off" />
              {open && suggest.data && suggest.data.length > 0 && (
                <ul className="suggest" role="listbox">
                  {suggest.data.map((s) => (
                    <li key={s.email}>
                      <button type="button" onClick={() => add(s)}>
                        <b>{s.fullName}</b> <span className="muted">{s.email}</span>
                        <span className="small muted suggest-note">{s.note}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <TextField label="Email" type="email" placeholder="name@company.com" value={email} onChange={(e) => (setEmail(e.target.value), setOpen(true))} autoComplete="off" />
            <button className="btn btn-secondary add-btn" disabled={name.trim().length < 2 || !EMAIL.test(email.trim()) || taken.has(email.trim().toLowerCase())}>
              Add signer
            </button>
          </form>
        )}
        {problem && people.length > 0 && <p className="small danger">{problem}</p>}
      </section>
      <aside className="panel panel-pad summary-card">
        <h2>Summary</h2>
        <p>{summary}</p>
        <p className="small muted" style={{ marginTop: 12 }}>
          Ruliba staff sign from their dashboard or the emailed link. A colleague added without an account must activate it first; the invitation includes the activation link. People outside Ruliba get a link and a one-time code by email; they need no account.
        </p>
      </aside>
    </div>
  );
}

// ───────────────────────── Step 2: fields ─────────────────────────

const PALETTE: Field['type'][] = ['SIGNATURE', 'INITIALS', 'STAMP', 'DATE_SIGNED', 'NAME', 'TEXT', 'CHECKBOX', 'DROPDOWN'];

function FieldsStep({
  pdf,
  pageCount,
  signers,
  fields,
  setFields,
  colourOf,
}: {
  pdf: ArrayBuffer | null;
  pageCount: number;
  signers: Draft[];
  fields: (Field & { key: string })[];
  setFields: (f: (Field & { key: string })[] | ((prev: (Field & { key: string })[]) => (Field & { key: string })[])) => void;
  colourOf: (recipientId: string) => string;
}) {
  const [assignTo, setAssignTo] = useState(signers[0]?.id ?? '');
  const [placing, setPlacing] = useState<Field['type'] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{ key: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: Field; size: PageSize } | null>(null);
  const sel = fields.find((f) => f.key === selected) ?? null;
  const signerName = (id: string) => signers.find((s) => s.id === id)?.fullName ?? 'Unknown';

  const patch = (key: string, p: Partial<Field>) => setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));
  const remove = (key: string) => {
    setFields((fs) => fs.filter((f) => f.key !== key));
    setSelected(null);
  };

  function place(page: number, size: PageSize, e: ReactPointerEvent<HTMLDivElement>) {
    if (!placing || !assignTo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const [w, h] = FIELD_DEFAULT_SIZE[placing];
    // A4-based default size, scaled to this page's shape
    const width = Math.min(w, 1);
    const height = Math.min((h * (size.width / size.height)) / (595 / 842), 1);
    const x = clamp((e.clientX - r.left) / size.width - width / 2, 0, 1 - width);
    const y = clamp((e.clientY - r.top) / size.height - height / 2, 0, 1 - height);
    const f: Field & { key: string } = {
      key: newKey(),
      recipientId: assignTo,
      type: placing,
      page,
      x,
      y,
      width,
      height,
      required: placing !== 'CHECKBOX',
      label: null,
      options: placing === 'DROPDOWN' ? ['Yes', 'No'] : null,
    };
    setFields((fs) => [...fs, f]);
    setSelected(f.key);
    setPlacing(null);
  }

  function startDrag(e: ReactPointerEvent, f: Field & { key: string }, mode: 'move' | 'resize', size: PageSize) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(f.key);
    drag.current = { key: f.key, mode, startX: e.clientX, startY: e.clientY, orig: f, size };
  }
  function onDrag(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.size.width;
    const dy = (e.clientY - d.startY) / d.size.height;
    if (d.mode === 'move') patch(d.key, { x: clamp(d.orig.x + dx, 0, 1 - d.orig.width), y: clamp(d.orig.y + dy, 0, 1 - d.orig.height) });
    else patch(d.key, { width: clamp(d.orig.width + dx, 0.02, 1 - d.orig.x), height: clamp(d.orig.height + dy, 0.012, 1 - d.orig.y) });
  }
  const endDrag = () => (drag.current = null);

  function onKey(e: ReactKeyboardEvent, f: Field & { key: string }) {
    const step = e.shiftKey ? 0.02 : 0.004;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      patch(f.key, { x: clamp(f.x + moves[e.key][0], 0, 1 - f.width), y: clamp(f.y + moves[e.key][1], 0, 1 - f.height) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(f.key);
    }
  }

  const counts = (id: string) => fields.filter((f) => f.recipientId === id).length;

  return (
    <div className="fields-step">
      <div className={`pages-col${placing ? ' placing' : ''}`}>
        {placing && (
          <div className="placing-hint" role="status">
            Click on the page where the {FIELD_LABELS[placing].toLowerCase()} for {signerName(assignTo)} goes.{' '}
            <button className="btn-link" onClick={() => setPlacing(null)}>
              Cancel
            </button>
          </div>
        )}
        <PdfPages
          data={pdf}
          overlay={(page, size) => (
            <div className="overlay-hit" onPointerDown={(e) => (placing ? place(page, size, e) : setSelected(null))}>
              {fields
                .filter((f) => f.page === page)
                .map((f) => (
                  <div
                    key={f.key}
                    className={`field-box${selected === f.key ? ' selected' : ''}`}
                    style={{
                      left: `${f.x * 100}%`,
                      top: `${f.y * 100}%`,
                      width: `${f.width * 100}%`,
                      height: `${f.height * 100}%`,
                      ['--c' as string]: colourOf(f.recipientId),
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${FIELD_LABELS[f.type]} for ${signerName(f.recipientId)}, page ${page}. Arrow keys move it, Delete removes it.`}
                    onPointerDown={(e) => startDrag(e, f, 'move', size)}
                    onPointerMove={onDrag}
                    onPointerUp={endDrag}
                    onKeyDown={(e) => onKey(e, f)}
                    onFocus={() => setSelected(f.key)}
                  >
                    <span className="field-text">
                      {f.type === 'CHECKBOX' ? '☐' : `${FIELD_LABELS[f.type]}${f.required ? '' : ' (optional)'}`}
                    </span>
                    <button
                      type="button"
                      className="field-del"
                      tabIndex={-1}
                      title="Remove this field"
                      aria-label={`Remove ${FIELD_LABELS[f.type]} for ${signerName(f.recipientId)}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(f.key);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <span className="resize" onPointerDown={(e) => startDrag(e, f, 'resize', size)} onPointerMove={onDrag} onPointerUp={endDrag} aria-hidden="true" />
                  </div>
                ))}
            </div>
          )}
        />
      </div>

      <aside className="panel panel-pad fields-side">
        <h2>Assign to</h2>
        <div className="assign-list" role="radiogroup" aria-label="Signer for new fields">
          {signers.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={assignTo === s.id} className={`assign${assignTo === s.id ? ' on' : ''}`} onClick={() => setAssignTo(s.id!)}>
              <span className="chip" style={{ background: colourOf(s.id!) }} aria-hidden="true" />
              <span className="assign-name">{s.fullName}</span>
              <span className="small muted">{counts(s.id!)} {counts(s.id!) === 1 ? 'field' : 'fields'}</span>
            </button>
          ))}
        </div>
        <h3 style={{ marginTop: 20 }}>Add a field for {signerName(assignTo).split(' ')[0]}</h3>
        <div className="palette">
          {PALETTE.map((t) => (
            <button key={t} type="button" className={`pal${placing === t ? ' on' : ''}`} onClick={() => setPlacing(placing === t ? null : t)} aria-pressed={placing === t}>
              {FIELD_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="small muted">Name and date signed are filled in for the signer automatically.</p>

        <div className="selected-field">
          <h3>Selected field</h3>
          {!sel ? (
            <p className="small muted">Select a field on the page to see its details, or add a new one above. {pageCount > 1 && 'Scroll to reach other pages.'}</p>
          ) : (
            <>
              <p className="small">
                <b>{FIELD_LABELS[sel.type]}</b> on page {sel.page}
              </p>
              <FormField label="Who fills it" id="who">
                <select id="who" className="input" value={sel.recipientId} onChange={(e) => patch(sel.key, { recipientId: e.target.value })}>
                  {signers.map((s) => (
                    <option key={s.key} value={s.id}>
                      {s.fullName}
                    </option>
                  ))}
                </select>
              </FormField>
              {!['NAME', 'DATE_SIGNED'].includes(sel.type) && (
                <TextField label="Label" placeholder="e.g. TIN number" hint="Shown to the signer." value={sel.label ?? ''} maxLength={120} onChange={(e) => patch(sel.key, { label: e.target.value })} />
              )}
              {sel.type === 'DROPDOWN' && (
                <FormField label="Choices, one per line" id="opts">
                  <textarea
                    id="opts"
                    className="input"
                    rows={4}
                    value={(sel.options ?? []).join('\n')}
                    onChange={(e) => patch(sel.key, { options: e.target.value.split('\n').map((s) => s.slice(0, 80)) })}
                    onBlur={(e) => patch(sel.key, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                  />
                </FormField>
              )}
              {sel.type === 'STAMP' && (
                <p className="small muted" style={{ marginBottom: 12 }}>
                  Ruliba staff choose one of the company stamps the administrator allows them. People outside Ruliba upload a photo or scan of their own company stamp.
                </p>
              )}
              {['TEXT', 'DROPDOWN', 'INITIALS', 'STAMP'].includes(sel.type) && (
                <label className="checks" style={{ marginBottom: 14 }}>
                  <span>
                    <input type="checkbox" checked={sel.required} onChange={(e) => patch(sel.key, { required: e.target.checked })} /> Must be filled in
                  </span>
                </label>
              )}
              <button className="btn btn-danger" onClick={() => remove(sel.key)}>
                Remove field
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

