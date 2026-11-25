import { Inject, Injectable, Logger } from '@nestjs/common';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import signpdf from '@signpdf/signpdf';
import { Signer } from '@signpdf/utils';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import forge from 'node-forge';
import { constants, createPrivateKey, generateKeyPairSync, privateEncrypt, randomBytes } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { AuditService } from '../audit/audit.service';
import { CryptoService, sha256Hex } from '../common/crypto.service';
import { AppConfig, CONFIG } from '../config';
import { Database, DbService } from '../db/db';
import { signingCertificates } from '../db/schema';
import { nul, octets, oid, OID, parseCert, seq } from './der';
import { appendDss, certDer, makeCrl, revocationData } from './ltv';
import { addSignatureTimestamp, TimestampToken } from './timestamp';

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
 * Each seal carries a trusted timestamp from an independent authority (TSA_URL), and the file
 * stores the certificate chains and revocation lists needed to check it years later (long-term
 * validation). Ruliba's authority publishes its revocation list at /api/verify/crl.
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
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'APP_URL' | 'TSA_URL'>,
  ) {
    this.db = dbs.db;
  }

  /** Where Ruliba's revocation list is published; written into every new seal certificate. */
  private get crlUrl() {
    return `${this.config.APP_URL.replace(/\/$/, '')}/api/verify/crl`;
  }

  /** Seals made before long-term validation have no revocation list address; a new one replaces them. */
  private hasCrlAddress(certPem: string) {
    return parseCert(certDer(certPem)).extensions.has(OID.crlDistributionPoints);
  }

  /** Returns the current seal (creating the authority and seal the first time). */
  private async currentSeal() {
    const now = new Date();
    // The newest valid seal that has a revocation list address (older ones are left for old documents).
    const usable = async (q: Pick<Database, 'query'>) =>
      (
        await q.query.signingCertificates.findMany({
          where: and(eq(signingCertificates.kind, 'ORGANIZATION_SEAL'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)),
          orderBy: (c, { desc }) => desc(c.notBefore),
        })
      ).find((c) => this.hasCrlAddress(c.certPem));
    const existing = await usable(this.db);
    if (existing) return existing;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
      const again = await usable(tx);
      if (again) return again;
      const replaced = await tx.query.signingCertificates.findFirst({
        where: and(eq(signingCertificates.kind, 'ORGANIZATION_SEAL'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)),
      });

      let ca = await tx.query.signingCertificates.findFirst({ where: and(eq(signingCertificates.kind, 'AUTHORITY'), isNull(signingCertificates.revokedAt), gt(signingCertificates.notAfter, now)) });
      if (!ca) {
        const made = makeCertificate({ commonName: AUTHORITY_NAME, years: 10, isCa: true });
        [ca] = await tx.insert(signingCertificates).values(this.row('AUTHORITY', AUTHORITY_NAME, made)).returning();
        await this.audit.record({ type: 'signing.authority_created', details: { fingerprint: made.fingerprint, notAfter: made.notAfter.toISOString() } }, tx);
      }
      const caKey = this.crypto.decryptSecret(ca.privateKeyEnc!, `cert:${ca.serialNumber}`);
      const made = makeCertificate({ commonName: SEAL_NAME, years: 3, isCa: false, issuer: { certPem: ca.certPem, keyPem: caKey }, crlUrl: this.crlUrl });
      const [seal] = await tx.insert(signingCertificates).values(this.row('ORGANIZATION_SEAL', SEAL_NAME, made)).returning();
      await this.audit.record(
        { type: 'signing.seal_created', details: { fingerprint: made.fingerprint, notAfter: made.notAfter.toISOString(), issuer: ca.fingerprintSha256, replaces: replaced?.fingerprintSha256 ?? null } },
        tx,
      );
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

  /** The authority's current revocation list (DER), signed now. Lists any revoked seal certificates. */
  async crl(): Promise<Buffer> {
    const ca = await this.authority();
    const revoked = await this.db.query.signingCertificates.findMany({ where: and(eq(signingCertificates.kind, 'ORGANIZATION_SEAL'), isNotNull(signingCertificates.revokedAt)) });
    return makeCrl({
      caCertDer: certDer(ca.certPem),
      caKeyPem: this.crypto.decryptSecret(ca.privateKeyEnc!, `cert:${ca.serialNumber}`),
      revoked: revoked.map((r) => ({ serialHex: r.serialNumber, at: r.revokedAt! })),
      now: new Date(Date.now() - 5 * 60_000), // allow for clock differences
    });
  }

  /**
   * Digitally signs a finished PDF with the organisation seal (PKCS#7 detached, SHA-256), adds a
   * trusted timestamp (unless TSA_URL is "off") and the long-term validation data.
   * Fails rather than producing a weaker seal; the worker retries unfinished documents.
   */
  async seal(pdf: Buffer, reason: string): Promise<{ sealed: Buffer; certificateFingerprint: string; timestampedAt: Date | null }> {
    const seal = await this.currentSeal();
    const ca = await this.authority();
    const key = this.crypto.decryptSecret(seal.privateKeyEnc!, `cert:${seal.serialNumber}`);
    const tsa = this.config.TSA_URL === 'off' ? null : this.config.TSA_URL;

    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    pdflibAddPlaceholder({
      pdfDoc: doc,
      reason,
      contactInfo: 'sign@ruliba.com',
      name: 'Ruliba Clays Ltd',
      location: 'Kigali, Rwanda',
      signatureLength: tsa ? 32_000 : 12_000, // room for the timestamp token and its certificates
      appName: 'Ruliba Clays eSign',
    });
    const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));
    const signer = new SealSigner(key, [seal.certPem, ca.certPem], tsa);
    const signed = await signpdf.sign(withPlaceholder, signer);

    // Long-term validation: both chains and their revocation lists, stored in the file.
    const caDer = certDer(ca.certPem);
    const ltv = await revocationData([certDer(seal.certPem), caDer, ...(signer.token?.certificates ?? [])], [{ issuer: parseCert(caDer).subject, crl: await this.crl() }]);
    const sealed = await appendDss(signed, ltv);
    return { sealed, certificateFingerprint: seal.fingerprintSha256, timestampedAt: signer.token?.time ?? null };
  }
}

/**
 * Signs with the seal (CMS SignedData, detached, SHA-256, the attributes Adobe expects), then has
 * the signature timestamped by the timestamp authority.
 */
class SealSigner extends Signer {
  token: TimestampToken | null = null;
  constructor(
    private readonly keyPem: string,
    private readonly chainPem: string[],
    private readonly tsaUrl: string | null,
  ) {
    super();
  }

  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(pdfBuffer.toString('binary'));
    const chain = this.chainPem.map((pem) => forge.pki.certificateFromPem(pem));
    chain.forEach((c) => p7.addCertificate(c));
    p7.addSigner({
      key: nativeRsaKey(this.keyPem),
      certificate: chain[0],
      digestAlgorithm: forge.pki.oids.sha256,
      // Order matters for some validators (contentType, signingTime, messageDigest).
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.signingTime, value: (signingTime ?? new Date()) as unknown as string },
        { type: forge.pki.oids.messageDigest },
      ],
    });
    p7.sign({ detached: true });
    const cms = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
    if (!this.tsaUrl) return cms;
    const out = await addSignatureTimestamp(cms, this.tsaUrl);
    this.token = out.token;
    return out.cms;
  }
}

/**
 * A private key node-forge can sign with, whose RSA operation runs in Node's native crypto
 * (forge's pure-JavaScript RSA takes several seconds per signature with 3072-bit keys).
 * Produces a standard RSASSA-PKCS1-v1_5 signature over the SHA-256 digest forge computed.
 */
export function nativeRsaKey(keyPem: string): forge.pki.rsa.PrivateKey {
  const key = createPrivateKey(keyPem);
  return {
    sign(md: forge.md.MessageDigest) {
      if (md.algorithm !== 'sha256') throw new Error(`Unsupported digest ${md.algorithm}`);
      const digestInfo = seq(seq(oid(OID.sha256), nul()), octets(Buffer.from(md.digest().getBytes(), 'binary')));
      return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, digestInfo).toString('binary');
    },
  } as unknown as forge.pki.rsa.PrivateKey;
}

function serialHex() {
  const b = randomBytes(16);
  b[0] &= 0x7f; // positive
  return b.toString('hex');
}

/** RSA-3072 key (Node's crypto, fast) and an X.509 certificate built with node-forge. */
export function makeCertificate(o: { commonName: string; years: number; isCa: boolean; issuer?: { certPem: string; keyPem: string }; crlUrl?: string }) {
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
  const issuerKeyId = issuerCert?.getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier?: string } | undefined;
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
          ...(issuerKeyId?.subjectKeyIdentifier ? [{ name: 'authorityKeyIdentifier', keyIdentifier: forge.util.hexToBytes(issuerKeyId.subjectKeyIdentifier) }] : []),
          ...(o.crlUrl ? [{ name: 'cRLDistributionPoints', altNames: [{ type: 6, value: o.crlUrl }] }] : []),
        ],
  );
  cert.sign(nativeRsaKey(o.issuer ? o.issuer.keyPem : keyPem), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { certPem, keyPem, serial: cert.serialNumber, fingerprint: sha256Hex(der), notBefore, notAfter };
}
