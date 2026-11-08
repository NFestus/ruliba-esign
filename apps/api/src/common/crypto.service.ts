import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig, CONFIG } from '../config';

/**
 * Encryption at rest uses envelope encryption:
 *  - every file gets its own random 256-bit data key (AES-256-GCM);
 *  - that data key is "wrapped" (encrypted) with the MASTER_KEY and stored next to the file record.
 * Rotating the master key means re-wrapping small keys, not re-encrypting every file.
 * Format of an encrypted blob: version(1) | iv(12) | tag(16) | ciphertext.
 */
const VERSION = 1;

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function aesGcmDecrypt(key: Buffer, blob: Buffer, aad?: Buffer): Buffer {
  if (blob.length < 29 || blob[0] !== VERSION) throw new Error('Unknown encrypted format');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.masterKey = Buffer.from(config.MASTER_KEY, 'base64');
  }

  /** Encrypt a short secret (e.g. a TOTP seed) for storage in the database. */
  encryptSecret(plain: string, context: string): string {
    return aesGcmEncrypt(this.masterKey, Buffer.from(plain, 'utf8'), Buffer.from(context)).toString('base64');
  }

  decryptSecret(stored: string, context: string): string {
    return aesGcmDecrypt(this.masterKey, Buffer.from(stored, 'base64'), Buffer.from(context)).toString('utf8');
  }

  /** Encrypt a file with a fresh data key. Returns the blob to store and the wrapped key for the DB row. */
  encryptFile(plain: Buffer, storageKey: string): { blob: Buffer; wrappedKey: string } {
    const dataKey = randomBytes(32);
    const blob = aesGcmEncrypt(dataKey, plain, Buffer.from(storageKey));
    const wrappedKey = aesGcmEncrypt(this.masterKey, dataKey, Buffer.from('file-key:' + storageKey)).toString('base64');
    return { blob, wrappedKey };
  }

  decryptFile(blob: Buffer, wrappedKey: string, storageKey: string): Buffer {
    const dataKey = aesGcmDecrypt(this.masterKey, Buffer.from(wrappedKey, 'base64'), Buffer.from('file-key:' + storageKey));
    return aesGcmDecrypt(dataKey, blob, Buffer.from(storageKey));
  }
}
