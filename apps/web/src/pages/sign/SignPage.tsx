import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, publicApi } from '../../api';
import { ErrorBox, TextField } from '../../components/ui';
import { SignSession } from './SignSession';

interface LinkInfo {
  state: 'ready' | 'completed' | 'declined' | 'voided' | 'expired' | 'waiting' | 'activate' | 'invalid';
  documentTitle?: string;
  senderName?: string;
  recipientName?: string;
  emailHint?: string;
  expiresAt?: string;
  /** Ruliba staff sign inside eSign (sign-in first), not with an emailed code. */
  staffSignPath?: string;
}

const STATE_TEXT: Record<Exclude<LinkInfo['state'], 'ready'>, [string, string]> = {
  completed: ['Already signed', 'You have signed this document. When everyone has signed, you will get the signed copy by email.'],
  declined: ['Signing has stopped', 'This document was declined, so there is nothing more to sign.'],
  voided: ['Cancelled', 'The sender cancelled this document. There is nothing to sign.'],
  expired: ['This link has expired', 'Ask the sender at Ruliba Clays to send it again.'],
  waiting: ['Not your turn yet', 'Someone else signs before you. You will get an email when it is your turn.'],
  activate: [
    'Activate your account first',
    'You were added as a Ruliba Clays eSign user. Open the "Activate my account" link in your invitation or activation email, choose your password, then come back to this link to sign.',
  ],
  invalid: ['This link does not work', 'Check that you opened the whole link from the email. If it still does not work, ask the sender to send it again.'],
};

/** Minimal frame for people outside Ruliba: logo, the task, nothing else. */
export function SignFrame({ children, footer }: { children: ReactNode; footer?: string }) {
  return (
    <div className="sign-frame">
      <header className="sign-top">
        <img src="/logo-192.png" alt="Ruliba Clays" width={44} height={44} />
        <span>
          <b>Ruliba Clays</b> eSign
        </span>
      </header>
      <main className="sign-main">{children}</main>
      <footer className="sign-foot small muted">{footer ?? 'Ruliba Clays Ltd, Kigali, Rwanda. Your actions on this page are recorded as evidence of signing.'}</footer>
    </div>
  );
}

function Finished({ result }: { result: { documentCompleted: boolean; declined?: boolean } }) {
  return (
    <section className="panel panel-pad done-card">
      <h1>{result.declined ? 'You declined to sign' : 'Thank you, you have signed'}</h1>
      <span className="zigzag" aria-hidden="true" />
      <p>
        {result.declined
          ? 'The sender has been told your reason. You can close this page.'
          : result.documentCompleted
            ? 'Everyone has now signed. The signed copy, with its signing record, is on its way to your email.'
            : 'When everyone has signed, you will get the signed copy by email. You can close this page.'}
      </p>
    </section>
  );
}

/** /sign/:token, the page an outside signer opens from the email. */
export function SignLinkPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [step, setStep] = useState<'intro' | 'code'>('intro');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [signToken, setSignToken] = useState<string | null>(null);
  const [result, setResult] = useState<{ documentCompleted: boolean; declined?: boolean } | null>(null);

  const navigate = useNavigate();
  useEffect(() => {
    publicApi<LinkInfo>(`/sign/${encodeURIComponent(token)}`).then((i) => {
      // Staff with an older emailed link: go to the document in eSign (the sign-in page comes first if needed).
      if (i.staffSignPath && i.state === 'ready' && i.staffSignPath.startsWith('/documents/')) navigate(i.staffSignPath, { replace: true });
      else setInfo(i);
    }, () => setInfo({ state: 'invalid' }));
  }, [token, navigate]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi<{ sentTo: string }>(`/sign/${encodeURIComponent(token)}/code`, {});
      setSentTo(r.sentTo);
      setStep('code');
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && step === 'intro') setStep('code');
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi<{ signToken: string }>(`/sign/${encodeURIComponent(token)}/verify`, { code: code.trim() });
      setSignToken(r.signToken);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (result) return <SignFrame><Finished result={result} /></SignFrame>;
  if (signToken) return <SignFrame><SignSession signToken={signToken} onFinished={setResult} /></SignFrame>;
  if (!info) return <SignFrame><p className="muted">Opening…</p></SignFrame>;
  if (info.state !== 'ready') {
    const [t, b] = STATE_TEXT[info.state];
    return (
      <SignFrame>
        <section className="panel panel-pad done-card">
          <h1>{t}</h1>
          <span className="zigzag" aria-hidden="true" />
          <p>{b}</p>
        </section>
      </SignFrame>
    );
  }

  return (
    <SignFrame>
      <section className="panel panel-pad intro-card">
        <p className="muted">Hello {info.recipientName},</p>
        <h1>{info.documentTitle}</h1>
        <span className="zigzag" aria-hidden="true" />
        <p>{info.senderName} of Ruliba Clays has asked you to review and sign this document. You do not need an account.</p>
        {step === 'intro' ? (
          <>
            <p className="small muted" style={{ margin: '14px 0' }}>
              First we email a 6-digit code to {info.emailHint}, so we know it is you.
            </p>
            <ErrorBox error={error} />
            <button className="btn btn-primary btn-block" onClick={sendCode} disabled={busy}>
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          </>
        ) : (
          <form onSubmit={verify} noValidate style={{ marginTop: 16 }}>
            {sentTo && <p className="small" style={{ marginBottom: 12 }}>We sent a code to {sentTo}. It works for 10 minutes. Check your spam folder if you do not see it.</p>}
            <ErrorBox error={error} />
            <TextField label="Code from the email" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Open the document'}
            </button>
            <p style={{ marginTop: 12 }}>
              <button type="button" className="btn-link small" onClick={sendCode} disabled={busy}>
                Send a new code
              </button>
            </p>
          </form>
        )}
      </section>
    </SignFrame>
  );
}

/** /documents/:id/sign, staff signing from inside the app (their two-step sign-in replaces the emailed code). */
export function StaffSignPage() {
  const { id } = useParams<{ id: string }>();
  const [signToken, setSignToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ documentCompleted: boolean; declined?: boolean } | null>(null);

  useEffect(() => {
    api<{ signToken: string }>(`/documents/${id}/sign-session`, { body: {} }).then((r) => setSignToken(r.signToken), setError);
  }, [id]);

  if (result)
    return (
      <>
        <Finished result={result} />
        <p style={{ marginTop: 16 }}>
          <Link to={`/documents/${id}`}>Back to the document</Link>
        </p>
      </>
    );
  if (error) return <ErrorBox error={error} />;
  if (!signToken) return <p className="muted">Opening…</p>;
  return <SignSession signToken={signToken} onFinished={setResult} />;
}
