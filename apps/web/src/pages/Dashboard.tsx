import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { IconPlus } from '../components/icons';
import { PageHead } from '../components/ui';
import { DocumentTable, FilterKey } from './documents/DocumentTable';
import { Folder, FolderDialog, useFolders } from '../components/Folders';

const TILES: { key: FilterKey; label: string; count: 'waiting' | 'progress' | 'completed' | 'drafts' }[] = [
  { key: 'waiting', label: 'Waiting for you', count: 'waiting' },
  { key: 'progress', label: 'In progress', count: 'progress' },
  { key: 'completed', label: 'Completed', count: 'completed' },
  { key: 'drafts', label: 'Drafts', count: 'drafts' },
];

export function DashboardPage() {
  const { user, hasRole } = useAuth();
  const [filter, setFilter] = useState<FilterKey>('all');
  const counts = useQuery({ queryKey: ['documents', 'counts'], queryFn: () => api<Record<string, number>>('/documents/counts') });
  const firstName = user?.fullName.split(' ')[0];

  return (
    <>
      <PageHead
        title="Dashboard"
        intro={`Welcome, ${firstName}. Track every document from draft to signed.`}
        action={
          hasRole('SENDER') && (
            <Link to="/documents/new" className="btn btn-primary">
              <IconPlus /> New document
            </Link>
          )
        }
      />
      <div className="tiles">
        {TILES.map((t) => (
          <button key={t.key} className="tile" aria-pressed={filter === t.key} onClick={() => setFilter(filter === t.key ? 'all' : t.key)}>
            <span>{t.label}</span>
            <b>{counts.data?.[t.count] ?? '–'}</b>
          </button>
        ))}
      </div>
      <DocumentTable filter={filter} onFilter={setFilter} showFilters={['all', 'waiting', 'progress', 'completed', 'drafts']} />
    </>
  );
}

export function DocumentsPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [folderId, setFolderId] = useState<string>('');
  const [dialog, setDialog] = useState<Folder | 'new' | null>(null);
  const folders = useFolders();
  const current = folders.data?.find((f) => f.id === folderId);
  const remove = useMutation({
    mutationFn: (f: Folder) => api(`/folders/${f.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setFolderId('');
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  return (
    <>
      <PageHead
        title="Documents"
        intro="Everything you have sent, signed or been sent. File them in your own folders."
        action={
          hasRole('SENDER') && (
            <Link to="/documents/new" className="btn btn-primary">
              <IconPlus /> New document
            </Link>
          )
        }
      />
      <section className="panel" aria-label="Folders" style={{ marginBottom: 16, paddingBottom: 14 }}>
        <div className="folders" role="group" aria-label="Folders">
          <button className="pill" aria-pressed={folderId === ''} onClick={() => setFolderId('')}>
            All documents
          </button>
          <button className="pill" aria-pressed={folderId === 'none'} onClick={() => setFolderId('none')}>
            Not in a folder
          </button>
          {folders.data?.map((f) => (
            <button key={f.id} className="pill folder-pill" aria-pressed={folderId === f.id} onClick={() => setFolderId(f.id)}>
              {f.name} <small>{f.documentCount}</small>
            </button>
          ))}
          <button className="btn-link small" onClick={() => setDialog('new')}>
            + New folder
          </button>
          {current && (
            <span className="row" style={{ marginLeft: 'auto', gap: 12 }}>
              <button className="btn-link small" onClick={() => setDialog(current)}>
                Rename
              </button>
              <button
                className="btn-link small danger"
                onClick={() => window.confirm(`Delete the folder "${current.name}"? Its documents are not deleted; they stay under All documents.`) && remove.mutate(current)}
              >
                Delete folder
              </button>
            </span>
          )}
        </div>
      </section>
      <DocumentTable filter={filter} onFilter={setFilter} extraFilters folderId={folderId || undefined} />
      {dialog && <FolderDialog folder={dialog === 'new' ? undefined : dialog} onClose={() => setDialog(null)} onSaved={(f) => dialog === 'new' && setFolderId(f.id)} />}
    </>
  );
}
