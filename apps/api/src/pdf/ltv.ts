import { sign } from 'node:crypto';
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { body, caIssuerUrls, CertInfo, children, crlUrls, der, nul, oid, OID, octets, parseCert, readTlv, seq, time, uintOf } from './der';

/**
 * Long-term validation (PAdES "B-LT"). Certificates expire and revocation services go away, so
 * everything a PDF reader needs to check the seal later is stored inside the file: the certificate
 * chains of the seal and of the timestamp authority, and their revocation lists (CRLs), in the
 * document security store (/DSS) added as an incremental update after the signature.
 */

const MAX_DOWNLOAD = 10 * 1024 * 1024;

async function download(url: string, kind: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Could not download the ${kind} ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`Could not download the ${kind} ${url}: HTTP ${res.status}`);
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > MAX_DOWNLOAD) throw new Error(`The ${kind} ${url} is too large`);
  return b;
}

/** PEM or DER certificate -> DER. */
export function certDer(certOrPem: Buffer | string): Buffer {
  const s = typeof certOrPem === 'string' ? certOrPem : certOrPem.toString('latin1');
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(s);
  return m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64') : Buffer.from(certOrPem as Buffer);
}

const isSelfIssued = (c: CertInfo) => c.issuer.equals(c.subject);

/**
 * Completes the chain of each certificate (downloading missing issuers from their "CA issuers"
 * address) and downloads a CRL for every certificate that is not a root.
 * `known` revocation lists (e.g. Ruliba's own, made locally) are used instead of downloading.
 */
export async function revocationData(certs: Buffer[], known: { issuer: Buffer; crl: Buffer }[] = []) {
  const all: CertInfo[] = [];
  const add = (d: Buffer) => {
    if (!all.some((c) => c.der.equals(d))) all.push(parseCert(d));
  };
  certs.forEach(add);

  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (isSelfIssued(c) || all.some((x) => x.subject.equals(c.issuer))) continue;
    for (const url of caIssuerUrls(c)) {
      const got = await download(url, 'issuer certificate');
      // Usually one DER certificate; some authorities serve a PKCS#7 bundle (.p7c).
      for (const d of /-----BEGIN/.test(got.toString('latin1', 0, 64)) ? [certDer(got)] : splitBundle(got)) add(d);
      if (all.some((x) => x.subject.equals(c.issuer))) break;
    }
  }

  const crls: Buffer[] = [];
  for (const c of all) {
    if (isSelfIssued(c)) continue; // roots are trusted directly, never revoked through a CRL
    const local = known.find((k) => k.issuer.equals(c.issuer));
    if (local) {
      if (!crls.some((x) => x.equals(local.crl))) crls.push(local.crl);
      continue;
    }
    const urls = crlUrls(c);
    if (!urls.length) throw new Error('A certificate in the chain has no revocation list address');
    let crl: Buffer | null = null;
    let lastError: unknown;
    for (const url of urls) {
      try {
        crl = await download(url, 'revocation list');
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!crl) throw lastError;
    if (!crls.some((x) => x.equals(crl))) crls.push(crl);
  }
  return { certs: all.map((c) => c.der), crls };
}

/** A DER certificate, or the certificates of a degenerate PKCS#7 bundle. */
function splitBundle(b: Buffer): Buffer[] {
  const root = readTlv(b);
  const kids = children(b, root);
  if (kids[0]?.tag === 0x06) {
    const sd = children(b, children(b, kids[1])[0]);
    const set = sd.find((x) => x.tag === 0xa0);
    return set ? children(b, set).map((c) => Buffer.from(b.subarray(c.start, c.end))) : [];
  }
  return [b];
}

/**
 * A CRL (v2) issued by Ruliba's own authority: lists revoked seal certificates (usually none).
 * Signed with the authority key, valid for `days`.
 */
export function makeCrl(o: { caCertDer: Buffer; caKeyPem: string; revoked: { serialHex: string; at: Date }[]; now?: Date; days?: number }) {
  const ca = parseCert(o.caCertDer);
  const now = o.now ?? new Date();
  const next = new Date(now.getTime() + (o.days ?? 7) * 86_400_000);
  const ski = ca.extensions.get(OID.subjectKeyIdentifier);
  const alg = seq(oid(OID.sha256WithRSA), nul());
  const extensions = [
    ...(ski ? [seq(oid(OID.authorityKeyIdentifier), octets(seq(der(0x80, body(ski, readTlv(ski))))))] : []),
    seq(oid(OID.crlNumber), octets(uintOf(BigInt(Math.floor(now.getTime() / 1000))))),
  ];
  const revoked = o.revoked.length ? [seq(...o.revoked.map((r) => seq(uintOf(BigInt(`0x${r.serialHex}`)), time(r.at))))] : [];
  const tbs = seq(uintOf(1n), alg, ca.subject, time(now), time(next), ...revoked, der(0xa0, seq(...extensions)));
  const signature = sign('sha256', tbs, o.caKeyPem);
  return seq(tbs, alg, der(0x03, Buffer.from([0]), signature));
}

/**
 * Appends a document security store to a signed PDF as an incremental update, so the signature's
 * byte range is untouched. Only new objects and a new version of the catalog are written.
 */
export async function appendDss(pdf: Buffer, data: { certs: Buffer[]; crls: Buffer[] }): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const trailer = doc.context.trailerInfo;
  const rootRef = trailer.Root as PDFRef;
  const startxref = pdf.lastIndexOf('startxref');
  const prev = Number(/startxref\s+(\d+)/.exec(pdf.subarray(startxref).toString('latin1'))?.[1]);
  if (startxref < 0 || !Number.isFinite(prev)) throw new Error('Signed PDF has no cross-reference table');

  let next = doc.context.largestObjectNumber + 1;
  const parts: Buffer[] = [];
  const offsets: [number, number][] = [];
  let at = pdf.length + 1; // after the leading newline
  const push = (num: number, content: Buffer) => {
    offsets.push([num, at]);
    const chunk = Buffer.concat([Buffer.from(`${num} 0 obj\n`), content, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
  };
  const stream = (bytes: Buffer) => {
    const num = next++;
    push(num, Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]));
    return `${num} 0 R`;
  };

  const certRefs = data.certs.map(stream);
  const crlRefs = data.crls.map(stream);
  const dssNum = next++;
  push(dssNum, Buffer.from(`<< /Type /DSS /Certs [${certRefs.join(' ')}] /CRLs [${crlRefs.join(' ')}] >>`));

  const catalog = doc.catalog;
  catalog.set(PDFName.of('DSS'), PDFRef.of(dssNum));
  // Declare the PAdES extension level (ISO 32000-1 extension for DSS).
  catalog.set(PDFName.of('Extensions'), doc.context.obj({ ESIC: { BaseVersion: PDFName.of('1.7'), ExtensionLevel: 1 } }));
  offsets.push([rootRef.objectNumber, at]);
  const catChunk = Buffer.from(`${rootRef.objectNumber} ${rootRef.generationNumber} obj\n${catalog.toString()}\nendobj\n`, 'latin1');
  parts.push(catChunk);
  at += catChunk.length;

  // Cross-reference section: one subsection per object (simple and always valid).
  offsets.sort((a, b) => a[0] - b[0]);
  const gen = (n: number) => (n === rootRef.objectNumber ? rootRef.generationNumber : 0);
  const xref =
    'xref\n' +
    offsets.map(([n, off]) => `${n} 1\n${String(off).padStart(10, '0')} ${String(gen(n)).padStart(5, '0')} n \n`).join('');
  const extra = [trailer.Info ? `/Info ${trailer.Info.toString()}` : '', trailer.ID ? `/ID ${trailer.ID.toString()}` : ''].join(' ');
  const tail = `${xref}trailer\n<< /Size ${next} /Root ${rootRef.toString()} ${extra} /Prev ${prev} >>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from('\n'), ...parts, Buffer.from(tail, 'latin1')]);
}
