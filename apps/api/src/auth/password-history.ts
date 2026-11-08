import { desc, eq, inArray } from 'drizzle-orm';
import { DbOrTx } from '../db/db';
import { passwordHistory } from '../db/schema';
import { verifyPassword } from './passwords';

/** A new password may not be any of the person's last this-many passwords (the current one included). */
export const PASSWORD_HISTORY_SIZE = 5;

export const PASSWORD_REUSED_MESSAGE = `You have used this password recently. Choose one that is different from your last ${PASSWORD_HISTORY_SIZE} passwords.`;

/** True if the password matches one of the person's last PASSWORD_HISTORY_SIZE passwords. */
export async function isRecentPassword(db: DbOrTx, userId: string, password: string): Promise<boolean> {
  const recent = await db
    .select({ passwordHash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(PASSWORD_HISTORY_SIZE);
  for (const r of recent) if (await verifyPassword(r.passwordHash, password)) return true;
  return false;
}

/**
 * Records a password the person chose (never the unusable random ones), and keeps only the newest
 * PASSWORD_HISTORY_SIZE: older hashes are deleted, so no more old passwords are kept than needed.
 */
export async function rememberPassword(db: DbOrTx, userId: string, passwordHash: string) {
  await db.insert(passwordHistory).values({ userId, passwordHash });
  const keep = await db
    .select({ id: passwordHistory.id })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(PASSWORD_HISTORY_SIZE);
  const all = await db.select({ id: passwordHistory.id }).from(passwordHistory).where(eq(passwordHistory.userId, userId));
  const drop = all.map((r) => r.id).filter((id) => !keep.some((k) => k.id === id));
  if (drop.length) await db.delete(passwordHistory).where(inArray(passwordHistory.id, drop));
}
