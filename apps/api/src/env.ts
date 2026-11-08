import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Reads apps/api/.env when running with npm scripts (laptop, test server, Windows or Linux).
 * Values already set in the environment win, so Docker Compose and CI settings are never overridden.
 * In Docker there is no .env file in the image, and this does nothing. Tests never read it.
 */
const file = path.resolve(process.cwd(), '.env');
if (process.env.NODE_ENV !== 'test' && existsSync(file)) {
  const values = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(values)) if (process.env[k] === undefined) process.env[k] = v;
}
