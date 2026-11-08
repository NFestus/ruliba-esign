import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { IconTemplate } from '../components/icons';
import { Dialog, Empty, ErrorBox, PageHead, TextField } from '../components/ui';

interface Template {
  id: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  ownerId: string;
  fieldCount: number;
  updatedAt: string;
  documentType: { name: string; code: string };
  owner: { fullName: string };
  roles: { id: string; roleName: string; stepOrder: number }[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function TemplatesPage() {
  const { user, hasRole } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api<Template[]>('/templates') });
  const [using, setUsing] = useState<Template | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['templates'] }),
  });

  return (
    <>
      <PageHead
        title="Templates"
        intro="Documents you send again and again, prepared once. To make one, prepare a document as usual and choose “Save as a template” on the Send step."
      />
      <ErrorBox error={q.error ?? remove.error} />
      {q.data?.length ? (
        <div className="tpl-grid">
          {q.data.map((t) => (
            <article key={t.id} className="panel tpl-card">
              <h2 style={{ fontSize: 17 }}>{t.name}</h2>
              <span className="small muted">
                {t.documentType.name}, {t.fieldCount} {t.fieldCount === 1 ? 'field' : 'fields'}, {t.departmentId ? 'your department' : 'every department'}
              </span>
              {t.description && <p className="small">{t.description}</p>}
              <div className="roles" aria-label="Signers">
                {t.roles.map((r) => (
                  <span key={r.id} className="badge">
                    {r.stepOrder}. {r.roleName}
                  </span>
                ))}
              </div>
              <div className="row-end">
                {(t.ownerId === user?.id || hasRole('ADMIN')) && (
                  <button className="btn-link small" onClick={() => window.confirm(`Remove the template “${t.name}”? Documents already sent are not affected.`) && remove.mutate(t.id)}>
                    Remove
                  </button>
                )}
                {hasRole('SENDER') && (
                  <button className="btn btn-primary btn-sm" onClick={() => setUsing(t)}>
                    Use template
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty icon={<IconTemplate width={28} height={28} />} title={q.isLoading ? 'Loading…' : 'No templates yet.'}>
            {!q.isLoading && <p>Prepare a document you send often, then save it as a template from its Send step.</p>}
          </Empty>
        </section>
      )}
      {using && <UseDialog template={using} onClose={() => setUsing(null)} />}
    </>
  );
}

function UseDialog({ template, onClose }: { template: Template; onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(template.name);
  const [people, setPeople] = useState<Record<string, { fullName: string; email: string }>>(() => Object.fromEntries(template.roles.map((r) => [r.id, { fullName: '', email: '' }])));
  const m = useMutation({
    mutationFn: () => api<{ id: string }>(`/templates/${template.id}/use`, { body: { title: title.trim(), people: template.roles.map((r) => ({ roleId: r.id, ...people[r.id] })) } }),
    onSuccess: (d) => navigate(`/documents/${d.id}/prepare`),
  });
  const ready = title.trim().length >= 2 && template.roles.every((r) => people[r.id].fullName.trim().length >= 2 && EMAIL.test(people[r.id].email.trim()));
  const set = (id: string, k: 'fullName' | 'email', v: string) => setPeople((p) => ({ ...p, [id]: { ...p[id], [k]: v } }));

  return (
    <Dialog title={`New document from “${template.name}”`} onClose={onClose}>
      <p style={{ marginBottom: 12 }}>Fill in who signs. You can check everything before it is sent.</p>
      <ErrorBox error={m.error} />
      <TextField label="Document title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      {template.roles.map((r) => (
        <fieldset key={r.id} className="role-set">
          <legend>
            {r.stepOrder}. {r.roleName}
          </legend>
          <div className="grid-2" style={{ gap: 10 }}>
            <TextField label="Full name" value={people[r.id].fullName} maxLength={160} onChange={(e) => set(r.id, 'fullName', e.target.value)} />
            <TextField label="Email" type="email" value={people[r.id].email} maxLength={254} onChange={(e) => set(r.id, 'email', e.target.value)} />
          </div>
        </fieldset>
      ))}
      <div className="row-end">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
          Create document
        </button>
      </div>
    </Dialog>
  );
}
