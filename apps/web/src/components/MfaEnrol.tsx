import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api, Session } from '../api';
import { ErrorBox, TextField } from './ui';

export type MfaConfirmResult = { recoveryCodes: string[] } & Partial<Session>;

type Stage =
  | { kind: 'choose' }
  | { kind: 'app'; qr: string; secret: string }
  | { kind: 'phone' }
  | { kind: 'sms'; phone: string; hint: string };

/**
 * Turning on two-step sign-in: the person chooses an authenticator app or text messages (SMS).
 * Used at sign-in (with the set-up token) and from "Your account" (signed in).
 */
export function MfaEnrol({ mfaToken, onConfirmed, onCancel }: { mfaToken?: string; onConfirmed: (r: MfaConfirmResult) => void; onCancel?: () => void }) {
  const options = useQuery({ queryKey: ['mfa-options'], queryFn: () => api<{ app: boolean; sms: boolean }>('/auth/mfa/options') });
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  const startApp = () =>
    run(async () => {
      const r = await api<{ qrDataUrl: string; secret: string }>('/auth/mfa/setup', { body: mfaToken ? { mfaToken } : {} });
      setCode('');
      setStage({ kind: 'app', qr: r.qrDataUrl, secret: r.secret });
    });

  const sendSms = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      const r = await api<{ phoneHint: string }>('/auth/mfa/sms/setup', { body: { ...(mfaToken ? { mfaToken } : {}), phone } });
      setCode('');
      setNotice(`We sent a 6-digit code by text message to ${r.phoneHint}.`);
      setStage({ kind: 'sms', phone, hint: r.phoneHint });
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onConfirmed(await api<MfaConfirmResult>('/auth/mfa/confirm', { body: { ...(mfaToken ? { mfaToken } : {}), code: code.trim() } })));
  };

  const back = () => {
    setStage({ kind: 'choose' });
    setError(null);
    setNotice(null);
  };

  if (stage.kind === 'choose')
    return (
      <div>
        <p style={{ marginBottom: 12 }}>How would you like to get your sign-in codes?</p>
        <ErrorBox error={error} />
        <div className="stack" style={{ gap: 10 }}>
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => void startApp()}>
            Authenticator app (recommended)
          </button>
          {options.data?.sms && (
            <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => setStage({ kind: 'phone' })}>
              Text message (SMS) to my phone
            </button>
          )}
          {onCancel && (
            <button type="button" className="btn-link" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          An app works without phone signal and cannot be redirected to another SIM card, so it is the safer choice.
        </p>
      </div>
    );

  if (stage.kind === 'phone')
    return (
      <form onSubmit={sendSms} noValidate>
        <ErrorBox error={error} />
        <TextField
          label="Mobile number"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          hint="For example +250 788 123 456. A Rwandan number starting with 07 also works."
          autoFocus
        />
        <div className="row-end">
          <button type="button" className="btn btn-secondary" onClick={back}>
            Back
          </button>
          <button className="btn btn-primary" disabled={busy || phone.trim().length < 8}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </div>
      </form>
    );

  return (
    <form onSubmit={confirm} noValidate>
      {stage.kind === 'app' ? (
        <>
          <ol className="steps">
            <li>Install Microsoft Authenticator or Google Authenticator on your phone.</li>
            <li>In the app, add an account and scan this code.</li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <img className="qr" src={stage.qr} width={200} height={200} alt="QR code to add Ruliba Clays eSign to your authenticator app" />
          <details className="small" style={{ marginBottom: 16 }}>
            <summary>Can't scan? Type this key instead</summary>
            <div className="secret-box" style={{ marginTop: 8 }}>{stage.secret.match(/.{1,4}/g)?.join(' ')}</div>
          </details>
        </>
      ) : (
        notice && (
          <div className="alert alert-ok" role="status">
            {notice}
          </div>
        )
      )}
      <ErrorBox error={error} />
      <TextField
        label={stage.kind === 'app' ? 'Code from the app' : 'Code from the text message'}
        className="input code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus={stage.kind === 'sms'}
      />
      <button className="btn btn-primary btn-block" disabled={busy || code.trim().length !== 6}>
        {busy ? 'Checking…' : 'Turn on two-step sign-in'}
      </button>
      <p className="small" style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {stage.kind === 'sms' && (
          <button type="button" className="btn-link" disabled={busy} onClick={() => void sendSms()}>
            Send a new code
          </button>
        )}
        <button type="button" className="btn-link" onClick={back}>
          Choose another way
        </button>
      </p>
    </form>
  );
}

export function mfaMethodLabel(method: string | null | undefined) {
  return method === 'SMS' ? 'Text message' : method === 'TOTP' ? 'Authenticator app' : '';
}
