import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { totpNow } from '../src/auth/totp';
import { createDb, runMigrations } from '../src/db/db';
import { EmailService } from '../src/email/email.service';
import { seed } from '../src/seed';

export const ADMIN = { email: 'admin@ruliba.com', name: 'Test Admin', password: 'Kiln-Fired Brick 2026' };

/** Fresh schema, migrations and seed data for every test file. */
export async function resetDatabase() {
  const { pool, db } = createDb(process.env.DATABASE_URL!, 1);
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await runMigrations(db);
  await pool.end();
  process.env.SEED_ADMIN_EMAIL = ADMIN.email;
  process.env.SEED_ADMIN_NAME = ADMIN.name;
  process.env.SEED_ADMIN_PASSWORD = ADMIN.password;
  await seed(process.env.DATABASE_URL!, () => undefined);
}

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  return app;
}

/** A code from the next 30-second step, so it is not refused as a replay of one used moments ago. */
export function freshCode(secret: string, stepsAhead = 1) {
  return totpNow(secret, Date.now() + stepsAhead * 30_000);
}

/**
 * Walk the admin through first sign-in: password -> forced MFA enrolment -> forced password change.
 * Returns an agent holding the refresh cookie, the access token and the MFA secret.
 */
export async function signInFirstAdmin(app: INestApplication) {
  const agent = request.agent(app.getHttpServer());
  const login = await agent.post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
  const mfaToken = login.body.mfaToken as string;
  const setup = await agent.post('/api/auth/mfa/setup').send({ mfaToken }).expect(200);
  const secret = setup.body.secret as string;
  const confirm = await agent.post('/api/auth/mfa/confirm').send({ mfaToken, code: totpNow(secret) }).expect(200);
  const newPassword = 'A much longer passphrase 42';
  const changed = await agent
    .post('/api/auth/password')
    .set('authorization', `Bearer ${confirm.body.accessToken}`)
    .send({ currentPassword: ADMIN.password, newPassword })
    .expect(200);
  return { agent, token: changed.body.accessToken as string, secret, password: newPassword, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

export const STAFF_PASSWORD = 'A long staff passphrase 2026';

/** The token from the newest activation email sent to this address. */
export function activationToken(app: INestApplication, email: string): string {
  const mail = [...app.get(EmailService).testOutbox].reverse().find((m) => m.to === email && m.template === 'account-activation');
  if (!mail) throw new Error(`No activation email for ${email}`);
  return mail.data.link.split('/activate/')[1];
}

/** A newly added user opens the activation link, chooses a password, then signs in. Returns the login response. */
export async function activateAndSignIn(app: INestApplication, email: string, password = STAFF_PASSWORD) {
  const http = request(app.getHttpServer());
  await http.post('/api/auth/activate').send({ token: activationToken(app, email), newPassword: password }).expect(200);
  return http.post('/api/auth/login').send({ email, password }).expect(200);
}
