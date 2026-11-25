import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { createDb } from '../src/db/db';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin, STAFF_PASSWORD } from './helpers';

const CSRF = { 'x-esign-csrf': '1' };

describe('Session limits: idle time and maximum length', () => {
  let app: INestApplication;
  let pg: ReturnType<typeof createDb>;

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    pg = createDb(process.env.DATABASE_URL!, 1);
    const { token } = await signInFirstAdmin(app);
    await request(app.getHttpServer()).post('/api/users').set({ authorization: `Bearer ${token}` }).send({ email: 'clerk@ruliba.com', fullName: 'Cleo Clerk', roles: ['SENDER'] }).expect(201);
    await activateAndSignIn(app, 'clerk@ruliba.com');
  });
  afterAll(async () => {
    await pg.pool.end();
    await app.close();
  });

  async function signIn() {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/auth/login').send({ email: 'clerk@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    return { agent, body: login.body };
  }

  it('reports the limits: 10-minute access token, 30 minutes idle, 12 hours at most', async () => {
    const { body } = await signIn();
    expect(body.expiresIn).toBe(600);
    expect(body.idleMinutes).toBe(30);
    const idle = Date.parse(body.idleExpiresAt) - Date.now();
    const max = Date.parse(body.sessionExpiresAt) - Date.now();
    expect(idle).toBeGreaterThan(29 * 60_000);
    expect(idle).toBeLessThanOrEqual(30 * 60_000);
    expect(max).toBeGreaterThan(11.9 * 3_600_000);
    expect(max).toBeLessThanOrEqual(12 * 3_600_000);
  });

  it('renewing pushes the idle limit forward but never past the maximum length', async () => {
    const { agent } = await signIn();
    // Pretend the sign-in started 11h50 ago: its end is 10 minutes away.
    await pg.db.execute(sql`update refresh_tokens set session_expires_at = now() + interval '10 minutes', expires_at = now() + interval '5 minutes' where revoked_at is null`);
    const renewed = await agent.post('/api/auth/refresh').set(CSRF).expect(200);
    expect(Date.parse(renewed.body.idleExpiresAt)).toBe(Date.parse(renewed.body.sessionExpiresAt));
    expect(Date.parse(renewed.body.sessionExpiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(renewed.body.expiresIn).toBeLessThanOrEqual(600);
  });

  it('ends a sign-in left idle, and says why', async () => {
    const { agent } = await signIn();
    await pg.db.execute(sql`update refresh_tokens set expires_at = now() - interval '1 second' where revoked_at is null`);
    const res = await agent.post('/api/auth/refresh').set(CSRF).expect(401);
    expect(res.body.code).toBe('SESSION_IDLE');
    expect(res.body.message).toMatch(/30 minutes without activity/);
    // It cannot be brought back, even if the times were changed afterwards
    await pg.db.execute(sql`update refresh_tokens set expires_at = now() + interval '1 hour'`);
    await agent.post('/api/auth/refresh').set(CSRF).expect(401);
  });

  it('ends a sign-in at its maximum length, however active', async () => {
    const { agent } = await signIn();
    await pg.db.execute(sql`update refresh_tokens set session_expires_at = now() - interval '1 second' where revoked_at is null`);
    const res = await agent.post('/api/auth/refresh').set(CSRF).expect(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
    expect(res.body.message).toMatch(/12 hours/);
  });
});
