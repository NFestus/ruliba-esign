import { createHash, randomBytes } from 'node:crypto';
import { body, bool, children, der, oid, OID, octets, oidOf, parseTime, raw, readTlv, replaceAt, seq, set, uint, nul } from './der';

/**
 * Trusted timestamps (RFC 3161). An independent timestamp authority signs "this signature existed
 * at this time"; the token goes into the seal as an unsigned attribute (PAdES "B-T"), so the
 * signing time no longer rests on Ruliba's own server clock.
 */

const MAX_REPLY = 256 * 1024;

export interface TimestampToken {
  /** The TimeStampToken (a CMS ContentInfo), exactly as the authority sent it. */
  der: Buffer;
  time: Date;
  /** Certificates the authority included (normally its own, sometimes its issuers too). */
  certificates: Buffer[];
}

/** Asks the authority at `url` to timestamp `data` (its SHA-256 is sent, never the data). */
export async function requestTimestamp(url: string, data: Buffer): Promise<TimestampToken> {
  const digest = createHash('sha256').update(data).digest();
  const nonce = randomBytes(8);
  nonce[0] &= 0x7f;
  const request = seq(uint(Buffer.from([1])), seq(seq(oid(OID.sha256), nul()), octets(digest)), uint(nonce), bool(true));

  let res: Response | undefined;
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' },
        body: new Uint8Array(request),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // One retry: a reused connection the server had just closed fails without reaching it.
      if (attempt >= 2) throw new Error(`Timestamp authority ${url} could not be reached: ${(e as Error).message}`);
    }
  }
  if (!res.ok) throw new Error(`Timestamp authority ${url} answered HTTP ${res.status}`);
  const reply = Buffer.from(await res.arrayBuffer());
  if (reply.length > MAX_REPLY) throw new Error('Timestamp reply is too large');

  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
  const [status, token] = children(reply, readTlv(reply));
  const code = body(reply, children(reply, status)[0]).at(-1) ?? 0; // 0 granted, 1 granted with changes
  if (code > 1 || !token) throw new Error(`Timestamp authority ${url} refused the request (status ${code})`);
  const tokenDer = Buffer.from(raw(reply, token));
  const parsed = readToken(tokenDer);
  if (!parsed.imprint.equals(digest)) throw new Error('Timestamp token is for different data');
  if (!parsed.nonce || !stripZeros(parsed.nonce).equals(stripZeros(nonce))) throw new Error('Timestamp token nonce does not match');
  return { der: tokenDer, time: parsed.time, certificates: parsed.certificates };
}

const stripZeros = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

/** Reads the TSTInfo and certificates out of a timestamp token. */
export function readToken(tokenDer: Buffer) {
  const ci = children(tokenDer, readTlv(tokenDer));
  const signedData = children(tokenDer, children(tokenDer, ci[1])[0]);
  const encap = children(tokenDer, signedData[2]);
  if (oidOf(tokenDer, encap[0]) !== OID.tstInfo) throw new Error('Not a timestamp token');
  const tstOctets = children(tokenDer, encap[1])[0];
  const tst = Buffer.from(body(tokenDer, tstOctets));
  const f = children(tst, readTlv(tst));
  // version, policy, messageImprint, serialNumber, genTime, accuracy?, ordering?, nonce?, ...
  const imprint = body(tst, children(tst, f[2])[1]);
  const time = parseTime(tst, f[4]);
  const nonceTlv = f.slice(5).find((x) => x.tag === 0x02);
  const certSet = signedData.find((x) => x.tag === 0xa0);
  const certificates = certSet ? children(tokenDer, certSet).filter((c) => c.tag === 0x30).map((c) => Buffer.from(raw(tokenDer, c))) : [];
  return { imprint: Buffer.from(imprint), time, nonce: nonceTlv ? Buffer.from(body(tst, nonceTlv)) : null, certificates };
}

/**
 * Adds a signature timestamp to a CMS SignedData (as produced for the PDF seal): timestamps the
 * signer's signature value and stores the token as the signatureTimeStampToken unsigned attribute.
 */
export async function addSignatureTimestamp(cms: Buffer, url: string): Promise<{ cms: Buffer; token: TimestampToken }> {
  const root = readTlv(cms);
  // ContentInfo -> [0] -> SignedData -> signerInfos (last) -> first SignerInfo
  const path = [1, 0, -1, 0];
  let signerInfo = root;
  for (const i of path) {
    const kids = children(cms, signerInfo);
    signerInfo = kids[i < 0 ? kids.length + i : i];
  }
  const parts = children(cms, signerInfo);
  if (parts.some((p) => p.tag === 0xa1)) throw new Error('The signature already has unsigned attributes');
  const signatureValue = body(cms, [...parts].reverse().find((p) => p.tag === 0x04)!);
  const token = await requestTimestamp(url, Buffer.from(signatureValue));
  const attribute = seq(oid(OID.signatureTimeStampToken), set(token.der));
  const out = replaceAt(cms, root, path, (old) => {
    const t = readTlv(old);
    return der(t.tag, body(old, t), der(0xa1, attribute));
  });
  return { cms: out, token };
}
