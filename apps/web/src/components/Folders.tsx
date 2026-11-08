import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Dialog, ErrorBox, TextField } from './ui';

export interface Folder {
  id: string;
  name: string;
  documentCount: number;
}

export const useFolders = () => useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });

/** Create or rename a folder. */
export function FolderDialog({ folder, onClose, onSaved }: { folder?: Folder; onClose: () => void; onSaved?: (f: { id: string; name: string }) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(folder?.name ?? '');
  const save = useMutation({
    mutationFn: () => (folder ? api<{ id: string; name: string }>(`/folders/${folder.id}`, { method: 'PATCH', body: { name: name.trim() } }) : api<{ id: string; name: string }>('/folders', { body: { name: name.trim() } })),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      onSaved?.(f);
      onClose();
    },
  });
  return (
    <Dialog title={folder ? 'Rename folder' : 'New folder'} onClose={onClose}>
      <p style={{ marginBottom: 12 }}>Folders are yours alone: they organise your list and never change who can see a document.</p>
      <ErrorBox error={save.error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <TextField label="Folder name" placeholder="e.g. Supply contracts 2026" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="row-end">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending}>
            {folder ? 'Rename' : 'Create folder'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Chooses the folder a document is in (for the signed-in person). */
export function FolderSelect({ documentId, value, onChange }: { documentId: string; value: string | null; onChange: (id: string | null) => void }) {
  const qc = useQueryClient();
  const folders = useFolders();
  const [creating, setCreating] = useState(false);
  const move = useMutation({
    mutationFn: (folderId: string | null) => api<{ folderId: string | null }>(`/documents/${documentId}/folder`, { method: 'PUT', body: { folderId } }),
    onSuccess: (r) => {
      onChange(r.folderId);
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  return (
    <>
      <select
        className="input"
        aria-label="Folder"
        value={value ?? ''}
        disabled={move.isPending}
        onChange={(e) => (e.target.value === '__new' ? setCreating(true) : move.mutate(e.target.value || null))}
      >
        <option value="">Not in a folder</option>
        {folders.data?.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value="__new">New folder…</option>
      </select>
      <ErrorBox error={move.error} />
      {creating && <FolderDialog onClose={() => setCreating(false)} onSaved={(f) => move.mutate(f.id)} />}
    </>
  );
}
