import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiBytes } from '../api';
import { useAuth } from '../auth';
import { Dialog, ErrorBox, Field, formatDate, PageHead } from '../components/ui';

interface Summary {
  totals: { sent: number; completed: number; in_progress: number; declined: number; cancelled: number; expired: number; avg_hours: number | null; median_hours: number | null };
  byDepartment: { department: string; sent: number; completed: number }[];
  byType: { type: string; sent: number; completed: number }[];
  byMonth: { month: string; sent: number; completed: number }[];
  pagesNotPrinted: number;
}
interface Due {
  id: string;
  title: string;
  reference_no: string | null;
  completed_at: string;
  document_type: string;
  retention_years: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const hours = (h: number | null) => (h === null ? '–' : h < 1 ? 'Under an hour' : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);
const month = (m: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${m}-01T12:00:00Z`));

function Breakdown({ title, rows, label }: { title: string; rows: { sent: number; completed: number }[]; label: (r: never) => string }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{title.replace('By ', '').replace(/^./, (c) => c.toUpperCase())}</th>
            <th className="num">Sent</th>
            <th className="num">Completed</th>
            <th className="num">Completed share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{label(r as never)}</td>
              <td className="num">{r.sent}</td>
              <td className="num">{r.completed}</td>
              <td className="num">{r.sent ? `${Math.round((100 * r.completed) / r.sent)}%` : '–'}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={4} className="muted">
                Nothing sent in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export function ReportsPage() {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(iso(new Date()));
  const [purging, setPurging] = useState<Due | null>(null);
  const [reason, setReason] = useState('');
  const range = `from=${from}&to=${to}`;
  const q = useQuery({ queryKey: ['reports', from, to], queryFn: () => api<Summary>(`/reports/summary?${range}`) });
  const due = useQuery({ queryKey: ['retention-due'], queryFn: () => api<Due[]>('/retention/due') });
  const purge = useMutation({
    mutationFn: () => api(`/retention/${purging!.id}/purge`, { body: { reason: reason.trim() } }),
    onSuccess: () => {
      setPurging(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['retention-due'] });
    },
  });

  async function exportCsv() {
    const bytes = await apiBytes(`/reports/documents.csv?${range}`);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `esign-documents-${from}-to-${to}.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const t = q.data?.totals;
  return (
    <>
      <PageHead
        title="Reports"
        intro="How documents move through signing, by department and type. Counts documents by the date they were sent."
        action={
          <button className="btn btn-secondary" onClick={exportCsv}>
            Export list (CSV)
          </button>
        }
      />
      <div className="filter-extra panel" style={{ paddingTop: 14, marginBottom: 20 }}>
        <Field label="From" id="from">
          <input id="from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" id="to">
          <input id="to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <ErrorBox error={q.error} />
      {t && (
        <div className="figures">
          <div className="panel figure">
            <span>Sent</span>
            <b>{t.sent}</b>
          </div>
          <div className="panel figure">
            <span>Completed</span>
            <b>{t.completed}</b>
          </div>
          <div className="panel figure">
            <span>Still open</span>
            <b>{t.in_progress}</b>
          </div>
          <div className="panel figure">
            <span>Declined, cancelled or expired</span>
            <b>{t.declined + t.cancelled + t.expired}</b>
          </div>
          <div className="panel figure">
            <span>Typical time to complete</span>
            <b>{hours(t.median_hours)}</b>
          </div>
          <div className="panel figure">
            <span>Pages not printed</span>
            <b>{q.data!.pagesNotPrinted.toLocaleString('en-GB')}</b>
          </div>
        </div>
      )}
      {q.data && (
        <div className="stack">
          <div className="grid-2">
            <Breakdown title="By department" rows={q.data.byDepartment} label={(r: { department: string }) => r.department} />
            <Breakdown title="By document type" rows={q.data.byType} label={(r: { type: string }) => r.type} />
          </div>
          <Breakdown title="By month" rows={q.data.byMonth} label={(r: { month: string }) => month(r.month)} />
          <section className="panel">
            <div className="panel-head">
              <h2>Retention review</h2>
              <span className="muted small">Completed documents past the retention period of their type. Nothing is deleted automatically.</span>
            </div>
            <ErrorBox error={due.error ?? purge.error} />
            <table className="table">
              <tbody>
                {due.data?.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/documents/${d.id}`}>{d.title}</Link>
                      <span className="sub small muted" style={{ display: 'block' }}>
                        {d.reference_no ?? 'No reference'}, {d.document_type}
                      </span>
                    </td>
                    <td className="small">Completed {formatDate(d.completed_at)}, keep {d.retention_years} years</td>
                    <td style={{ textAlign: 'right' }}>
                      {hasRole('ADMIN') && (
                        <button className="btn btn-danger btn-sm" onClick={() => setPurging(d)}>
                          Delete files
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {due.data && !due.data.length && (
                  <tr>
                    <td className="muted">No document has reached the end of its retention period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </div>
      )}
      {purging && (
        <Dialog title="Delete the files of this document?" onClose={() => setPurging(null)}>
          <p style={{ marginBottom: 12 }}>
            The PDF files of “{purging.title}” are deleted for good. Its record, fingerprints and activity log are kept, so it remains on record that it was signed. Make sure no
            legal hold or dispute applies.
          </p>
          <ErrorBox error={purge.error} />
          <Field label="Reason" id="why" hint="For example the retention decision or board minute reference.">
            <textarea id="why" className="input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row-end">
            <button className="btn btn-secondary" onClick={() => setPurging(null)}>
              Keep the files
            </button>
            <button className="btn btn-danger" disabled={reason.trim().length < 5 || purge.isPending} onClick={() => purge.mutate()}>
              Delete files
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
