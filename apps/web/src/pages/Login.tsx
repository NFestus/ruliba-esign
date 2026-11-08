import { FormEvent, ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, Session } from '../api';
import { useAuth } from '../auth';
import { MfaEnrol } from '../components/MfaEnrol';
import { ErrorBox, PasswordField, TextField } from '../components/ui';
import { RecoveryCodes } from './settings/Account';

type Step =
  | { kind: 'password' }
  | { kind: 'code'; mfaToken: string; method: 'TOTP' | 'SMS'; phoneHint?: string }
  | { kind: 'enrol'; mfaToken: string }
  | { kind: 'codes'; codes: string[]; session: Session };

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-brand" aria-hidden="true">
        <svg className="roof" viewBox="0 0 400 400">
          <path d="M20 250 L200 70 L380 250" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="46" strokeLinejoin="miter" />
          <path d="M80 380 L200 260 L320 380" fill="none" stroke="#F26B3A" strokeWidth="46" />
        </svg>
        <img src="/logo-192.png" alt="" />
        <h1>Record it.<br />Review it.<br />Sign it.</h1>
        <p>Contracts, purchase orders and forms for Ruliba Clays, signed without printing.</p>
      </section>
      <section className="auth-form">{children}</section>
    </div>
  );
}

export function LoginPage() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const activation = location.state as { activated?: boolean; reset?: boolean; email?: string } | null;
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState(activation?.email ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const goNext = (s: Session) => {
    setSession(s);
    navigate(s.user.mustChangePassword ? '/change-password' : ((location.state as { from?: string })?.from ?? '/'), { replace: true });
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<Session & { mfaRequired?: boolean; mfaSetupRequired?: boolean; mfaToken?: string; method?: 'TOTP' | 'SMS'; phoneHint?: string }>(
        '/auth/login',
        { body: { email, password } },
      );
      if (res.mfaRequired) setStep({ kind: 'code', mfaToken: res.mfaToken!, method: res.method ?? 'TOTP', phoneHint: res.phoneHint });
      else if (res.mfaSetupRequired) setStep({ kind: 'enrol', mfaToken: res.mfaToken! });
      else goNext(res);
      setPassword('');
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'code') return;
    void run(async () => goNext(await api<Session>('/auth/mfa/verify', { body: { mfaToken: step.mfaToken, code: code.trim() } })));
  };

  const resendSms = () => {
    if (step.kind !== 'code') return;
    void run(async () => {
      const r = await api<{ phoneHint: string }>('/auth/mfa/sms/resend', { body: { mfaToken: step.mfaToken } });
      setCodeNotice(`We sent a new code to ${r.phoneHint}. Only the newest code works.`);
    });
  };

  const expired = error instanceof ApiError && /timed out/.test(error.message);

  return (
    <AuthFrame>
      <div className="auth-card">
        {step.kind === 'password' && (
          <form onSubmit={submitPassword} noValidate>
            <h1>Welcome back</h1>
            <span className="zigzag" aria-hidden="true" />
            <p className="lead">Sign in with your Ruliba email.</p>
            {activation?.activated && (
              <div className="alert alert-ok" role="status">
                Your account is active. Sign in with the password you just chose{(location.state as { from?: string })?.from ? ' to open the document to sign' : ''}.
              </div>
            )}
            {activation?.reset && (
              <div className="alert alert-ok" role="status">
                Your password has been changed. Sign in with your new password.
              </div>
            )}
            <ErrorBox error={error} />
            <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <PasswordField label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="small" style={{ marginTop: 16 }}>
              <Link to="/forgot-password" state={{ email }}>
                Forgot your password?
              </Link>
            </p>
          </form>
        )}

        {step.kind === 'code' && (
          <form onSubmit={submitCode} noValidate>
            <h1>Enter your code</h1>
            <span className="zigzag" aria-hidden="true" />
            <p className="lead">
              {step.method === 'SMS'
                ? `We sent a 6-digit code by text message to ${step.phoneHint}. It works for 10 minutes.`
                : 'Open your authenticator app and type the 6-digit code for Ruliba Clays eSign.'}
            </p>
            {codeNotice && (
              <div className="alert alert-ok" role="status">
                {codeNotice}
              </div>
            )}
            <ErrorBox error={error} />
            <TextField
              label="Code"
              className="input code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint="Lost your phone? Type one of your recovery codes instead, like ABCDE-FGHIJ."
              autoFocus
            />
            <button className="btn btn-primary btn-block" disabled={busy || code.trim().length < 6}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            {step.method === 'SMS' && (
              <p style={{ marginTop: 12 }}>
                <button type="button" className="btn-link" disabled={busy} onClick={resendSms}>
                  No text message? Send a new code
                </button>
              </p>
            )}
            {expired && (
              <p style={{ marginTop: 12 }}>
                <button type="button" className="btn-link" onClick={() => { setStep({ kind: 'password' }); setError(null); setCode(''); }}>
                  Start again
                </button>
              </p>
            )}
          </form>
        )}

        {step.kind === 'enrol' && (
          <div>
            <h1>Protect your account</h1>
            <span className="zigzag" aria-hidden="true" />
            <p className="lead">Your account needs two-step sign-in: a code from your phone at every sign-in. It takes about a minute.</p>
            <MfaEnrol mfaToken={step.mfaToken} onConfirmed={(res) => setStep({ kind: 'codes', codes: res.recoveryCodes, session: res as Session })} />
          </div>
        )}

        {step.kind === 'codes' && (
          <div>
            <h1>Save your recovery codes</h1>
            <span className="zigzag" aria-hidden="true" />
            <RecoveryCodes codes={step.codes} />
            <button className="btn btn-primary btn-block" onClick={() => goNext(step.session)}>
              I have saved them
            </button>
          </div>
        )}
      </div>
    </AuthFrame>
  );
}
