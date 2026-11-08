import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { SignaturePad } from '../../components/SignaturePad';
import { ErrorBox } from '../../components/ui';

interface Saved {
  kind: 'SIGNATURE' | 'INITIALS';
  method: string;
  image: string;
}

function Card({ kind, saved }: { kind: 'SIGNATURE' | 'INITIALS'; saved?: Saved }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(!saved);
  const save = useMutation({
    mutationFn: (r: { image: string; method: string }) => api('/me/signatures', { method: 'PUT', body: { kind, ...r } }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['my-signatures'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/me/signatures/${kind}`, { method: 'DELETE' }),
    onSuccess: () => {
      setEditing(true);
      void qc.invalidateQueries({ queryKey: ['my-signatures'] });
    },
  });
  const what = kind === 'INITIALS' ? 'initials' : 'signature';
  return (
    <section className="panel panel-pad">
      <h2>My {what}</h2>
      <p className="small muted" style={{ margin: '6px 0 14px' }}>
        {kind === 'SIGNATURE' ? 'Saved once, offered every time you sign from eSign while signed in.' : 'Used wherever a document asks for your initials.'} Only you can use it.
      </p>
      <ErrorBox error={save.error ?? remove.error} />
      {saved && !editing ? (
        <>
          <div className="saved-sig">
            <img src={saved.image} alt={`Your saved ${what}`} />
          </div>
          <div className="row-end">
            <button className="btn btn-secondary" onClick={() => remove.mutate()}>
              Remove
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Replace
            </button>
          </div>
        </>
      ) : (
        <SignaturePad kind={kind} defaultName={user?.fullName ?? ''} submitLabel={`Save this ${what}`} onCancel={saved ? () => setEditing(false) : undefined} onDone={(r) => save.mutate(r)} />
      )}
    </section>
  );
}

export function MySignaturePage() {
  const q = useQuery({ queryKey: ['my-signatures'], queryFn: () => api<Saved[]>('/me/signatures') });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  return (
    <div className="grid-2">
      <Card kind="SIGNATURE" saved={q.data?.find((s) => s.kind === 'SIGNATURE')} />
      <Card kind="INITIALS" saved={q.data?.find((s) => s.kind === 'INITIALS')} />
    </div>
  );
}
