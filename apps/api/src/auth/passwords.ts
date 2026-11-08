import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

// Argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations, 1 lane).
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Used when the email is unknown, so a wrong email takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash.then((h) => verifyPassword(h, password));
}

/**
 * Temporary password handed to a new user by the admin. Readable groups, no look-alike characters.
 * The user must replace it at first sign-in.
 */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)].map((g) => g.join('')).join('-');
}
