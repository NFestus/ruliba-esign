import { useState } from 'react';
import { useAuth } from '../../auth';
import { MfaEnrol } from '../../components/MfaEnrol';
import { PasswordForm } from '../ChangePassword';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginBottom: 20 }}>
      <p className="lead muted" style={{ marginBottom: 12 }}>
        If you lose your phone, each of these codes lets you sign in once. Print them or keep them somewhere safe, away from your phone. They will not be shown again.
      </p>
      <div className="codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </div>
  );
}

function MfaSetup() {
  const { user, setUser } = useAuth();
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!user) return null;

  if (codes) return <RecoveryCodes codes={codes} />;
  if (user.mfaEnabled)
    return (
      <p>
        <span className="badge badge-ok">On</span> Two-step sign-in is on, with {user.mfaMethod === 'SMS' ? 'codes by text message' : 'an authenticator app'}. To change phone or
        method, ask an administrator to reset it, then set it up again.
      </p>
    );

  return enrolling ? (
    <MfaEnrol
      onCancel={() => setEnrolling(false)}
      onConfirmed={(res) => {
        setCodes(res.recoveryCodes);
        setUser({ ...user, mfaEnabled: true });
      }}
    />
  ) : (
    <div>
      <p style={{ marginBottom: 14 }}>
        <span className="badge badge-off">Off</span> Add a code from your phone to every sign-in, so a stolen password alone is not enough. You can use an authenticator app or
        text messages.
      </p>
      <button className="btn btn-secondary" onClick={() => setEnrolling(true)}>
        Turn on two-step sign-in
      </button>
    </div>
  );
}

export function AccountPage() {
  const { user, setSession } = useAuth();
  const [saved, setSaved] = useState(false);
  if (!user) return null;
  return (
    <div className="grid-2">
      <section className="panel panel-pad">
        <h2>Two-step sign-in</h2>
        <div style={{ marginTop: 14 }}>
          <MfaSetup />
        </div>
      </section>
      <section className="panel panel-pad">
        <h2>Password</h2>
        <p className="muted small" style={{ margin: '6px 0 16px' }}>Changing it signs you out on your other devices.</p>
        {saved && <div className="alert alert-ok">Password changed.</div>}
        <PasswordForm
          submitLabel="Change password"
          onDone={(s) => {
            setSession(s);
            setSaved(true);
          }}
        />
      </section>
    </div>
  );
}
