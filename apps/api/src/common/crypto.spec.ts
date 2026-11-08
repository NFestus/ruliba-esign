import { CryptoService, aesGcmDecrypt, aesGcmEncrypt, sha256Hex } from './crypto.service';
import { chainHash, canonicalJson, GENESIS_HASH } from '../audit/hash';
import { randomBytes } from 'node:crypto';

describe('encryption at rest', () => {
  const svc = new CryptoService({ MASTER_KEY: randomBytes(32).toString('base64') } as never);

  it('round-trips a file and detects any change to it', () => {
    const plain = Buffer.from('%PDF-1.7 supply contract');
    const { blob, wrappedKey } = svc.encryptFile(plain, 'docs/abc.pdf');
    expect(blob.includes(plain)).toBe(false);
    expect(svc.decryptFile(blob, wrappedKey, 'docs/abc.pdf').equals(plain)).toBe(true);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    expect(() => svc.decryptFile(tampered, wrappedKey, 'docs/abc.pdf')).toThrow();
  });

  it('binds an encrypted file to its storage key (cannot be swapped with another file)', () => {
    const { blob, wrappedKey } = svc.encryptFile(Buffer.from('a'), 'docs/one.pdf');
    expect(() => svc.decryptFile(blob, wrappedKey, 'docs/two.pdf')).toThrow();
  });

  it('round-trips secrets with context', () => {
    const enc = svc.encryptSecret('JBSWY3DPEHPK3PXP', 'mfa:user-1');
    expect(svc.decryptSecret(enc, 'mfa:user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => svc.decryptSecret(enc, 'mfa:user-2')).toThrow();
  });

  it('refuses unknown formats', () => {
    expect(() => aesGcmDecrypt(randomBytes(32), Buffer.from([9, 1, 2]))).toThrow();
    const k = randomBytes(32);
    expect(aesGcmDecrypt(k, aesGcmEncrypt(k, Buffer.from('x'))).toString()).toBe('x');
  });

  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('audit hash chain', () => {
  const e = { occurredAt: new Date('2026-11-02T08:00:00.000Z'), type: 'document.signed', actorEmail: 'a@b.rw', details: { b: 2, a: 1 } };

  it('is independent of key order in details', () => {
    expect(canonicalJson({ b: 2, a: { d: 1, c: [3, { y: 1, x: 2 }] } })).toBe('{"a":{"c":[3,{"x":2,"y":1}],"d":1},"b":2}');
    expect(chainHash(GENESIS_HASH, e)).toBe(chainHash(GENESIS_HASH, { ...e, details: { a: 1, b: 2 } }));
  });

  it('changes when any field or the previous hash changes', () => {
    const h = chainHash(GENESIS_HASH, e);
    expect(chainHash(GENESIS_HASH, { ...e, actorEmail: 'x@b.rw' })).not.toBe(h);
    expect(chainHash('1'.repeat(64), e)).not.toBe(h);
    expect(chainHash(GENESIS_HASH, { ...e, occurredAt: new Date('2026-11-02T08:00:00.001Z') })).not.toBe(h);
  });
});
