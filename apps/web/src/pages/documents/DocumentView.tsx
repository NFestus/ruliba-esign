import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiBytes } from '../../api';
import { useAuth } from '../../auth';
import { Dialog, ErrorBox, Field, formatDate } from '../../components/ui';
import { eventLabel, FILE_LABEL, RECIPIENT_STATUS, SIGNER_COLOURS } from '../../labels';
import { StatusBadge } from './DocumentTable';
import { FolderSelect } from '../../components/Folders';
import { DocFile, DocumentDetail } from './types';

async function download(id: string, kind: string, file: DocFile) {
  const bytes = await apiBytes(`/documents/${id}/files/${kind}?download=1`);
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const a = Object.assign(document.createElement('a'), { href: url, download: file.fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const APPROVAL_STATUS: Record<string, string> = {
  WAITING: 'Waiting for the earlier approval',
  SENT: 'Asked to approve',
  VIEWED: 'Asked to approve',
  COMPLETED: 'Approved',
  CANCELLED: 'Cancelled',
};

const money = (v: string | null, c: string | null) => (v === null ? null : `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(Number(v))} ${c ?? ''}`.trim());

export function DocumentViewPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['document', id], queryFn: () => api<DocumentDetail>(`/documents/${id}`) });
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [approving, setApproving] = useState<'approve' | 'return' | null>(null);
  const [comment, setComment] = useState('');
  const [notice, setNotice] = useState<string | null>(params.get('sent') ? 'Sent. The first signers have been emailed.' : null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['document', id] });
    void qc.invalidateQueries({ queryKey: ['documents'] });
  };

  const voidM = useMutation({
    mutationFn: () => api(`/documents/${id}/void`, { body: { reason } }),
    onSuccess: () => {
      setVoiding(false);
      setNotice('Cancelled. Everyone who had the link was told, and the links no longer work.');
      refresh();
    },
  });
  const resendM = useMutation({
    mutationFn: (rid: string) => api(`/documents/${id}/recipients/${rid}/resend`, { body: {} }),
    onSuccess: (_d, rid) => {
      setNotice(`A new link was emailed to ${q.data?.recipients.find((r) => r.id === rid)?.fullName}. The old one no longer works.`);
      refresh();
    },
  });
  const approveM = useMutation({
    mutationFn: () =>
      approving === 'approve'
        ? api(`/documents/${id}/approve`, { body: { comment: comment.trim() || null } })
        : api(`/documents/${id}/return`, { body: { reason: comment.trim() } }),
    onSuccess: () => {
      setNotice(approving === 'approve' ? 'Approved. The next person has been told.' : 'Returned to the sender with your reason.');
      setApproving(null);
      setComment('');
      refresh();
    },
  });
  const deleteM = useMutation({
    mutationFn: () => api(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      navigate('/documents', { replace: true });
    },
  });

  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  if (!d) return <p className="muted">Opening the document…</p>;

  const me = d.recipients.find((r) => r.role === 'SIGNER' && (r.userId === user?.id || r.email === user?.email));
  const myTurn = d.status === 'IN_PROGRESS' && me && ['SENT', 'VIEWED'].includes(me.status);
  const signed = d.purgedAt ? undefined : (d.files.find((f) => f.kind === 'SEALED') ?? d.files.find((f) => f.kind === 'SIGNED'));
  const certificate = d.purgedAt ? undefined : d.files.find((f) => f.kind === 'CERTIFICATE');
  const signers = d.recipients.filter((r) => r.role === 'SIGNER');
  const approvers = d.recipients.filter((r) => r.role === 'APPROVER');
  const myApproval = d.status === 'PENDING_APPROVAL' && approvers.find((r) => r.userId === user?.id && ['SENT', 'VIEWED'].includes(r.status));
  const value = money(d.contractValue, d.currency);
  const done = signers.filter((s) => s.status === 'COMPLETED').length;
  const events = [...d.events].filter((e) => e.type !== 'document.file_opened').reverse();

  return (
    <div className="doc-view">
      {notice && <div className="alert alert-ok" role="status">{notice}</div>}
      <ErrorBox error={voidM.error ?? resendM.error ?? deleteM.error} />
      {myApproval && (
        <div className="alert alert-warn approval-ask">
          <span>
            <b>Your approval is needed</b>{/\(([^)]+)\)$/.exec(myApproval.fullName) ? ` as ${/\(([^)]+)\)$/.exec(myApproval.fullName)![1]}` : ''}. Read the document, then approve it or send it back to {d.sender.fullName} with what to change.
          </span>
          <span className="row">
            <button className="btn btn-secondary" onClick={() => setApproving('return')}>
              Return for changes
            </button>
            <button className="btn btn-primary" onClick={() => setApproving('approve')}>
              Approve
            </button>
          </span>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>{d.title}</h1>
          <span className="zigzag" aria-hidden="true" />
          <div className="row">
            <StatusBadge status={d.status} />
            {d.referenceNo && <span className="ref">{d.referenceNo}</span>}
            <span className="muted small">
              {d.documentType.name}, {d.department.name}, from {d.sender.fullName}
            </span>
          </div>
        </div>
        <div className="row">
          {myTurn && (
            <Link className="btn btn-primary" to={`/documents/${d.id}/sign`}>
              Sign now
            </Link>
          )}
          {signed && (
            <button className="btn btn-primary" onClick={() => download(d.id, 'signed', signed)}>
              Download signed copy
            </button>
          )}
          {certificate && (
            <button className="btn btn-secondary" onClick={() => download(d.id, 'certificate', certificate)}>
              Certificate
            </button>
          )}
          {d.status === 'DRAFT' && d.isSender && (
            <>
              <Link className="btn btn-primary" to={`/documents/${d.id}/prepare`}>
                Continue preparing
              </Link>
              <button className="btn btn-danger" onClick={() => window.confirm('Delete this draft? This cannot be undone.') && deleteM.mutate()}>
                Delete draft
              </button>
            </>
          )}
          {['IN_PROGRESS', 'PENDING_APPROVAL'].includes(d.status) && d.isSender && (
            <button className="btn btn-danger" onClick={() => setVoiding(true)}>
              Cancel document
            </button>
          )}
        </div>
      </div>

      {d.status === 'DECLINED' && (
        <div className="alert alert-error">
          {signers.find((s) => s.status === 'DECLINED')?.fullName} declined: “{signers.find((s) => s.status === 'DECLINED')?.declineReason}”. To continue, correct the document and send a new one.
        </div>
      )}
      {d.status === 'VOIDED' && <div className="alert alert-warn">Cancelled by the sender: “{d.voidReason}”.</div>}
      {d.status === 'EXPIRED' && <div className="alert alert-warn">The signing links expired before everyone signed. To continue, send a new document.</div>}
      {d.purgedAt && <div className="alert alert-warn">The files of this document were deleted at the end of its retention period ({formatDate(d.purgedAt)}). The record and fingerprints remain.</div>}
      {d.status === 'PENDING_APPROVAL' && !myApproval && (
        <div className="alert alert-info">Waiting for internal approval. Signers are emailed once everyone below has approved; the reference number is given then.</div>
      )}

      <div className="doc-grid">
        <div className="stack">
        {approvers.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2>Approval</h2>
              <span className="muted small">
                {approvers.filter((a) => a.status === 'COMPLETED').length} of {approvers.length} approved
              </span>
            </div>
            <ol className="timeline-people">
              {approvers.map((r) => (
                <li key={r.id}>
                  <span className="person-step" style={{ background: r.status === 'COMPLETED' ? 'var(--ok)' : 'var(--line)' }}>
                    {r.status === 'COMPLETED' ? '✓' : r.stepOrder}
                  </span>
                  <div>
                    <b>{r.fullName}</b> <span className="muted small">{r.email}</span>
                    <div className="small">
                      <span className={r.status === 'COMPLETED' ? 'ok' : ''}>{APPROVAL_STATUS[r.status] ?? r.status}</span>
                      {r.completedAt && <span className="muted">, {formatDate(r.completedAt)}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="panel">
          <div className="panel-head">
            <h2>People</h2>
            {d.status !== 'DRAFT' && signers.length > 0 && (
              <span className="muted small">
                {done} of {signers.length} signed
              </span>
            )}
          </div>
          <ol className="timeline-people">
            {[...signers, ...d.recipients.filter((r) => r.role === 'CC')].map((r, i) => (
              <li key={r.id}>
                <span className="person-step" style={{ background: r.role === 'SIGNER' ? SIGNER_COLOURS[signers.indexOf(r) % SIGNER_COLOURS.length] : 'var(--line)' }}>
                  {r.role === 'CC' ? 'cc' : d.routingMode === 'PARALLEL' ? '•' : r.stepOrder}
                </span>
                <div>
                  <b>{r.fullName}</b> <span className="muted small">{r.email}</span>
                  {!r.isExternal && <span className="badge" style={{ marginLeft: 6 }}>Staff</span>}
                  <div className="small">
                    {r.role === 'CC' ? (
                      'Gets the signed copy'
                    ) : (
                      <>
                        <span className={r.status === 'COMPLETED' ? 'ok' : r.status === 'DECLINED' ? 'danger' : ''}>{RECIPIENT_STATUS[r.status] ?? r.status}</span>
                        {r.completedAt && <span className="muted">, {formatDate(r.completedAt)}</span>}
                        {!r.completedAt && r.viewedAt && <span className="muted">, opened {formatDate(r.viewedAt)}</span>}
                        {!r.completedAt && !r.viewedAt && r.sentAt && <span className="muted">, {formatDate(r.sentAt)}</span>}
                      </>
                    )}
                  </div>
                </div>
                {d.isSender && d.status === 'IN_PROGRESS' && ['SENT', 'VIEWED'].includes(r.status) && (
                  <button className="btn-link small" onClick={() => resendM.mutate(r.id)} disabled={resendM.isPending}>
                    Send link again
                  </button>
                )}
                {i < signers.length - 1 && <span className="sr-only">then</span>}
              </li>
            ))}
            {!signers.length && <li className="muted">No signers yet.</li>}
          </ol>
        </section>
        </div>

        <section className="panel panel-pad">
          <h2>Details</h2>
          <dl className="facts">
            {d.counterparty && (
              <>
                <dt>Supplier or partner</dt>
                <dd>{d.counterparty}</dd>
              </>
            )}
            {value && (
              <>
                <dt>Contract value</dt>
                <dd>{value}</dd>
              </>
            )}
            <dt>Sent</dt>
            <dd>{formatDate(d.sentAt)}</dd>
            <dt>Links stop working</dt>
            <dd>{formatDate(d.expiresAt)}</dd>
            {d.completedAt && (
              <>
                <dt>Completed</dt>
                <dd>{formatDate(d.completedAt)}</dd>
              </>
            )}
            <dt>Order</dt>
            <dd>{{ SEQUENTIAL: 'One after another', PARALLEL: 'All at once', MIXED: 'In groups' }[d.routingMode]}</dd>
            <dt>My folder</dt>
            <dd>
              <FolderSelect documentId={d.id} value={d.myFolderId} onChange={(f) => qc.setQueryData(['document', id], { ...d, myFolderId: f })} />
            </dd>
            <dt>Reminders</dt>
            <dd>{d.reminderEveryDays ? `Every ${d.reminderEveryDays} days until signed` : 'Off'}</dd>
          </dl>
          <h3 style={{ marginTop: 18 }}>Files</h3>
          <ul className="files">
            {d.files.map((f) => (
              <li key={f.id}>
                {d.purgedAt ? (
                  <span>{FILE_LABEL[f.kind] ?? f.kind}</span>
                ) : (
                  <button className="btn-link" onClick={() => download(d.id, f.kind.toLowerCase(), f)}>
                    {FILE_LABEL[f.kind] ?? f.kind}
                  </button>
                )}
                <span className="small muted">
                  {(f.sizeBytes / 1024).toFixed(0)} KB{f.pageCount ? `, ${f.pageCount} pages` : ''}
                </span>
                <span className="mono muted fingerprint" title="SHA-256 fingerprint">
                  {f.sha256.slice(0, 16)}…
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Activity</h2>
          <span className="muted small">Every step, with time and IP address. This record cannot be changed.</span>
        </div>
        <table className="table">
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>
                  {formatDate(e.occurredAt)}
                </td>
                <td>
                  {eventLabel(e.type, e.details)}
                  {e.type === 'recipient.declined' && <span className="muted">: “{String(e.details.reason ?? '')}”</span>}
                  {e.type === 'document.voided' && <span className="muted">: “{String(e.details.reason ?? '')}”</span>}
                  {e.type === 'approval.returned' && <span className="muted">: “{String(e.details.reason ?? '')}”</span>}
                  {e.type === 'approval.approved' && e.details.comment ? <span className="muted">: “{String(e.details.comment)}”</span> : null}
                </td>
                <td className="small">{e.actorName ?? e.actorEmail ?? (typeof e.details.name === 'string' ? `To ${e.details.name}` : 'System')}</td>
                <td className="small mono muted">{e.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {approving && (
        <Dialog title={approving === 'approve' ? 'Approve this document?' : 'Return for changes?'} onClose={() => setApproving(null)}>
          <p style={{ marginBottom: 12 }}>
            {approving === 'approve'
              ? approvers.filter((a) => a.status !== 'COMPLETED').length > 1
                ? 'The next approver is asked straight away.'
                : 'You are the last approver: the document gets its reference number and goes to the signers.'
              : `The document goes back to ${d.sender.fullName} as a draft. They correct it and send it again, and approval starts over.`}
          </p>
          <ErrorBox error={approveM.error} />
          <Field label={approving === 'approve' ? 'Comment (optional)' : 'What needs to change?'} id="cmt" hint={approving === 'approve' ? 'Kept in the activity record.' : `Sent to ${d.sender.fullName}.`}>
            <textarea id="cmt" className="input" rows={3} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <div className="row-end">
            <button className="btn btn-secondary" onClick={() => setApproving(null)}>
              Back
            </button>
            <button
              className={approving === 'approve' ? 'btn btn-primary' : 'btn btn-danger'}
              disabled={approveM.isPending || (approving === 'return' && comment.trim().length < 3)}
              onClick={() => approveM.mutate()}
            >
              {approving === 'approve' ? 'Approve' : 'Return for changes'}
            </button>
          </div>
        </Dialog>
      )}
      {voiding && (
        <Dialog title="Cancel this document?" onClose={() => setVoiding(false)}>
          <p style={{ marginBottom: 12 }}>Signing stops for everyone. People who were invited are told, and their links stop working. Signatures already given stay in the record.</p>
          <ErrorBox error={voidM.error} />
          <Field label="Why are you cancelling it?" id="why" hint="Sent to the signers.">
            <textarea id="why" className="input" rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row-end">
            <button className="btn btn-secondary" onClick={() => setVoiding(false)}>
              Keep it
            </button>
            <button className="btn btn-danger" disabled={reason.trim().length < 3 || voidM.isPending} onClick={() => voidM.mutate()}>
              Cancel document
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
