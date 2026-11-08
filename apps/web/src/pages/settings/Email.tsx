import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api';
import { ErrorBox, TextField } from '../../components/ui';

const RECORDS: { name: string; type: string; value: string; why: string }[] = [
  {
    name: 'ruliba.com',
    type: 'TXT (SPF)',
    value: 'v=spf1 include:spf.protection.outlook.com -all',
    why: 'Says Microsoft 365 may send for ruliba.com. Only one SPF record is allowed: if one exists, add the include to it. While eSign still sends through another SMTP service, add that service\'s include too.',
  },
  {
    name: 'selector1._domainkey and selector2._domainkey',
    type: 'CNAME (DKIM)',
    value: 'The two values shown in Microsoft Defender, Email authentication settings, DKIM, ruliba.com',
    why: 'Signs every email so receivers can check it really came from ruliba.com and was not changed. Create both CNAMEs, then click "Enable" in Defender.',
  },
  {
    name: '_dmarc.ruliba.com',
    type: 'TXT (DMARC)',
    value: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@ruliba.com',
    why: 'Tells Gmail, Outlook and others what to do with mail that fails the checks, and sends you reports. After 2–4 weeks of clean reports, change p=none to p=quarantine.',
  },
];

/** Settings > Email (administrators): test delivery and the ruliba.com records that keep eSign mail out of spam. */
export function EmailPage() {
  const [to, setTo] = useState('');
  const send = useMutation({ mutationFn: () => api<{ queued: boolean; transport: string; from: string }>('/settings/test-email', { body: { to: to.trim() } }) });

  return (
    <div className="stack">
      <section className="panel panel-pad">
        <h2>Send a test email</h2>
        <p className="muted small" style={{ maxWidth: 680, marginTop: 6 }}>
          Send one to a Gmail address, an Outlook.com address and a supplier you trust, then check that it arrives in the inbox and not in spam. In Gmail, "Show original" should
          say <b>SPF: PASS</b>, <b>DKIM: PASS</b> and <b>DMARC: PASS</b>.
        </p>
        <form
          className="row"
          style={{ marginTop: 12, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <div style={{ flex: 1, maxWidth: 360 }}>
            <TextField label="Send to" type="email" placeholder="someone@gmail.com" value={to} maxLength={254} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button className="btn btn-primary" style={{ marginBottom: 16 }} disabled={!to.trim() || send.isPending}>
            Send test email
          </button>
        </form>
        <ErrorBox error={send.error} />
        {send.data && (
          <div className="alert alert-ok" role="status">
            Sent from {send.data.from} through {send.data.transport}. It should arrive within a minute. If it does not, look at the worker window or log.
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Before go-live: ruliba.com email records</h2>
          <span className="muted small">Set by whoever manages the ruliba.com DNS. Without them, invitations are likely to go to spam.</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {RECORDS.map((r) => (
              <tr key={r.type}>
                <td className="small" style={{ verticalAlign: 'top' }}>
                  <b>{r.name}</b>
                </td>
                <td className="small" style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                  {r.type}
                </td>
                <td className="small">
                  {r.value.startsWith('v=') ? (
                    <code className="mono" style={{ wordBreak: 'break-all' }}>
                      {r.value}
                    </code>
                  ) : (
                    <span>{r.value}</span>
                  )}
                  <div className="muted" style={{ marginTop: 4 }}>
                    {r.why}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel panel-pad">
        <h2>Also</h2>
        <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7, marginTop: 8 }}>
          <li>Send from the real shared mailbox sign@ruliba.com, not a personal or Gmail account.</li>
          <li>Ask the first suppliers to add sign@ruliba.com to their contacts or safe senders.</li>
          <li>Do not send large bulk batches on the first day; mail providers trust a new sender gradually.</li>
          <li>Keep the Graph client secret renewed (12 months), or emails stop altogether.</li>
        </ul>
      </section>
    </div>
  );
}
