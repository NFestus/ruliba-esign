import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api';
import { stampFileToPng } from '../../components/StampPicker';
import { Dialog, Empty, ErrorBox, formatDate, TextField } from '../../components/ui';

interface Stamp {
  id: string;
  name: string;
  active: boolean;
  sha256: string;
  createdAt: string;
  image: string;
  users: { id: string; fullName: string }[];
}
interface Person {
  id: string;
  fullName: string;
  jobTitle: string | null;
}

/** Settings > Stamps: Ruliba's company stamps and who may apply each one. Administrators only. */
export function StampsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stamps'], queryFn: () => api<Stamp[]>('/stamps') });
  const people = useQuery({ queryKey: ['directory'], queryFn: () => api<Person[]>('/users/directory') });
  const [editing, setEditing] = useState<Stamp | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (s: Stamp) => api(`/stamps/${s.id}`, { method: 'PATCH', body: { active: !s.active } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stamps'] }),
  });

  return (
    <div className="stack">
      <section className="panel panel-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Company stamps</h2>
            <p className="muted small" style={{ maxWidth: 680 }}>
              Upload each official stamp and choose who may apply it. When a document has a Stamp box for a Ruliba staff member, they can only choose from the stamps listed
              for them. Outside signers upload their own company stamp. A copy of the stamp goes with each document, so changing or withdrawing a stamp never changes documents
              already stamped.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            Add a stamp
          </button>
        </div>
      </section>
      <ErrorBox error={q.error ?? toggle.error} />
      {q.data?.length ? (
        q.data.map((s) => (
          <section key={s.id} className="panel panel-pad">
            <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
              <img className="stamp-thumb" src={s.image} alt="" />
              <div style={{ flex: 1 }}>
                <h3>
                  {s.name} {!s.active && <span className="badge">Withdrawn</span>}
                </h3>
                <p className="small muted">Added {formatDate(s.createdAt)}</p>
                <p className="small" style={{ marginTop: 6 }}>
                  {s.users.length ? <>May be applied by: {s.users.map((u) => u.fullName).join(', ')}</> : <span className="badge badge-warn">Nobody may use it yet</span>}
                </p>
              </div>
              <div className="row">
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button className="btn-link small" onClick={() => toggle.mutate(s)}>
                  {s.active ? 'Withdraw' : 'Use again'}
                </button>
              </div>
            </div>
          </section>
        ))
      ) : (
        <section className="panel">
          <Empty title={q.isLoading ? 'Loading…' : 'No stamps yet.'}>{!q.isLoading && <p>Add Ruliba's official stamp to let staff stamp documents.</p>}</Empty>
        </section>
      )}
      {editing && <StampDialog stamp={editing === 'new' ? null : editing} people={people.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function StampDialog({ stamp, people, onClose }: { stamp: Stamp | null; people: Person[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(stamp?.name ?? '');
  const [image, setImage] = useState<string | null>(stamp?.image ?? null);
  const [userIds, setUserIds] = useState<string[]>(stamp?.users.map((u) => u.id) ?? []);
  const [picError, setPicError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const save = useMutation({
    mutationFn: () => (stamp ? api(`/stamps/${stamp.id}`, { method: 'PATCH', body: { name: name.trim(), userIds } }) : api('/stamps', { body: { name: name.trim(), image, userIds } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stamps'] });
      onClose();
    },
  });
  const shown = people.filter((p) => !filter || p.fullName.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Dialog title={stamp ? 'Edit stamp' : 'Add a stamp'} onClose={onClose}>
      <ErrorBox error={save.error} />
      <TextField label="Name" placeholder="e.g. Ruliba Clays official stamp" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      {stamp ? (
        <div className="stamp-preview">
          <img src={stamp.image} alt="" />
          <p className="small muted">To change the picture, withdraw this stamp and add a new one, so the record shows which picture was used when.</p>
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <label className="btn btn-secondary">
            Choose the stamp picture
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={async (e) => {
                setPicError(null);
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  setImage(await stampFileToPng(f));
                } catch (err) {
                  setPicError((err as Error).message);
                }
              }}
            />
          </label>
          <p className="small muted" style={{ marginTop: 6 }}>A scan or photo of the stamp on white paper. The white is made transparent.</p>
          {image && (
            <div className="stamp-preview">
              <img src={image} alt="Stamp preview" />
            </div>
          )}
          {picError && <div className="alert alert-error">{picError}</div>}
        </div>
      )}
      <fieldset className="role-set">
        <legend>Who may apply it</legend>
        <input className="input" placeholder="Find a person" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} aria-label="Find a person" />
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {shown.map((p) => (
            <label key={p.id} className="checks" style={{ display: 'flex', padding: '4px 0' }}>
              <span>
                <input type="checkbox" checked={userIds.includes(p.id)} onChange={(e) => setUserIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))} /> {p.fullName}
                {p.jobTitle ? <span className="muted">, {p.jobTitle}</span> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row-end">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={save.isPending || name.trim().length < 2 || !image} onClick={() => save.mutate()}>
          {stamp ? 'Save changes' : 'Add stamp'}
        </button>
      </div>
    </Dialog>
  );
}
