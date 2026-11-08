import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { formatDate } from '../../components/ui';
import { eventLabel } from '../../labels';

interface Event {
  id: number;
  occurredAt: string;
  type: string;
  actorEmail: string | null;
  actorName: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  hash: string;
}

/** Plain-language names for event types. Unknown types fall back to their code. */
const LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Sign-in failed',
  'auth.account_locked': 'Account locked after failed sign-ins',
  'auth.password_ok_mfa_pending': 'Password accepted, code requested',
  'auth.password_ok_mfa_setup_pending': 'Password accepted, two-step set-up requested',
  'auth.mfa_enrolled': 'Turned on two-step sign-in',
  'auth.mfa_failed': 'Wrong two-step code',
  'auth.mfa_recovery_code_used': 'Used a recovery code',
  'auth.password_changed': 'Changed password',
  'auth.password_change_failed': 'Password change refused',
  'auth.refresh_token_reuse': 'Copied session detected and ended',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'user.password_reset': 'Reset a password',
  'user.mfa_reset': 'Reset two-step sign-in',
  'setup.department_created': 'Added a department',
  'setup.department_updated': 'Changed a department',
  'setup.document_type_created': 'Added a document type',
  'setup.document_type_updated': 'Changed a document type',
  'setup.approval_policy_created': 'Added an approval chain',
  'setup.approval_policy_changed': 'Changed an approval chain',
  'setup.approval_settings_changed': 'Changed the approval currency',
  'system.first_admin_created': 'First administrator created',
  'system.audit_chain_ok': 'Nightly check: activity log intact',
  'system.audit_chain_broken': 'Nightly check: activity log changed',
};

export function ActivityPage() {
  const events = useQuery({ queryKey: ['audit'], queryFn: () => api<Event[]>('/audit/events?limit=100') });
  const check = useMutation({ mutationFn: () => api<{ ok: boolean; checked: number; brokenAtId?: number; reason?: string }>('/audit/verify') });

  return (
    <div className="stack">
      <section className="panel panel-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Is the log intact?</h2>
            <p className="muted small" style={{ maxWidth: '62ch' }}>
              Each entry is linked to the one before it by a fingerprint. Changing or removing any past entry breaks every link after it. This check re-reads the whole log. It also runs every night.
            </p>
          </div>
          <button className="btn btn-secondary" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? 'Checking…' : 'Check the log now'}
          </button>
        </div>
        {check.data && (
          <div className={`alert ${check.data.ok ? 'alert-ok' : 'alert-error'}`} style={{ marginTop: 14, marginBottom: 0 }}>
            {check.data.ok
              ? `Intact. All ${check.data.checked} entries match their fingerprints.`
              : `Entry ${check.data.brokenAtId} does not match: ${check.data.reason}. Tell the IT office and management now.`}
          </div>
        )}
      </section>
      <section className="panel">
        <table className="table">
          <thead>
            <tr><th>When</th><th>What happened</th><th>Who</th><th>From</th><th>Fingerprint</th></tr>
          </thead>
          <tbody>
            {events.data?.map((e) => (
              <tr key={e.id}>
                <td className="small">{formatDate(e.occurredAt)}</td>
                <td>{LABELS[e.type] ?? eventLabel(e.type, e.details)}</td>
                <td className="small">{e.actorName ?? e.actorEmail ?? 'System'}</td>
                <td className="small mono">{e.ip ?? ''}</td>
                <td className="mono muted" title={e.hash}>{e.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
