import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, createApp, freshCode, resetDatabase, signInFirstAdmin } from './helpers';
import { totpNow } from '../src/auth/totp';

const CSRF = { 'x-esign-csrf': '1' };

describe('Sign-in, MFA and sessions', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const a = await http.post('/api/auth/login').send({ email: 'ghost@ruliba.com', password: 'whatever-123' }).expect(401);
    const b = await http.post('/api/auth/login').send({ email: ADMIN.email, password: 'wrong-password-1' }).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rejects malformed input with field messages', async () => {
    const res = await http.post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('forces an administrator to enrol MFA, then to replace the seed password', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
    expect(login.body).toEqual({ mfaSetupRequired: true, mfaToken: expect.any(String) });
    expect(login.body.accessToken).toBeUndefined();

    // The set-up token cannot be used as a sign-in token
    await agent.get('/api/auth/me').set('authorization', `Bearer ${login.body.mfaToken}`).expect(401);

    const setup = await agent.post('/api/auth/mfa/setup').send({ mfaToken: login.body.mfaToken }).expect(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Ruliba%20Clays%20eSign/);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    await agent.post('/api/auth/mfa/confirm').send({ mfaToken: login.body.mfaToken, code: '000000' }).expect(401);
    const confirm = await agent.post('/api/auth/mfa/confirm').send({ mfaToken: login.body.mfaToken, code: totpNow(setup.body.secret) }).expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    expect(confirm.body.user.mustChangePassword).toBe(true);
    expect(confirm.headers['set-cookie'][0]).toMatch(/esign_rt=.*HttpOnly.*SameSite=Strict/i);

    const bearer = { authorization: `Bearer ${confirm.body.accessToken}` };
    const blocked = await agent.get('/api/users').set(bearer).expect(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await agent.get('/api/auth/me').set(bearer).expect(200);

    // Weak or reused passwords are refused
    await agent.post('/api/auth/password').set(bearer).send({ currentPassword: ADMIN.password, newPassword: 'ruliba-password-2026' }).expect(403);
    const ok = await agent
      .post('/api/auth/password')
      .set(bearer)
      .send({ currentPassword: ADMIN.password, newPassword: 'Another long passphrase 7' })
      .expect(200);
    expect(ok.body.user.mustChangePassword).toBe(false);
    await agent.get('/api/users').set({ authorization: `Bearer ${ok.body.accessToken}` }).expect(200);

    // Next sign-in asks for the code, refuses a replayed code, accepts a recovery code once
    const again = await http.post('/api/auth/login').send({ email: ADMIN.email, password: 'Another long passphrase 7' }).expect(200);
    expect(again.body.mfaRequired).toBe(true);
    const code = freshCode(setup.body.secret);
    await http.post('/api/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code }).expect(200);
    await http.post('/api/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code }).expect(401); // replay
    const rc = confirm.body.recoveryCodes[0];
    await http.post('/api/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code: rc }).expect(200);
    await http.post('/api/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code: rc }).expect(401); // used up
  });

  it('rotates refresh tokens and revokes the whole sign-in when an old one is reused', async () => {
    await resetDatabase();
    const { agent } = await signInFirstAdmin(app);

    // Missing CSRF header is refused
    await agent.post('/api/auth/refresh').expect(400);

    const first = await agent.post('/api/auth/refresh').set(CSRF).expect(200);
    const stolenCookie = first.headers['set-cookie'][0].split(';')[0];
    const second = await agent.post('/api/auth/refresh').set(CSRF).expect(200); // agent now holds a newer token
    expect(second.body.accessToken).toEqual(expect.any(String));

    // An attacker replays the older cookie: refused, and the real user's newer token dies too
    await request(app.getHttpServer()).post('/api/auth/refresh').set(CSRF).set('cookie', stolenCookie).expect(401);
    await agent.post('/api/auth/refresh').set(CSRF).expect(401);
  });

  it('locks an account for 15 minutes after 5 wrong passwords', async () => {
    await resetDatabase();
    for (let i = 0; i < 5; i++) await http.post('/api/auth/login').send({ email: ADMIN.email, password: `wrong-${i}-password` }).expect(401);
    // Even the right password is refused while locked
    await http.post('/api/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(401);
  });

  it('logs out by ending the refresh token', async () => {
    await resetDatabase();
    const { agent } = await signInFirstAdmin(app);
    await agent.post('/api/auth/logout').set(CSRF).expect(204);
    await agent.post('/api/auth/refresh').set(CSRF).expect(401);
  });
});
