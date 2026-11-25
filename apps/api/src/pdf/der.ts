import forge from 'node-forge';

/**
 * A small DER reader and writer, enough to work with certificates, CRLs, CMS signatures and
 * timestamp tokens byte for byte. Re-encoding through a general ASN.1 library can change bytes
 * and break a signature, so signed structures are only ever sliced and wrapped here, never rebuilt.
 */
export interface Tlv {
  tag: number;
  start: number;
  header: number;
  end: number;
}

export function readTlv(b: Buffer, at = 0): Tlv {
  if (at >= b.length) throw new Error('DER: unexpected end of data');
  const tag = b[at];
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: multi-byte tags are not supported');
  let p = at + 1;
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  const end = p + len;
  if (end > b.length) throw new Error('DER: value runs past the end of the data');
  return { tag, start: at, header: p - at, end };
}

export const children = (b: Buffer, t: Tlv): Tlv[] => {
  const out: Tlv[] = [];
  for (let p = t.start + t.header; p < t.end; ) {
    const c = readTlv(b, p);
    out.push(c);
    p = c.end;
  }
  return out;
};
export const raw = (b: Buffer, t: Tlv) => b.subarray(t.start, t.end);
export const body = (b: Buffer, t: Tlv) => b.subarray(t.start + t.header, t.end);

function lengthBytes(n: number) {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

/** Encodes one element: tag, length and the given content (already-encoded children for constructed tags). */
export function der(tag: number, ...parts: Buffer[]) {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export const seq = (...parts: Buffer[]) => der(0x30, ...parts);
export const set = (...parts: Buffer[]) => der(0x31, ...parts);
export const octets = (v: Buffer) => der(0x04, v);
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
export const oid = (dotted: string) => der(0x06, Buffer.from(forge.asn1.oidToDer(dotted).getBytes(), 'binary'));
export const oidOf = (b: Buffer, t: Tlv) => forge.asn1.derToOid(forge.util.createBuffer(body(b, t).toString('binary')));

/** A non-negative INTEGER from big-endian bytes (a leading zero is added when the top bit is set). */
export function uint(bytes: Buffer) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const v = bytes.subarray(i);
  return der(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
export function uintOf(n: bigint) {
  const hex = n.toString(16);
  return uint(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'));
}

/** UTCTime up to 2049, GeneralizedTime after (RFC 5280). */
export function time(d: Date) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(iso.slice(2))) : der(0x18, Buffer.from(iso));
}

export function parseTime(b: Buffer, t: Tlv): Date {
  const s = body(b, t).toString('latin1');
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:[.,](\d+))?Z$/.exec(s);
  if (!m) throw new Error(`DER: unsupported time ${s}`);
  let year = Number(m[1]);
  if (m[1].length === 2) year += year < 50 ? 2000 : 1900;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms));
}

/**
 * Rebuilds `t` with the element at `path` (child indexes; -1 = last child) replaced by `fn(oldBytes)`.
 * Every element on the way up gets its new length; nothing else changes.
 */
export function replaceAt(b: Buffer, t: Tlv, path: number[], fn: (old: Buffer) => Buffer): Buffer {
  if (!path.length) return fn(raw(b, t));
  const kids = children(b, t);
  const at = path[0] < 0 ? kids.length + path[0] : path[0];
  if (!kids[at]) throw new Error('DER: path not found');
  return der(t.tag, ...kids.map((k, i) => (i === at ? replaceAt(b, k, path.slice(1), fn) : raw(b, k))));
}

/** The parts of an X.509 certificate needed to build chains and find revocation information. */
export interface CertInfo {
  der: Buffer;
  issuer: Buffer;
  subject: Buffer;
  serial: Buffer;
  extensions: Map<string, Buffer>; // OID -> extnValue contents
}

export function parseCert(certDer: Buffer): CertInfo {
  const root = readTlv(certDer);
  const tbs = children(certDer, root)[0];
  const f = children(certDer, tbs);
  const o = f[0].tag === 0xa0 ? 1 : 0; // explicit version
  const extensions = new Map<string, Buffer>();
  const extWrap = f.find((x) => x.tag === 0xa3);
  if (extWrap) {
    for (const ext of children(certDer, children(certDer, extWrap)[0])) {
      const parts = children(certDer, ext);
      extensions.set(oidOf(certDer, parts[0]), body(certDer, parts[parts.length - 1]));
    }
  }
  return { der: certDer, serial: body(certDer, f[o]), issuer: raw(certDer, f[o + 2]), subject: raw(certDer, f[o + 4]), extensions };
}

/** Every URI (GeneralName [6]) inside a DER value, in order. */
export function uris(b: Buffer, t: Tlv = readTlv(b)): string[] {
  if (t.tag === 0x86) return [body(b, t).toString('latin1')];
  if (!(t.tag & 0x20)) return [];
  return children(b, t).flatMap((c) => uris(b, c));
}

export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  crlNumber: '2.5.29.20',
  crlDistributionPoints: '2.5.29.31',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  caIssuers: '1.3.6.1.5.5.7.48.2',
};

/** CRL URLs (http only, as PDF readers and this server fetch them) from a certificate. */
export function crlUrls(c: CertInfo) {
  const v = c.extensions.get(OID.crlDistributionPoints);
  return v ? uris(v).filter((u) => /^https?:\/\//i.test(u)) : [];
}

/** "CA issuers" URLs: where the certificate of the issuer can be downloaded. */
export function caIssuerUrls(c: CertInfo) {
  const v = c.extensions.get(OID.authorityInfoAccess);
  if (!v) return [];
  const out: string[] = [];
  for (const ad of children(v, readTlv(v))) {
    const [method, name] = children(v, ad);
    if (oidOf(v, method) === OID.caIssuers && name.tag === 0x86) out.push(body(v, name).toString('latin1'));
  }
  return out.filter((u) => /^https?:\/\//i.test(u));
}
