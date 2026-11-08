import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { ErrorBox, formatDate } from '../../components/ui';

interface Cert {
  id: string;
  kind: 'AUTHORITY' | 'ORGANIZATION_SEAL' | string;
  level: string;
  holderName: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

const KIND: Record<string, string> = { AUTHORITY: 'Authority (issues the seal)', ORGANIZATION_SEAL: 'Document seal (signs every completed document)' };

/** Ruliba's platform signing certificates, and how to make Adobe Reader trust them. */
export function SigningPage() {
  const q = useQuery({ queryKey: ['signing-certificates'], queryFn: () => api<Cert[]>('/signing/certificates') });
  return (
    <div className="stack">
      <section className="panel panel-pad">
        <h2>Digital seal</h2>
        <p style={{ marginTop: 8 }}>
          Every completed document and certificate is digitally sealed by Ruliba Clays Ltd. If anyone changes the file afterwards, PDF readers show the seal as broken, and
          “Check a document” no longer finds it.
        </p>
        <p className="small muted" style={{ marginTop: 8 }}>
          This seal is Ruliba's own (platform level). It proves the file came from this system unchanged; it is not a certificate from a licensed Rwandan certification authority.
          For documents that the law or a counterparty requires to carry a certified signature, keep using the paper process or a GovCA certificate.
        </p>
        <p style={{ marginTop: 12 }}>
          <a className="btn btn-secondary" href="/api/verify/authority-certificate">
            Download the authority certificate
          </a>
        </p>
        <p className="small muted" style={{ marginTop: 8 }}>
          To make Adobe Reader show the seal as trusted on Ruliba computers: Edit, Preferences, Signatures, Identities and Trusted Certificates, More, Import, choose this file, then
          tick “Use this certificate as a trusted root”. The IT office can push this to all computers.
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Certificates</h2>
          <span className="muted small">Created automatically. Private keys are stored encrypted and never leave the server.</span>
        </div>
        <ErrorBox error={q.error} />
        <table className="table">
          <thead>
            <tr>
              <th>Certificate</th>
              <th>Valid</th>
              <th>Fingerprint (SHA-256)</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((c) => (
              <tr key={c.id}>
                <td>
                  <b>{c.holderName}</b>
                  <span className="small muted" style={{ display: 'block' }}>
                    {KIND[c.kind] ?? c.kind}
                    {c.revokedAt ? `, withdrawn ${formatDate(c.revokedAt)}` : ''}
                  </span>
                </td>
                <td className="small">
                  {formatDate(c.notBefore).split(',')[0]} to {formatDate(c.notAfter).split(',')[0]}
                </td>
                <td className="mono small muted" style={{ wordBreak: 'break-all' }}>
                  {c.fingerprintSha256.match(/.{1,2}/g)?.join(':').toUpperCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
