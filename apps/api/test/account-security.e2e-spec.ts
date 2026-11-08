import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { totpNow } from '../src/auth/totp';
import { EmailService } from '../src/email/email.service';
import { SmsService } from '../src/sms/sms.service';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin, STAFF_PASSWORD } from './helpers';

describe('Password reset and two-step sign-in by app or SMS', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: { authorization: string };
  let mail: EmailService['testOutbox'];
  let sms: SmsService['testOutbox'];

  const lastMail = (to: string, template: string) => [...mail].reverse().find((m) => m.to === to && m.template === template);
  const resetToken = (to: string) => lastMail(to, 'password-reset')!.data.link.split('/reset-password/')[1];
  const lastSmsCode = (to: string) => /^(\d{6}) /.exec([...sms].reverse().find((m) => m.to === to)!.text)![1];
  const userId = async (email: string) => (await http.get(`/api/users?q=${email}`).set(admin)).body[0].id as string;

  async function addUser(email: string, extra: Record<string, unknown> = {}) {
    await http.post('/api/users').set(admin).send({ email, fullName: 'Test Person', roles: ['SENDER', 'SIGNER'], ...extra }).expect(201);
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    mail = app.get(EmailService).testOutbox;
    sms = app.get(SmsService).testOutbox;
    const s = await signInFirstAdmin(app);
    admin = { authorization: `Bearer ${s.token}` };
  });
  afterAll(async () => app.close());

  it('resets a forgotten password from an emailed one-use link, and ends every session', async () => {
    await addUser('forgetful@ruliba.com');
    await activateAndSignIn(app, 'forgetful@ruliba.com');
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ email: 'forgetful@ruliba.com', password: STAFF_PASSWORD }).expect(200);

    // Same answer for an unknown email, and nothing is sent
    const before = mail.length;
    await http.post('/api/auth/password/forgot').send({ email: 'nobody@ruliba.com' }).expect(200, { ok: true });
    expect(mail.length).toBe(before);

    await http.post('/api/auth/password/forgot').send({ email: 'Forgetful@Ruliba.com' }).expect(200, { ok: true });
    const token = resetToken('forgetful@ruliba.com');
    expect(lastMail('forgetful@ruliba.com', 'password-reset')!.data.byAdmin).toBe('');

    // A second request within a minute sends nothing new
    await http.post('/api/auth/password/forgot').send({ email: 'forgetful@ruliba.com' }).expect(200);
    expect(resetToken('forgetful@ruliba.com')).toBe(token);

    const info = await http.get(`/api/auth/password/reset/${token}`).expect(200);
    expect(info.body).toEqual({ email: 'forgetful@ruliba.com', fullName: 'Test Person' });
    await http.post('/api/auth/password/reset').send({ token, newPassword: 'short' }).expect(400);
    await http.post('/api/auth/password/reset').send({ token, newPassword: 'A brand new passphrase 31' }).expect(200);
    await http.post('/api/auth/password/reset').send({ token, newPassword: 'Another new passphrase 32' }).expect(400);
    await http.get(`/api/auth/password/reset/${token}`).expect(400);

    await agent.post('/api/auth/refresh').set('x-esign-csrf', '1').expect(401);
    await http.post('/api/auth/login').send({ email: 'forgetful@ruliba.com', password: STAFF_PASSWORD }).expect(401);
    await http.post('/api/auth/login').send({ email: 'forgetful@ruliba.com', password: 'A brand new passphrase 31' }).expect(200);
  });

  it('refuses any of the last 5 passwords on reset and on change, and keeps only 5', async () => {
    await addUser('historian@ruliba.com');
    let token = (await activateAndSignIn(app, 'historian@ruliba.com')).body.accessToken as string;
    const used = [STAFF_PASSWORD];
    let current = STAFF_PASSWORD;
    // Four more changes: five passwords used in all
    for (let i = 1; i <= 4; i++) {
      const next = `History passphrase number ${i}`;
      const res = await http.post('/api/auth/password').set({ authorization: `Bearer ${token}` }).send({ currentPassword: current, newPassword: next }).expect(200);
      token = res.body.accessToken;
      used.push(next);
      current = next;
    }
    // Change: going back to any of the five is refused
    const refused = await http.post('/api/auth/password').set({ authorization: `Bearer ${token}` }).send({ currentPassword: current, newPassword: used[1] }).expect(403);
    expect(refused.body.message).toMatch(/last 5 passwords/);

    // Reset: the same rule, and the link still works for an allowed password
    await http.post('/api/auth/password/forgot').send({ email: 'historian@ruliba.com' }).expect(200);
    const link = resetToken('historian@ruliba.com');
    for (const old of used) {
      const r = await http.post('/api/auth/password/reset').send({ token: link, newPassword: old }).expect(400);
      expect(r.body.errors[0]).toEqual({ field: 'newPassword', message: expect.stringMatching(/last 5 passwords/) });
    }
    await http.post('/api/auth/password/reset').send({ token: link, newPassword: 'History passphrase number 5' }).expect(200);

    // Now the very first password is six back, so it may be used again
    const login = await http.post('/api/auth/login').send({ email: 'historian@ruliba.com', password: 'History passphrase number 5' }).expect(200);
    await http
      .post('/api/auth/password')
      .set({ authorization: `Bearer ${login.body.accessToken}` })
      .send({ currentPassword: 'History passphrase number 5', newPassword: STAFF_PASSWORD })
      .expect(200);
  });

  it('sends a new activation link instead when the account was never activated', async () => {
    await addUser('notyet@ruliba.com');
    const first = lastMail('notyet@ruliba.com', 'account-activation')!.data.link;
    await new Promise((r) => setTimeout(r, 10));
    // Within a minute of the first activation email nothing new is sent
    await http.post('/api/auth/password/forgot').send({ email: 'notyet@ruliba.com' }).expect(200);
    expect(lastMail('notyet@ruliba.com', 'account-activation')!.data.link).toBe(first);
    expect(lastMail('notyet@ruliba.com', 'password-reset')).toBeUndefined();
  });

  it('lets an administrator reset a password: the old one stops at once and a link is emailed', async () => {
    await addUser('reset-by-admin@ruliba.com');
    await activateAndSignIn(app, 'reset-by-admin@ruliba.com');
    const res = await http.post(`/api/users/${await userId('reset-by-admin@ruliba.com')}/reset-password`).set(admin).expect(200);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(lastMail('reset-by-admin@ruliba.com', 'password-reset')!.data.byAdmin).toBe('1');
    await http.post('/api/auth/login').send({ email: 'reset-by-admin@ruliba.com', password: STAFF_PASSWORD }).expect(401);
    await http.post('/api/auth/password/reset').send({ token: resetToken('reset-by-admin@ruliba.com'), newPassword: 'Chosen after reset 2026' }).expect(200);
    await http.post('/api/auth/login').send({ email: 'reset-by-admin@ruliba.com', password: 'Chosen after reset 2026' }).expect(200);
  });

  it('offers both an authenticator app and SMS', async () => {
    const res = await http.get('/api/auth/mfa/options').expect(200);
    expect(res.body).toEqual({ app: true, sms: true });
  });

  it('requires two-step sign-in when an administrator asks for it, and enrols by SMS', async () => {
    await addUser('texter@ruliba.com', { mfaRequired: true });
    const first = await activateAndSignIn(app, 'texter@ruliba.com');
    expect(first.body.mfaSetupRequired).toBe(true);
    const mfaToken = first.body.mfaToken as string;

    await http.post('/api/auth/mfa/sms/setup').send({ mfaToken, phone: '12345' }).expect(400);
    const setup = await http.post('/api/auth/mfa/sms/setup').send({ mfaToken, phone: '0788 123 456' }).expect(200);
    expect(setup.body.phoneHint).toBe('•••• 3456');
    const code = lastSmsCode('+250788123456');
    // One new code a minute
    await http.post('/api/auth/mfa/sms/setup').send({ mfaToken, phone: '0788123456' }).expect(429);

    await http.post('/api/auth/mfa/confirm').send({ mfaToken, code: code === '000000' ? '111111' : '000000' }).expect(401);
    const confirmed = await http.post('/api/auth/mfa/confirm').send({ mfaToken, code }).expect(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    expect(confirmed.body.user.mfaMethod).toBe('SMS');
    expect(confirmed.body.user.mfaRequired).toBe(true);

    // Next sign-in: a code is texted at once (even within the minute) and is needed
    const login = await http.post('/api/auth/login').send({ email: 'texter@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    expect(login.body).toMatchObject({ mfaRequired: true, method: 'SMS', phoneHint: '•••• 3456' });
    const next = lastSmsCode('+250788123456');
    expect(next).not.toBe(code);
    await http.post('/api/auth/mfa/sms/resend').send({ mfaToken: login.body.mfaToken }).expect(429);
    await http.post('/api/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code }).expect(401); // old code
    const signedIn = await http.post('/api/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: next }).expect(200);
    expect(signedIn.body.accessToken).toBeTruthy();
    await http.post('/api/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: next }).expect(401); // used once

    const listed = (await http.get('/api/users').set(admin)).body.find((u: { email: string }) => u.email === 'texter@ruliba.com');
    expect(listed).toMatchObject({ mfaEnabled: true, mfaMethod: 'SMS', mfaRequired: true });
  });

  it('runs out an SMS code after five wrong tries', async () => {
    await addUser('fumbler@ruliba.com', { mfaRequired: true });
    const first = await activateAndSignIn(app, 'fumbler@ruliba.com');
    await http.post('/api/auth/mfa/sms/setup').send({ mfaToken: first.body.mfaToken, phone: '+250722000111' }).expect(200);
    const code = lastSmsCode('+250722000111');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await http.post('/api/auth/mfa/confirm').send({ mfaToken: first.body.mfaToken, code: wrong }).expect(401);
    await http.post('/api/auth/mfa/confirm').send({ mfaToken: first.body.mfaToken, code }).expect(401);
  });

  it('ends sessions when two-step sign-in becomes required, then lets the person choose the app', async () => {
    await addUser('volunteer@ruliba.com');
    const agent = request.agent(app.getHttpServer());
    await activateAndSignIn(app, 'volunteer@ruliba.com');
    await agent.post('/api/auth/login').send({ email: 'volunteer@ruliba.com', password: STAFF_PASSWORD }).expect(200);

    const updated = await http.patch(`/api/users/${await userId('volunteer@ruliba.com')}`).set(admin).send({ mfaRequired: true }).expect(200);
    expect(updated.body.mfaRequired).toBe(true);
    await agent.post('/api/auth/refresh').set('x-esign-csrf', '1').expect(401);

    const login = await http.post('/api/auth/login').send({ email: 'volunteer@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    expect(login.body.mfaSetupRequired).toBe(true);
    const setup = await http.post('/api/auth/mfa/setup').send({ mfaToken: login.body.mfaToken }).expect(200);
    const confirmed = await http.post('/api/auth/mfa/confirm').send({ mfaToken: login.body.mfaToken, code: totpNow(setup.body.secret) }).expect(200);
    expect(confirmed.body.user.mfaMethod).toBe('TOTP');
    const again = await http.post('/api/auth/login').send({ email: 'volunteer@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    expect(again.body).toMatchObject({ mfaRequired: true, method: 'TOTP' });
  });

  it('lets someone turn on SMS sign-in themselves from their account', async () => {
    await addUser('selfserve@ruliba.com');
    const login = await activateAndSignIn(app, 'selfserve@ruliba.com');
    const me = { authorization: `Bearer ${login.body.accessToken}` };
    expect((await http.get('/api/auth/me').set(me)).body).toMatchObject({ mfaEnabled: false, mfaRequired: false, mfaMethod: null });
    await http.post('/api/auth/mfa/sms/setup').set(me).send({ phone: '+250733444555' }).expect(200);
    await http.post('/api/auth/mfa/confirm').set(me).send({ code: lastSmsCode('+250733444555') }).expect(200);
    expect((await http.get('/api/auth/me').set(me)).body).toMatchObject({ mfaEnabled: true, mfaMethod: 'SMS' });
    // Cannot be switched without an administrator reset
    await http.post('/api/auth/mfa/setup').set(me).send({}).expect(409);
  });
});
