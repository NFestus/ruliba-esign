import { Inject, Injectable, Logger } from '@nestjs/common';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import forge from 'node-forge';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { AuditService } from '../audit/audit.service';
import { CryptoService, sha256Hex } from '../common/crypto.service';
import { Database, DbService } from '../db/db';
import { signingCertificates } from '../db/schema';

const LOCK = 7_204_212;
const AUTHORITY_NAME = 'Ruliba Clays eSign Authority';
const SEAL_NAME = 'Ruliba Clays Ltd - Document Seal';

/**
 * Platform signatures (Phase 3): Ruliba's own certificate authority and an organisation seal.
 *
 * On first use, a root certificate ("Ruliba Clays eSign Authority", 10 years) and a seal certificate
 * issued by it (3 years) are created. Private keys are stored encrypted with the master key.
 * Every completed document is digitally signed with the seal, so any later change shows in
 * Adobe Reader as "modified after signing". To make Adobe show the seal as trusted on Ruliba's
 * computers, add the authority certificate to their trusted list (admin guide).
 *
 * This is NOT a licensed certification authority under Law 18/2010; the GovCA option (national
 * certificates) is a separate signature level, switched on once Ruliba receives its certificate.
 */
@Injectable()
export class SealService {
  private readonly log = new Logger('Seal');
  private readonly db: Database;

  constructor(
    @Inject(DbService) dbs: { db: Database },
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {
    this.db = dbs.db;
  }

  /** Returns the current seal (creating the authority and seal the first time). */
  private async currentSeal() {
    const now = new Date();
    const find = () =>
      this.db.query.signingCertificates.findFirst({
        where: and(eq(signingCertificates.kind, 'ORGANIZATION_SEAL'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)),
        orderBy: (c, { desc }) => desc(c.notBefore),
      });
    const existing = await find();
    if (existing) return existing;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
      const again = await tx.query.signingCertificates.findFirst({
        where: and(eq(signingCertificates.kind, 'ORGANIZATION_SEAL'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)),
      });
      if (again) return again;

      let ca = await tx.query.signingCertificates.findFirst({ where: and(eq(signingCertificates.kind, 'AUTHORITY'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)) });
      if (!ca) {
        const made = makeCertificate({ commonName: AUTHORITY_NAME, years: 10, isCa: true });
        [ca] = await tx.insert(signingCertificates).values(this.row('AUTHORITY', AUTHORITY_NAME, made)).returning();
        await this.audit.record({ type: 'signing.authority_created', details: { fingerprint: made.fingerprint, notAfter: made.notAfter.toISOString() } }, tx);
      }
      const caKey = this.crypto.decryptSecret(ca.privateKeyEnc!, `cert:${ca.serialNumber}`);
      const made = makeCertificate({ commonName: SEAL_NAME, years: 3, isCa: false, issuer: { certPem: ca.certPem, keyPem: caKey } });
      const [seal] = await tx.insert(signingCertificates).values(this.row('ORGANIZATION_SEAL', SEAL_NAME, made)).returning();
      await this.audit.record({ type: 'signing.seal_created', details: { fingerprint: made.fingerprint, notAfter: made.notAfter.toISOString(), issuer: ca.fingerprintSha256 } }, tx);
      this.log.log(`Created seal certificate ${made.fingerprint}`);
      return seal;
    });
  }

  private row(kind: 'AUTHORITY' | 'ORGANIZATION_SEAL', name: string, m: ReturnType<typeof makeCertificate>) {
    return {
      kind,
      level: 'PLATFORM' as const,
      holderName: name,
      serialNumber: m.serial,
      fingerprintSha256: m.fingerprint,
      certPem: m.certPem,
      privateKeyEnc: this.crypto.encryptSecret(m.keyPem, `cert:${m.serial}`),
      notBefore: m.notBefore,
      notAfter: m.notAfter,
    };
  }

  async authority() {
    await this.currentSeal();
    const ca = await this.db.query.signingCertificates.findFirst({ where: and(eq(signingCertificates.kind, 'AUTHORITY'), isNull(signingCertificates.revokedAt)), orderBy: (c, { desc }) => desc(c.notBefore) });
    return ca!;
  }

  /** Digitally signs a finished PDF with the organisation seal (PKCS#7 detached, SHA-256). */
  async seal(pdf: Buffer, reason: string): Promise<{ sealed: Buffer; certificateFingerprint: string }> {
    const seal = await this.currentSeal();
    const ca = await this.db.query.signingCertificates.findFirst({ where: eq(signingCertificates.kind, 'AUTHORITY'), orderBy: (c, { desc }) => desc(c.notBefore) });
    const key = this.crypto.decryptSecret(seal.privateKeyEnc!, `cert:${seal.serialNumber}`);
    const passphrase = randomBytes(18).toString('base64url');
    const p12 = toP12(key, [seal.certPem, ca!.certPem], passphrase);

    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    pdflibAddPlaceholder({
      pdfDoc: doc,
      reason,
      contactInfo: 'sign@ruliba.com',
      name: 'Ruliba Clays Ltd',
      location: 'Kigali, Rwanda',
      signatureLength: 12_000,
      appName: 'Ruliba Clays eSign',
    });
    const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));
    const sealed = await signpdf.sign(withPlaceholder, new P12Signer(p12, { passphrase }));
    return { sealed, certificateFingerprint: seal.fingerprintSha256 };
  }
}

function serialHex() {
  const b = randomBytes(16);
  b[0] &= 0x7f; // positive
  return b.toString('hex');
}

/** RSA-3072 key (Node's crypto, fast) and an X.509 certificate built with node-forge. */
export function makeCertificate(o: { commonName: string; years: number; isCa: boolean; issuer?: { certPem: string; keyPem: string } }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = serialHex();
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + o.years);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const subject = [
    { name: 'commonName', value: o.commonName },
    { name: 'organizationName', value: 'Ruliba Clays Ltd' },
    { name: 'localityName', value: 'Kigali' },
    { name: 'countryName', value: 'RW' },
  ];
  cert.setSubject(subject);
  const issuerCert = o.issuer ? forge.pki.certificateFromPem(o.issuer.certPem) : null;
  cert.setIssuer(issuerCert ? issuerCert.subject.attributes : subject);
  cert.setExtensions(
    o.isCa
      ? [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
          { name: 'subjectKeyIdentifier' },
        ]
      : [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
          { name: 'subjectKeyIdentifier' },
        ],
  );
  const signingKey = forge.pki.privateKeyFromPem(o.issuer ? o.issuer.keyPem : keyPem);
  cert.sign(signingKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { certPem, keyPem, serial: cert.serialNumber, fingerprint: sha256Hex(der), notBefore, notAfter };
}

function toP12(keyPem: string, chainPem: string[], passphrase: string): Buffer {
  const key = forge.pki.privateKeyFromPem(keyPem);
  const chain = chainPem.map((p) => forge.pki.certificateFromPem(p));
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, chain, passphrase, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}
