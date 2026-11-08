import { passwordProblems } from '@ruliba/shared';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Session } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, PasswordField } from '../components/ui';
import { AuthFrame } from './Login';

export function PasswordForm({ onDone, submitLabel }: { onDone: (s: Session) => void; submitLabel: string }) {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const problems = next ? passwordProblems(next, user?.email) : [];
  const mismatch = again.length > 0 && again !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<Session>('/auth/password', { body: { currentPassword: current, newPassword: next } }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <ErrorBox error={error} />
      <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <PasswordField
        label="New password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        hint="At least 12 characters. A short sentence you can remember works well."
        error={problems[0]}
      />
      <PasswordField label="New password again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'The two passwords are not the same.' : undefined} />
      <button className="btn btn-primary btn-block" disabled={busy || !current || problems.length > 0 || !next || next !== again}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}

export function ChangePasswordPage() {
  const { setSession, user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthFrame>
      <div className="auth-card">
        <h1>Choose your password</h1>
        <span className="zigzag" aria-hidden="true" />
        {user && (
          <p className="lead">
            Signed in as <b>{user.fullName}</b> ({user.email}).{' '}
            <button
              type="button"
              className="btn-link"
              onClick={async () => {
                navigate('/login', { replace: true, state: null });
                await logout();
              }}
            >
              Not you? Sign out
            </button>
          </p>
        )}
        <p className="lead">Replace the temporary password you were given. Other devices will be signed out.</p>
        <PasswordForm
          submitLabel="Save password"
          onDone={(s) => {
            setSession(s);
            navigate('/', { replace: true });
          }}
        />
      </div>
    </AuthFrame>
  );
}
