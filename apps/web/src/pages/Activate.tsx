import { passwordProblems } from '@ruliba/shared';
import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, PasswordField, TextField } from '../components/ui';
import { AuthFrame } from './Login';

/**
 * A page opened from an emailed one-use link where the person chooses a password:
 * account activation (new user) or password reset. Afterwards they continue to the sign-in page.
 */
function LinkPasswordPage({ mode }: { mode: 'activate' | 'reset' }) {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  // From a signing invitation: after activating and signing in, go straight to the document.
  const nextPath = useSearchParams()[0].get('next');
  const from = nextPath && /^\/documents\/[0-9a-f-]{36}\/sign$/.test(nextPath) ? nextPath : undefined;
  const base = mode === 'activate' ? '/auth/activation' : '/auth/password/reset';
  const info = useQuery({
    queryKey: [mode, token],
    queryFn: () => api<{ email: string; fullName: string }>(`${base}/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const email = info.data?.email;
  const problems = next ? passwordProblems(next, email) : [];
  const mismatch = again.length > 0 && again !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string }>(mode === 'activate' ? '/auth/activate' : '/auth/password/reset', { body: { token, newPassword: next } });
      navigate('/login', { replace: true, state: { [mode === 'activate' ? 'activated' : 'reset']: true, email: res.email, from } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <div className="auth-card">
        <h1>{mode === 'activate' ? 'Activate your account' : 'Choose a new password'}</h1>
        <span className="zigzag" aria-hidden="true" />
        {info.isPending && <p className="lead">Checking your link…</p>}
        {info.isError && (
          <>
            <ErrorBox error={info.error} />
            <p className="muted small">
              {mode === 'activate' ? (
                <>
                  Already activated? <Link to="/login">Sign in</Link>.
                </>
              ) : (
                <>
                  <Link to="/forgot-password">Ask for a new link</Link> or <Link to="/login">sign in</Link>.
                </>
              )}
            </p>
          </>
        )}
        {info.data && (
          <form onSubmit={submit} noValidate>
            <p className="lead">
              {mode === 'activate' ? `Welcome, ${info.data.fullName}. Choose the password you will use to sign in as ` : `${info.data.fullName}, choose a new password for `}
              <b>{info.data.email}</b>.{mode === 'reset' && ' You will be signed out on every device.'}
            </p>
            <ErrorBox error={error} />
            <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              hint="At least 12 characters. A short sentence you can remember works well."
              error={problems[0]}
              autoFocus
            />
            <PasswordField
              label="New password again"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              error={mismatch ? 'The two passwords are not the same.' : undefined}
            />
            <button className="btn btn-primary btn-block" disabled={busy || !next || problems.length > 0 || next !== again}>
              {busy ? 'Saving…' : mode === 'activate' ? 'Activate account' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}

export function ActivatePage() {
  return <LinkPasswordPage mode="activate" />;
}

export function ResetPasswordPage() {
  return <LinkPasswordPage mode="reset" />;
}

/** "Forgot your password?": asks for the email and always gives the same answer. */
export function ForgotPasswordPage() {
  const location = useLocation();
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/forgot', { body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <div className="auth-card">
        <h1>Forgot your password?</h1>
        <span className="zigzag" aria-hidden="true" />
        {sent ? (
          <>
            <div className="alert alert-ok" role="status">
              If <b>{email}</b> has an eSign account, we have emailed it a link to choose a new password. The link works for one hour. Check your spam folder too.
            </div>
            <p className="small">
              <Link to="/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="lead">Enter your Ruliba email. We will send you a link to choose a new password.</p>
            <ErrorBox error={error} />
            <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <button className="btn btn-primary btn-block" disabled={busy || !email}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <p className="small" style={{ marginTop: 16 }}>
              <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}
