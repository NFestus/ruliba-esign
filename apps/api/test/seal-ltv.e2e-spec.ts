import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service';
import { CryptoService } from '../src/common/crypto.service';
import { DbService } from '../src/db/db';
import { body, children, der, nul, oid, OID, octets, parseCert, readTlv, seq, uint } from '../src/pdf/der';
import { certDer, makeCrl } from '../src/pdf/ltv';
import { makeCertificate, nativeRsaKey, SealService } from '../src/pdf/seal.service';
import { readToken } from '../src/pdf/timestamp';
import { createApp, resetDatabase } from './helpers';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A stand-in timestamp authority: its own root, a TSA certificate with a CRL address, and a CRL. */
function fakeTsa() {
  const root = makeCertificate({ commonName: 'Test TSA Root', years: 5, isCa: true });
  let base = '';
  const state: { leaf?: ReturnType<typeof makeCertificate>; requests: number } = { requests: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/root.crl') {
        res.end(makeCrl({ caCertDer: certDer(root.certPem), caKeyPem: root.keyPem, revoked: [] }));
        return;
      }
      state.requests++;
      const q = Buffer.concat(chunks);
      const f = children(q, readTlv(q));
      const imprint = body(q, children(q, f[1])[1]);
      const nonce = f.find((x, i) => i > 1 && x.tag === 0x02);
      const tst = seq(
        uint(Buffer.from([1])),
        oid('1.3.6.1.4.1.99999.1'),
        seq(seq(oid(OID.sha256), nul()), octets(Buffer.from(imprint))),
        uint(Buffer.from([0x2a])),
        der(0x18, Buffer.from(new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z')),
        ...(nonce ? [Buffer.from(q.subarray(nonce.start, nonce.end))] : []),
      );
      const p7 = forge.pkcs7.createSignedData();
      p7.content = forge.util.createBuffer(tst.toString('binary'));
      const leafCert = forge.pki.certificateFromPem(state.leaf!.certPem);
      p7.addCertificate(leafCert);
      p7.addCertificate(forge.pki.certificateFromPem(root.certPem));
      p7.addSigner({
        key: nativeRsaKey(state.leaf!.keyPem),
        certificate: leafCert,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: OID.tstInfo }, { type: forge.pki.oids.messageDigest }],
      });
      p7.sign();
      ((p7 as unknown as { contentInfo: forge.asn1.Asn1 }).contentInfo.value as forge.asn1.Asn1[])[0] = forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer(OID.tstInfo).getBytes(),
      );
      const token = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
      res.setHeader('content-type', 'application/timestamp-reply');
      res.end(seq(seq(uint(Buffer.from([0]))), token));
    });
  });
  server.keepAliveTimeout = 60_000;
  return new Promise<{ url: string; root: typeof root; state: typeof state; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      state.leaf = makeCertificate({ commonName: 'Test TSA', years: 2, isCa: false, issuer: { certPem: root.certPem, keyPem: root.keyPem }, crlUrl: `${base}/root.crl` });
      resolve({ url: `${base}/tsr`, root, state, close: () => server.close() });
    }),
  );
}

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Sales contract', { x: 60, y: 760, size: 16 });
  return Buffer.from(await pdf.save());
}

/** The CMS signature and the signed bytes of the (only) signature in a PDF. */
function signatureOf(pdf: Buffer) {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString('latin1'))!;
  const [a, b, c, d] = m.slice(1).map(Number);
  const hex = pdf.subarray(a + b + 1, c - 1).toString('latin1');
  const all = Buffer.from(hex, 'hex');
  const cms = all.subarray(0, readTlv(all).end);
  return { cms, signed: Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]), signedEnd: c + d };
}

jest.setTimeout(30_000);

describe('Seal with trusted timestamp and long-term validation data', () => {
  let app: INestApplication;
  let tsa: Awaited<ReturnType<typeof fakeTsa>>;
  let sealer: SealService;

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    tsa = await fakeTsa();
    sealer = new SealService(app.get(DbService), app.get(CryptoService), app.get(AuditService), { APP_URL: 'https://esign.example.rw', TSA_URL: tsa.url });
  });
  afterAll(async () => {
    tsa.close();
    await app.close();
  });

  it('timestamps the seal and stores both chains and their revocation lists in the file', async () => {
    const { sealed, timestampedAt } = await sealer.seal(await samplePdf(), 'Signed by all parties with Ruliba Clays eSign');
    expect(tsa.state.requests).toBe(1);
    expect(timestampedAt).toBeInstanceOf(Date);

    // The seal certificate says where its revocation list is published
    const ca = await sealer.authority();
    const { cms, signed, signedEnd } = signatureOf(sealed);
    const certs = children(cms, children(cms, children(cms, children(cms, readTlv(cms))[1])[0]).find((x) => x.tag === 0xa0)!);
    const sealCert = certs.map((c) => parseCert(Buffer.from(cms.subarray(c.start, c.end)))).find((c) => !c.issuer.equals(c.subject))!;
    expect(String(sealCert.extensions.get(OID.crlDistributionPoints))).toContain('https://esign.example.rw/api/verify/crl');

    // The timestamp is over this signature's value
    const sd = children(cms, children(cms, children(cms, readTlv(cms))[1])[0]);
    const signerInfo = children(cms, sd[sd.length - 1])[0];
    const parts = children(cms, signerInfo);
    const signatureValue = body(cms, parts.filter((p) => p.tag === 0x04).at(-1)!);
    const unsigned = children(cms, parts.at(-1)!);
    expect(unsigned).toHaveLength(1);
    const attr = children(cms, unsigned[0]);
    const tokenTlv = children(cms, attr[1])[0];
    const token = readToken(Buffer.from(cms.subarray(tokenTlv.start, tokenTlv.end)));
    expect(token.imprint.equals(createHash('sha256').update(signatureValue).digest())).toBe(true);

    // The DSS is an incremental update: the signed part of the file is unchanged, and it includes
    // the line break after %%EOF (Adobe Reader reports "altered" otherwise)
    expect(sealed.length).toBeGreaterThan(signedEnd);
    expect(sealed.subarray(signedEnd - 6, signedEnd).toString('latin1')).toBe('%%EOF\n');
    expect(sealed.subarray(signedEnd, signedEnd + 12).toString('latin1')).toMatch(/^\d+ 0 obj\n/);
    const doc = await PDFDocument.load(sealed);
    const dss = doc.context.lookup(doc.catalog.get(PDFName.of('DSS'))) as PDFDict;
    const arr = (k: string) => (doc.context.lookup(dss.get(PDFName.of(k))) as unknown as { size(): number }).size();
    expect(arr('Certs')).toBe(4); // seal, Ruliba authority, TSA, TSA root
    expect(arr('CRLs')).toBe(2); // Ruliba's and the TSA root's

    if (hasOpenssl) {
      const dir = mkdtempSync(join(tmpdir(), 'seal-'));
      const w = (n: string, b: Buffer | string) => (writeFileSync(join(dir, n), b), join(dir, n));
      // The seal verifies over the signed byte range, chained to Ruliba's authority
      execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', w('sig.der', cms), '-content', w('signed.bin', signed), '-CAfile', w('ca.pem', ca.certPem), '-purpose', 'any', '-out', join(dir, 'out')], { stdio: 'pipe' });
      // Ruliba's revocation list is properly signed by the authority
      execFileSync('openssl', ['crl', '-inform', 'DER', '-in', w('ca.crl', await sealer.crl()), '-CAfile', join(dir, 'ca.pem'), '-noout'], { stdio: 'pipe' });
    }
  });

  it('publishes the revocation list without sign-in', async () => {
    const res = await request(app.getHttpServer()).get('/api/verify/crl').buffer(true).parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (d: Buffer) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pkix-crl');
    expect((res.body as Buffer)[0]).toBe(0x30);
  });

  it('refuses to seal when the timestamp authority cannot be reached, so the worker retries', async () => {
    const offline = new SealService(app.get(DbService), app.get(CryptoService), app.get(AuditService), { APP_URL: 'https://esign.example.rw', TSA_URL: 'http://127.0.0.1:9/tsr' });
    await expect(offline.seal(await samplePdf(), 'x')).rejects.toThrow(/could not be reached/);
  });

  it('reuses the seal certificate, but never one made before revocation list addresses', async () => {
    const current = (await sealer.seal(await samplePdf(), 'x')).certificateFingerprint;
    expect((await sealer.seal(await samplePdf(), 'x')).certificateFingerprint).toBe(current);

    // Only a seal from before this change (no CRL address) is valid: a new one is made
    const { db } = app.get(DbService) as unknown as { db: import('../src/db/db').Database };
    const { signingCertificates } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(signingCertificates).set({ notAfter: new Date(Date.now() - 1000) }).where(eq(signingCertificates.fingerprintSha256, current));
    const ca = await sealer.authority();
    const crypto = app.get(CryptoService);
    const caKey = crypto.decryptSecret(ca.privateKeyEnc!, `cert:${ca.serialNumber}`);
    const old = makeCertificate({ commonName: 'Ruliba Clays Ltd - Document Seal', years: 3, isCa: false, issuer: { certPem: ca.certPem, keyPem: caKey } });
    await db.insert(signingCertificates).values({
      kind: 'ORGANIZATION_SEAL',
      level: 'PLATFORM',
      holderName: 'Ruliba Clays Ltd - Document Seal',
      serialNumber: old.serial,
      fingerprintSha256: old.fingerprint,
      certPem: old.certPem,
      privateKeyEnc: crypto.encryptSecret(old.keyPem, `cert:${old.serial}`),
      notBefore: new Date(Date.now() - 1000),
      notAfter: old.notAfter,
    });
    const replaced = (await sealer.seal(await samplePdf(), 'x')).certificateFingerprint;
    expect([current, old.fingerprint]).not.toContain(replaced);
    const row = (await db.query.signingCertificates.findFirst({ where: eq(signingCertificates.fingerprintSha256, replaced) }))!;
    expect(parseCert(certDer(row.certPem)).extensions.has(OID.crlDistributionPoints)).toBe(true);
    // ...and it is kept from then on
    expect((await sealer.seal(await samplePdf(), 'x')).certificateFingerprint).toBe(replaced);
  });
});
