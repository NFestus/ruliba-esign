import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { IconFile, IconSearch } from '../../components/icons';
import { Empty } from '../../components/ui';
import { DOC_STATUS } from '../../labels';
import { DocRow } from './types';

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting for you' },
  { key: 'progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'declined', label: 'Declined' },
  { key: 'voided', label: 'Cancelled' },
] as const;
export type FilterKey = (typeof FILTERS)[number]['key'];

const EMPTY: Record<FilterKey, string> = {
  all: 'No documents yet.',
  waiting: 'Nothing is waiting for you.',
  progress: 'Nothing in progress right now.',
  completed: 'No completed documents yet.',
  drafts: 'No drafts.',
  declined: 'No declined documents.',
  voided: 'No cancelled documents.',
};

export function StatusBadge({ status }: { status: string }) {
  const s = DOC_STATUS[status] ?? { label: status, tone: 'off' };
  return <span className={`badge badge-${s.tone}`}>{s.label}</span>;
}

const when = (d: string) => {
  const date = new Date(d);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat('en-GB', sameDay ? { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' } : { day: 'numeric', month: 'short', timeZone: 'Africa/Kigali' }).format(date);
};

function signers(r: DocRow['recipients']) {
  const names = r.filter((x) => x.role === 'SIGNER').map((x) => x.fullName.split(' ')[0]);
  if (!names.length) return <span className="muted">Not set yet</span>;
  return names.length > 2 ? `${names.slice(0, 2).join(', ')}, +${names.length - 2}` : names.join(', ');
}

export function DocumentTable({
  filter,
  onFilter,
  showFilters = FILTERS.map((f) => f.key),
  extraFilters = false,
  folderId,
}: {
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  showFilters?: FilterKey[];
  extraFilters?: boolean;
  folderId?: string;
}) {
  const { hasRole } = useAuth();
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string }[]>('/departments'), enabled: extraFilters, staleTime: 300_000 });
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const extra = `${dept ? `&departmentId=${dept}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${folderId ? `&folderId=${folderId}` : ''}`;
  const docs = useQuery({ queryKey: ['documents', filter, debounced, extra], queryFn: () => api<DocRow[]>(`/documents?filter=${filter}&q=${encodeURIComponent(debounced)}${extra}`) });

  return (
    <section className="panel" aria-label="Documents">
      <div className="filters">
        <div className="pills" role="group" aria-label="Show">
          {FILTERS.filter((f) => showFilters.includes(f.key)).map((f) => (
            <button key={f.key} className="pill" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="sr-only">Search documents</span>
          <IconSearch />
          <input className="input" type="search" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {extraFilters && (
        <div className="filter-extra">
          <div className="field">
            <label htmlFor="f-dept">Department</label>
            <select id="f-dept" className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">All departments</option>
              {depts.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">Created from</label>
            <input id="f-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="f-to">to</label>
            <input id="f-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(dept || from || to) && (
            <button className="btn-link small" onClick={() => (setDept(''), setFrom(''), setTo(''))}>
              Clear
            </button>
          )}
        </div>
      )}
      {docs.data && docs.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Signers</th>
              <th>Status</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.data.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/documents/${d.id}`} className="doc-link">
                    <span className="doc-icon" aria-hidden="true">
                      <IconFile width={18} height={18} />
                    </span>
                    <span>
                      <b>{d.title}</b>
                      <span className="sub">{d.referenceNo ?? (d.counterparty || `From ${d.senderName}`)}</span>
                    </span>
                  </Link>
                </td>
                <td className="small">{signers(d.recipients)}</td>
                <td>{d.myAction === 'approve' ? <span className="badge badge-warn">Your approval</span> : d.waitingForMe ? <span className="badge badge-warn">Waiting for you</span> : <StatusBadge status={d.status} />}</td>
                <td className="small">{when(d.updatedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  {d.myAction === 'approve' ? (
                    <Link className="btn btn-primary btn-sm" to={`/documents/${d.id}`}>
                      Review
                    </Link>
                  ) : d.waitingForMe ? (
                    <Link className="btn btn-primary btn-sm" to={`/documents/${d.id}/sign`}>
                      Sign
                    </Link>
                  ) : d.status === 'DRAFT' ? (
                    <Link className="btn-link" to={`/documents/${d.id}/prepare`}>
                      Continue
                    </Link>
                  ) : (
                    <Link className="btn-link" to={`/documents/${d.id}`}>
                      View
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty icon={<IconFile width={28} height={28} />} title={docs.isLoading ? 'Loading…' : debounced ? `Nothing matches “${debounced}”.` : folderId && folderId !== 'none' ? 'This folder is empty. Open a document and choose this folder under Details.' : EMPTY[filter]}>
          {!docs.isLoading && filter === 'all' && !debounced && hasRole('SENDER') && <p>Upload a PDF or Word document to start. It takes about two minutes.</p>}
        </Empty>
      )}
    </section>
  );
}
