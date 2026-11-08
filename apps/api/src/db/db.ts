import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import { AppConfig, CONFIG } from '../config';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction: services accept either so callers can group writes. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

export function createDb(url: string, max = 10) {
  const pool = new Pool({ connectionString: url, max, application_name: 'ruliba-esign' });
  return { pool, db: drizzle(pool, { schema, casing: 'snake_case' }) as Database };
}

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

export async function runMigrations(db: Database) {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Database;

  constructor(@Inject(CONFIG) config: AppConfig) {
    const { pool, db } = createDb(config.DATABASE_URL);
    this.pool = pool;
    this.db = db;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
