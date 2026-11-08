import './env';
import { createDb, runMigrations } from './db/db';

/**
 * Applies pending SQL migrations from ./drizzle, in order, once each.
 * Run on every deployment before starting the API (docker compose runs it as a one-off job).
 * Uses MIGRATION_DATABASE_URL (table-owner role) when set, else DATABASE_URL.
 */
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { pool, db } = createDb(url, 1);
  await runMigrations(db);
  await pool.end();
  console.log('Migrations applied.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
