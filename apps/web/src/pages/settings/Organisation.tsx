import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { IconPlus } from '../../components/icons';
import { Dialog, ErrorBox, Field, TextField } from '../../components/ui';
import { Department, useDepartments } from './Users';

// ───────────── Departments ─────────────

export function DepartmentsPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const depts = useDepartments();
  const [editing, setEditing] = useState<Partial<Department> | null>(null);
  const save = useMutation({
    mutationFn: (d: Partial<Department>) =>
      d.id ? api(`/departments/${d.id}`, { method: 'PATCH', body: { code: d.code, name: d.name, active: d.active } }) : api('/departments', { body: { code: d.code, name: d.name } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      setEditing(null);
    },
  });

  return (
    <>
      <section className="panel">
        <div className="filters">
          <p className="muted small">The code appears in reference numbers, for example RCL/<b>PRO</b>/CON/2026/0001.</p>
          {hasRole('ADMIN') && (
            <button className="btn btn-primary" onClick={() => setEditing({ active: true })}>
              <IconPlus /> Add department
            </button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Status</th>{hasRole('ADMIN') && <th />}</tr>
          </thead>
          <tbody>
            {depts.data?.map((d) => (
              <tr key={d.id}>
                <td><b>{d.code}</b></td>
                <td>{d.name}</td>
                <td>{d.active ? <span className="badge badge-ok">In use</span> : <span className="badge">Retired</span>}</td>
                {hasRole('ADMIN') && <td style={{ textAlign: 'right' }}><button className="btn-link" onClick={() => setEditing(d)}>Edit</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && (
        <Dialog title={editing.id ? `Edit ${editing.name}` : 'Add a department'} onClose={() => setEditing(null)}>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(editing); }}>
            <ErrorBox error={save.error} />
            <TextField label="Code" value={editing.code ?? ''} maxLength={5} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} hint="2 to 5 capital letters. It cannot change once used in a reference number." />
            <TextField label="Name" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            {editing.id && (
              <label className="checks" style={{ marginBottom: 16 }}>
                <span><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> In use</span>
              </label>
            )}
            <div className="row-end">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={save.isPending}>Save department</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

// ───────────── Document types ─────────────

interface DocType {
  id?: string;
  code: string;
  name: string;
  requiresApproval: boolean;
  eSignAllowed: boolean;
  minSignatureLevel: 'PLATFORM' | 'GOVCA';
  retentionYears: number | null;
  active?: boolean;
}

export function DocumentTypesPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api<DocType[]>('/document-types') });
  const [editing, setEditing] = useState<DocType | null>(null);
  const save = useMutation({
    mutationFn: ({ id, ...d }: DocType) => (id ? api(`/document-types/${id}`, { method: 'PATCH', body: d }) : api('/document-types', { body: d })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['document-types'] });
      setEditing(null);
    },
  });

  return (
    <>
      <section className="panel">
        <div className="filters">
          <p className="muted small">Types decide approvals, signature level and how long signed copies are kept.</p>
          {hasRole('ADMIN') && (
            <button
              className="btn btn-primary"
              onClick={() => setEditing({ code: '', name: '', requiresApproval: true, eSignAllowed: true, minSignatureLevel: 'PLATFORM', retentionYears: null, active: true })}
            >
              <IconPlus /> Add type
            </button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Approval</th><th>E-signature</th><th>Keep for</th>{hasRole('ADMIN') && <th />}</tr>
          </thead>
          <tbody>
            {types.data?.map((t) => (
              <tr key={t.id}>
                <td><b>{t.code}</b></td>
                <td>{t.name}</td>
                <td>{t.requiresApproval ? 'Needed' : 'Not needed'}</td>
                <td>
                  {!t.eSignAllowed ? <span className="badge badge-warn">Not allowed</span> : t.minSignatureLevel === 'GOVCA' ? 'National (GovCA)' : 'Platform'}
                </td>
                <td>{t.retentionYears ? `${t.retentionYears} years` : <span className="muted">To be decided</span>}</td>
                {hasRole('ADMIN') && <td style={{ textAlign: 'right' }}><button className="btn-link" onClick={() => setEditing(t)}>Edit</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && (
        <Dialog title={editing.id ? `Edit ${editing.name}` : 'Add a document type'} onClose={() => setEditing(null)}>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(editing); }}>
            <ErrorBox error={save.error} />
            <TextField label="Code" value={editing.code} maxLength={5} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} hint="2 to 5 capital letters, used in reference numbers." />
            <TextField label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <div className="checks" style={{ marginBottom: 16 }}>
              <label><input type="checkbox" checked={editing.requiresApproval} onChange={(e) => setEditing({ ...editing, requiresApproval: e.target.checked })} /> Needs approval before sending</label>
              <label><input type="checkbox" checked={editing.eSignAllowed} onChange={(e) => setEditing({ ...editing, eSignAllowed: e.target.checked })} /> May be signed electronically</label>
            </div>
            <Field label="Lowest signature level" id="lvl">
              <select id="lvl" className="input" value={editing.minSignatureLevel} onChange={(e) => setEditing({ ...editing, minSignatureLevel: e.target.value as DocType['minSignatureLevel'] })}>
                <option value="PLATFORM">Platform signature</option>
                <option value="GOVCA">National signature (GovCA), not switched on yet</option>
              </select>
            </Field>
            <TextField
              label="Keep signed copies for (years)"
              type="number"
              min={1}
              max={100}
              value={editing.retentionYears ?? ''}
              onChange={(e) => setEditing({ ...editing, retentionYears: e.target.value ? Number(e.target.value) : null })}
              hint="Leave empty until legal and finance set the period. Nothing is deleted meanwhile."
            />
            <div className="row-end">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={save.isPending}>Save type</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
