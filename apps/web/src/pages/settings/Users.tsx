import { ROLE_LABELS, ROLES, Role } from '@ruliba/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { IconPlus, IconSearch } from '../../components/icons';
import { mfaMethodLabel } from '../../components/MfaEnrol';
import { Dialog, ErrorBox, Field, formatDate, TextField } from '../../components/ui';

export interface Department {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED';
  departmentId: string | null;
  department: { code: string; name: string } | null;
  roles: Role[];
  mfaEnabled: boolean;
  mfaMethod: 'TOTP' | 'SMS' | null;
  mfaRequired: boolean;
  mfaRoleRequired: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  activatedAt: string | null;
}

export function useDepartments() {
  return useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
}

type SaveResult = { user?: UserRow; activationExpiresAt?: string };

function UserForm({ initial, onSaved, onCancel }: { initial?: UserRow; onSaved: (r: SaveResult) => void; onCancel: () => void }) {
  const depts = useDepartments();
  const qc = useQueryClient();
  const [email, setEmail] = useState(initial?.email ?? '');
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [jobTitle, setJobTitle] = useState(initial?.jobTitle ?? '');
  const [departmentId, setDepartmentId] = useState(initial?.departmentId ?? '');
  const [roles, setRoles] = useState<Role[]>(initial?.roles ?? ['SENDER', 'SIGNER']);
  const [mfaRequired, setMfaRequired] = useState(initial?.mfaRequired ?? false);
  const roleNeedsMfa = roles.includes('ADMIN') || roles.includes('AUDITOR');
  const save = useMutation({
    mutationFn: () => {
      const body = { fullName, jobTitle: jobTitle || null, departmentId: departmentId || null, roles, mfaRequired };
      return initial
        ? api(`/users/${initial.id}`, { method: 'PATCH', body })
        : api<SaveResult>('/users', { body: { ...body, email } });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onSaved(r as SaveResult);
    },
  });
  const err = save.error instanceof ApiError ? save.error : null;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorBox error={save.error} />
      {!initial && (
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={err?.fieldError('email')}
          hint="We email an activation link here. The account works once they open it and choose a password."
          required
        />
      )}
      <TextField label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={err?.fieldError('fullName')} required />
      <TextField label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} hint="For example: Procurement Manager" />
      <Field label="Department" id="dept">
        <select id="dept" className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">None</option>
          {depts.data?.filter((d) => d.active).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.code})
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ font: '600 14px var(--font-head)', marginBottom: 8 }}>What they can do</legend>
        <div className="checks">
          {ROLES.map((r) => (
            <label key={r}>
              <input
                type="checkbox"
                checked={roles.includes(r)}
                onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
              />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
        {err?.fieldError('roles') && <span className="error">{err.fieldError('roles')}</span>}
      </fieldset>
      <div className="field">
        <label className="checks">
          <input type="checkbox" checked={mfaRequired || roleNeedsMfa} disabled={roleNeedsMfa} onChange={(e) => setMfaRequired(e.target.checked)} />
          Require two-step sign-in
        </label>
        <span className="hint">
          {roleNeedsMfa
            ? 'Always on for Administrators and Auditors.'
            : 'They set it up at their next sign-in, with an authenticator app or text messages. Anyone can also turn it on themselves.'}
        </span>
      </div>
      <div className="row-end">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={save.isPending || roles.length === 0}>
          {initial ? 'Save changes' : 'Add user'}
        </button>
      </div>
    </form>
  );
}

export function UsersPage() {
  const { hasRole, user: me } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users', q], queryFn: () => api<UserRow[]>(`/users?q=${encodeURIComponent(q)}`) });
  const isAdmin = hasRole('ADMIN');

  const act = useMutation({
    mutationFn: ({ u, action }: { u: UserRow; action: 'reset-password' | 'reset-mfa' | 'resend-activation' | 'disable' | 'enable' }) =>
      action === 'disable' || action === 'enable'
        ? api(`/users/${u.id}`, { method: 'PATCH', body: { status: action === 'disable' ? 'DISABLED' : 'ACTIVE' } })
        : api<{ email?: string }>(`/users/${u.id}/${action}`, { body: {} }),
    onSuccess: (r, { u, action }) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      if (action === 'reset-password') setNotice(`${u.fullName}'s old password no longer works. We emailed them a link to choose a new one (it works for one hour).`);
      if (action === 'resend-activation') setNotice(`We emailed a new activation link to ${u.email}. Earlier links no longer work.`);
      if (action === 'enable' && !u.activatedAt) setNotice(`${u.fullName} never activated their account. Use "Resend activation email" to send them a new link.`);
      if (action === 'reset-mfa') setNotice(`${u.fullName} will set up two-step sign-in again at their next sign-in.`);
      if (action === 'disable') setNotice(`${u.fullName} can no longer sign in. Their signed documents stay valid.`);
      setEditing(null);
    },
  });

  return (
    <>
      {notice && <div className="alert alert-ok">{notice}</div>}
      <ErrorBox error={act.error} />
      <section className="panel">
        <div className="filters">
          <label className="search">
            <span className="sr-only">Search people</span>
            <IconSearch />
            <input className="input" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> Add user
            </button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Department</th>
              <th>Roles</th>
              <th>Two-step</th>
              <th>Last sign-in</th>
              {isAdmin && <th><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.fullName}</b> {u.status === 'DISABLED' && <span className="badge">Disabled</span>}
                  {u.status === 'PENDING' && <span className="badge badge-off">Waiting for activation</span>}
                  <div className="sub">{u.email}</div>
                </td>
                <td>{u.department?.name ?? <span className="muted">None</span>}</td>
                <td className="small">{u.roles.map((r) => ROLE_LABELS[r]).join(', ')}</td>
                <td>
                  {u.mfaEnabled ? <span className="badge badge-ok">{mfaMethodLabel(u.mfaMethod)}</span> : <span className="badge badge-off">Off</span>}
                  {!u.mfaEnabled && (u.mfaRequired || u.mfaRoleRequired) && <div className="sub">Required at next sign-in</div>}
                </td>
                <td className="small">{!u.lastLoginAt ? 'Not yet' : formatDate(u.lastLoginAt)}</td>
                {isAdmin && (
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-link" onClick={() => setEditing(u)}>
                      Manage
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {users.data?.length === 0 && <p className="empty">No one matches “{q}”.</p>}
      </section>

      {adding && (
        <Dialog title="Add a user" onClose={() => setAdding(false)}>
          <UserForm
            onCancel={() => setAdding(false)}
            onSaved={(r) => {
              setAdding(false);
              if (r.user)
                setNotice(
                  `We emailed an activation link to ${r.user.email}. ${r.user.fullName} can sign in after opening it and choosing a password${
                    r.activationExpiresAt ? ` (the link works until ${formatDate(r.activationExpiresAt)})` : ''
                  }.`,
                );
            }}
          />
        </Dialog>
      )}
      {editing && (
        <Dialog title={editing.fullName} onClose={() => setEditing(null)}>
          <UserForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} />
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
          <div className="stack" style={{ gap: 10 }}>
            {editing.status === 'PENDING' ? (
              <button className="btn btn-secondary" onClick={() => act.mutate({ u: editing, action: 'resend-activation' })}>
                Resend activation email
              </button>
            ) : (
              <button className="btn btn-secondary" disabled={editing.status === 'DISABLED'} onClick={() => act.mutate({ u: editing, action: 'reset-password' })}>
                Reset password (emails a link)
              </button>
            )}
            {editing.mfaEnabled && (
              <button className="btn btn-secondary" onClick={() => act.mutate({ u: editing, action: 'reset-mfa' })}>
                Reset two-step sign-in (lost phone)
              </button>
            )}
            {editing.id !== me?.id &&
              (editing.status !== 'DISABLED' ? (
                <button className="btn btn-danger" onClick={() => act.mutate({ u: editing, action: 'disable' })}>
                  Disable account
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={() => act.mutate({ u: editing, action: 'enable' })}>
                  Enable account
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </>
  );
}
