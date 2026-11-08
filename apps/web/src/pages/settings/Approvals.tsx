import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ErrorBox, Field, TextField } from '../../components/ui';

interface Step {
  id?: string;
  label: string;
  approverUserId: string | null;
  minAmount: string | number | null;
  approver?: { id: string; fullName: string; email: string } | null;
}
interface Policy {
  id?: string;
  name: string;
  documentTypeId: string | null;
  departmentId: string | null;
  active: boolean;
  steps: Step[];
  documentType: { code: string; name: string } | null;
  department: { code: string; name: string } | null;
}
interface Person {
  id: string;
  fullName: string;
  jobTitle: string | null;
}

interface Option {
  id: string;
  name: string;
  active?: boolean;
}

const money = (n: string | number, cur: string | null) => `${Number(n).toLocaleString('en-RW')}${cur ? ` ${cur}` : ''}`;

function PolicyEditor({ policy, people, currency, types, departments, onDone }: { policy: Policy; people: Person[]; currency: string | null; types: Option[]; departments: Option[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(policy.name);
  const [documentTypeId, setDocumentTypeId] = useState(policy.documentTypeId);
  const [departmentId, setDepartmentId] = useState(policy.departmentId);
  const [steps, setSteps] = useState<Step[]>(policy.steps.map((s) => ({ ...s, minAmount: s.minAmount === null ? null : Number(s.minAmount) })));
  const save = useMutation({
    mutationFn: () =>
      api(policy.id ? `/approval-policies/${policy.id}` : '/approval-policies', {
        method: policy.id ? 'PUT' : 'POST',
        body: {
          name: name.trim(),
          documentTypeId,
          departmentId,
          active: policy.active,
          steps: steps.map((s) => ({ label: s.label, approverUserId: s.approverUserId || null, minAmount: s.minAmount === '' || s.minAmount === null ? null : Number(s.minAmount) })),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approval-policies'] });
      onDone();
    },
  });
  const set = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <ErrorBox error={save.error} />
      <TextField label="Name of the chain" placeholder="e.g. Purchase orders" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="For document type" id="pt">
          <select id="pt" className="input" value={documentTypeId ?? ''} onChange={(e) => setDocumentTypeId(e.target.value || null)}>
            <option value="">Every type that needs approval</option>
            {types.filter((t) => t.active !== false).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>
        <Field label="From department" id="pd" hint="A chain for one department wins over a chain for any department.">
          <select id="pd" className="input" value={departmentId ?? ''} onChange={(e) => setDepartmentId(e.target.value || null)}>
            <option value="">Any department</option>
            {departments.filter((d) => d.active !== false).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <h3 style={{ margin: '8px 0 12px' }}>Steps, in order</h3>
      <ol className="stack" style={{ paddingLeft: 20, gap: 16 }}>
        {steps.map((s, i) => (
          <li key={i}>
            <div className="grid-2" style={{ gap: 12 }}>
              <TextField label="Post" value={s.label} onChange={(e) => set(i, { label: e.target.value })} />
              <Field label="Person holding it" id={`p${i}`}>
                <select id={`p${i}`} className="input" value={s.approverUserId ?? ''} onChange={(e) => set(i, { approverUserId: e.target.value || null })}>
                  <option value="">Not assigned yet</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.fullName}{p.jobTitle ? `, ${p.jobTitle}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>
            <TextField
              label={`Only when the value is above${currency ? ` (${currency})` : ''}`}
              type="number"
              min={0}
              step="any"
              value={s.minAmount ?? ''}
              onChange={(e) => set(i, { minAmount: e.target.value === '' ? null : e.target.value })}
              hint="Leave empty if this step always applies."
            />
            {steps.length > 1 && (
              <button type="button" className="btn-link" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove this step</button>
            )}
          </li>
        ))}
      </ol>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" onClick={() => setSteps([...steps, { label: '', approverUserId: null, minAmount: null }])}>Add a step</button>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onDone}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || name.trim().length < 2 || steps.some((s) => s.label.trim().length < 2)}>Save approval chain</button>
        </div>
      </div>
    </form>
  );
}

export function ApprovalsPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const isAdmin = hasRole('ADMIN');
  const policies = useQuery({ queryKey: ['approval-policies'], queryFn: () => api<Policy[]>('/approval-policies') });
  const people = useQuery({ queryKey: ['directory'], queryFn: () => api<Person[]>('/users/directory') });
  const settings = useQuery({ queryKey: ['approval-settings'], queryFn: () => api<{ currency: string | null }>('/settings/approval') });
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api<(Option & { requiresApproval: boolean; eSignAllowed: boolean })[]>('/document-types'), enabled: isAdmin });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api<Option[]>('/departments'), enabled: isAdmin });
  const [editing, setEditing] = useState<string | null>(null);
  const blank: Policy = { name: '', documentTypeId: null, departmentId: null, active: true, steps: [{ label: '', approverUserId: null, minAmount: null }], documentType: null, department: null };
  const covered = (t: { id: string }) => policies.data?.some((p) => p.active && (p.documentTypeId === t.id || p.documentTypeId === null));
  const uncovered = (types.data ?? []).filter((t) => t.requiresApproval && t.eSignAllowed !== false && t.active !== false && !covered(t));
  const [currency, setCurrency] = useState('');
  const saveCurrency = useMutation({
    mutationFn: () => api('/settings/approval', { method: 'PUT', body: { currency } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['approval-settings'] }),
  });
  const cur = settings.data?.currency ?? null;
  const placeholderThreshold = policies.data?.some((p) => p.steps.some((s) => s.minAmount !== null && Number(s.minAmount) === 0));

  return (
    <div className="stack">
      {(!cur || placeholderThreshold) && (
        <div className="alert alert-warn">
          {!cur && <p>Set the currency that approval amounts are written in.</p>}
          {placeholderThreshold && (
            <p>The Managing Director threshold is still 0, so every supply contract goes to the Managing Director. Enter the agreed amount when it is decided.</p>
          )}
        </div>
      )}

      {isAdmin && (
        <section className="panel panel-pad">
          <h2>Currency for approval amounts</h2>
          <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); saveCurrency.mutate(); }}>
            <div style={{ width: 160 }}>
              <TextField label="Currency code" placeholder={cur ?? 'RWF'} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </div>
            <button className="btn btn-secondary" style={{ marginBottom: 16 }} disabled={currency.length !== 3}>Save currency</button>
            {cur && <span className="muted" style={{ marginBottom: 16 }}>Now: {cur}</span>}
          </form>
          <ErrorBox error={saveCurrency.error} />
        </section>
      )}

      {isAdmin && uncovered.length > 0 && (
        <div className="alert alert-warn">
          These document types need approval but have no chain, so they cannot be sent: <b>{uncovered.map((t) => t.name).join(', ')}</b>. Add a chain for them, or switch off
          “Needs approval before sending” under Document types.
        </div>
      )}

      {isAdmin && (
        <div className="row-end">
          {editing !== 'new' && <button className="btn btn-primary" onClick={() => setEditing('new')}>New approval chain</button>}
        </div>
      )}
      {editing === 'new' && (
        <section className="panel panel-pad">
          <h2>New approval chain</h2>
          <div style={{ marginTop: 16 }}>
            <PolicyEditor policy={blank} people={people.data ?? []} currency={cur} types={types.data ?? []} departments={departments.data ?? []} onDone={() => setEditing(null)} />
          </div>
        </section>
      )}

      {policies.data?.map((p) => (
        <section className="panel panel-pad" key={p.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>{p.name}</h2>
              <p className="muted small">
                For {p.documentType ? p.documentType.name.toLowerCase() + 's' : 'every document type'} from {p.department ? p.department.name : 'any department'}
              </p>
            </div>
            {isAdmin && editing !== p.id && <button className="btn btn-secondary" onClick={() => setEditing(p.id!)}>Edit chain</button>}
          </div>
          <div style={{ marginTop: 16 }}>
            {editing === p.id ? (
              <PolicyEditor policy={p} people={people.data ?? []} currency={cur} types={types.data ?? []} departments={departments.data ?? []} onDone={() => setEditing(null)} />
            ) : (
              <ol style={{ paddingLeft: 20, margin: 0 }}>
                {p.steps.map((s) => (
                  <li key={s.id} style={{ marginBottom: 6 }}>
                    <b>{s.label}</b>
                    {s.approver ? <span className="muted"> ({s.approver.fullName})</span> : <span className="badge badge-warn" style={{ marginLeft: 8 }}>No one assigned</span>}
                    {s.minAmount !== null && <span className="muted"> when the value is above {money(s.minAmount, cur)}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
