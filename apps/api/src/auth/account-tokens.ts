import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomToken, sha256Hex } from '../common/crypto.service';
import { DbOrTx } from '../db/db';
import { activationTokens } from '../db/schema';

/**
 * One-use links emailed to people: account activation and password reset.
 * Only the SHA-256 of a token is stored. Issuing a new link of a purpose ends the older ones.
 */
export type AccountTokenPurpose = 'ACTIVATION' | 'PASSWORD_RESET';

export async function issueAccountToken(db: DbOrTx, userId: string, purpose: AccountTokenPurpose, ttlMs: number) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .update(activationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(activationTokens.userId, userId), eq(activationTokens.purpose, purpose), isNull(activationTokens.usedAt)));
  await db.insert(activationTokens).values({ userId, purpose, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

/** A token that is unused, not expired and of the right purpose, or undefined. */
export function findAccountToken(db: DbOrTx, rawToken: string, purpose: AccountTokenPurpose) {
  return db.query.activationTokens.findFirst({
    where: and(
      eq(activationTokens.tokenHash, sha256Hex(rawToken)),
      eq(activationTokens.purpose, purpose),
      isNull(activationTokens.usedAt),
      gt(activationTokens.expiresAt, new Date()),
    ),
  });
}

/** Marks a token used. False if it was used in the meantime (two submits at the same moment). */
export async function consumeAccountToken(db: DbOrTx, id: string) {
  const used = await db
    .update(activationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(activationTokens.id, id), isNull(activationTokens.usedAt)))
    .returning({ id: activationTokens.id });
  return used.length === 1;
}

/** Dates in emails: Kigali time, e.g. "8 November 2026 at 17:30". */
export function kigaliTime(d: Date) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(d);
}
