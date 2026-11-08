import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { createDb } from '../src/db/db';
import { ReferenceService } from '../src/reference/reference.service';
import { AuditService } from '../src/audit/audit.service';
import { EmailService } from '../src/email/email.service';
import { activateAndSignIn, activationToken, createApp, resetDatabase, signInFirstAdmin, STAFF_PASSWORD } from './helpers';

describe('Administration, roles and evidence', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: { authorization: string };

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    const s = await signInFirstAdmin(app);
    admin = { authorization: `Bearer ${s.token}` };
  });
  afterAll(async () => app.close());

  async function signInAs(email: string) {
    const login = await activateAndSignIn(app, email);
    return { authorization: `Bearer ${login.body.accessToken}` };
  }

  it('creates a user waiting for activation, with the chosen roles, and emails an activation link', async () => {
    const depts = await http.get('/api/departments').set(admin).expect(200);
    const pro = depts.body.find((d: { code: string }) => d.code === 'PRO');
    const res = await http
      .post('/api/users')
      .set(admin)
      .send({ email: 'Buyer@Ruliba.com', fullName: 'Grace Buyer', departmentId: pro.id, roles: ['SENDER', 'SIGNER'] })
      .expect(201);
    expect(res.body.user.email).toBe('buyer@ruliba.com');
    expect(res.body.user.status).toBe('PENDING');
    expect(res.body.user.roles.sort()).toEqual(['SENDER', 'SIGNER']);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
    const mail = [...app.get(EmailService).testOutbox].reverse().find((m) => m.to === 'buyer@ruliba.com')!;
    expect(mail.template).toBe('account-activation');
    expect(mail.data.link).toMatch(/\/activate\/[A-Za-z0-9_-]{40,}$/);

    await http.post('/api/users').set(admin).send({ email: 'buyer@ruliba.com', fullName: 'Dup', roles: ['SENDER'] }).expect(409);

    // A sender can use the directory but not the admin user list or settings
    const sender = await signInAs('buyer@ruliba.com');
    await http.get('/api/users/directory').set(sender).expect(200);
    await http.get('/api/users').set(sender).expect(403);
    await http.post('/api/departments').set(sender).send({ code: 'XX', name: 'Nope' }).expect(403);
    await http.get('/api/audit/events').set(sender).expect(403);
  });

  it('activates an account only once, from the newest link, with a strong password', async () => {
    const created = await http.post('/api/users').set(admin).send({ email: 'newbie@ruliba.com', fullName: 'New Person', roles: ['SIGNER'] }).expect(201);
    const id = created.body.user.id as string;
    const first = activationToken(app, 'newbie@ruliba.com');

    // Not active yet: no sign-in, admin cannot just switch it on, and no temporary password reset
    await http.patch(`/api/users/${id}`).set(admin).send({ status: 'ACTIVE' }).expect(400);
    await http.post(`/api/users/${id}/reset-password`).set(admin).expect(400);

    const info = await http.get(`/api/auth/activation/${first}`).expect(200);
    expect(info.body).toEqual({ email: 'newbie@ruliba.com', fullName: 'New Person' });
    await http.get('/api/auth/activation/not-a-real-token-at-all-xxxxxxxx').expect(400);

    // A resent link replaces the first one
    await http.post(`/api/users/${id}/resend-activation`).set(admin).expect(200);
    const second = activationToken(app, 'newbie@ruliba.com');
    expect(second).not.toBe(first);
    await http.post('/api/auth/activate').send({ token: first, newPassword: STAFF_PASSWORD }).expect(400);

    await http.post('/api/auth/activate').send({ token: second, newPassword: 'short' }).expect(400);
    await http.post('/api/auth/activate').send({ token: second, newPassword: STAFF_PASSWORD }).expect(200);
    await http.post('/api/auth/activate').send({ token: second, newPassword: 'Another long passphrase 77' }).expect(400);
    await http.post(`/api/users/${id}/resend-activation`).set(admin).expect(400);

    const login = await http.post('/api/auth/login').send({ email: 'newbie@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    expect(login.body.user.mustChangePassword).toBe(false);
    const listed = (await http.get('/api/users').set(admin).expect(200)).body.find((u: { id: string }) => u.id === id);
    expect(listed.status).toBe('ACTIVE');
    expect(listed.activatedAt).toBeTruthy();
  });

  it('puts a never-activated account back to waiting when it is enabled again', async () => {
    const created = await http.post('/api/users').set(admin).send({ email: 'later@ruliba.com', fullName: 'Later Person', roles: ['SIGNER'] }).expect(201);
    const id = created.body.user.id as string;
    const token = activationToken(app, 'later@ruliba.com');
    await http.patch(`/api/users/${id}`).set(admin).send({ status: 'DISABLED' }).expect(200);
    await http.post('/api/auth/activate').send({ token, newPassword: STAFF_PASSWORD }).expect(400);
    const enabled = await http.patch(`/api/users/${id}`).set(admin).send({ status: 'ACTIVE' }).expect(200);
    expect(enabled.body.status).toBe('PENDING');
  });

  it("ends a disabled user's sessions at once", async () => {
    await http.post('/api/users').set(admin).send({ email: 'leaver@ruliba.com', fullName: 'Leaver', roles: ['SIGNER'] }).expect(201);
    const agent = request.agent(app.getHttpServer());
    await activateAndSignIn(app, 'leaver@ruliba.com');
    await agent.post('/api/auth/login').send({ email: 'leaver@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    const id = (await http.get('/api/users?q=leaver').set(admin)).body[0].id;
    await http.patch(`/api/users/${id}`).set(admin).send({ status: 'DISABLED' }).expect(200);
    await agent.post('/api/auth/refresh').set('x-esign-csrf', '1').expect(401);
    await http.post('/api/auth/login').send({ email: 'leaver@ruliba.com', password: STAFF_PASSWORD }).expect(401);
  });

  it('does not let the last administrator remove their own access', async () => {
    const me = await http.get('/api/auth/me').set(admin).expect(200);
    await http.patch(`/api/users/${me.body.id}`).set(admin).send({ roles: ['SENDER'] }).expect(400);
  });

  it('manages departments, document types, approval chains and the approval currency', async () => {
    await http.post('/api/departments').set(admin).send({ code: 'pro', name: 'Duplicate' }).expect(409);
    const qa = await http.post('/api/departments').set(admin).send({ code: 'qa', name: 'Quality' }).expect(201);
    expect(qa.body.code).toBe('QA');

    const types = await http.get('/api/document-types').set(admin).expect(200);
    expect(types.body.find((t: { code: string }) => t.code === 'POA').eSignAllowed).toBe(false);

    const policies = await http.get('/api/approval-policies').set(admin).expect(200);
    const supply = policies.body.find((p: { name: string }) => p.name === 'Supply contracts');
    expect(supply.steps.map((s: { label: string }) => s.label)).toEqual(['Procurement Manager', 'Finance Director', 'Managing Director']);

    await http
      .put(`/api/approval-policies/${supply.id}`)
      .set(admin)
      .send({
        name: 'Supply contracts',
        documentTypeId: supply.documentTypeId,
        departmentId: null,
        steps: [
          { label: 'Procurement Manager', approverUserId: null, minAmount: null },
          { label: 'Finance Director', approverUserId: null, minAmount: null },
          { label: 'Managing Director', approverUserId: null, minAmount: 50_000_000 },
        ],
      })
      .expect(200);
    const after = await http.get('/api/approval-policies').set(admin).expect(200);
    expect(Number(after.body.find((p: { id: string }) => p.id === supply.id).steps[2].minAmount)).toBe(50_000_000);

    await http.put('/api/settings/approval').set(admin).send({ currency: 'rwf' }).expect(200);
    const s = await http.get('/api/settings/approval').set(admin).expect(200);
    expect(s.body).toEqual({ currency: 'RWF' });
  });

  it('records every action in an unbroken, append-only audit chain', async () => {
    const events = await http.get('/api/audit/events?limit=200').set(admin).expect(200);
    const types = events.body.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['auth.login', 'auth.mfa_enrolled', 'auth.password_changed', 'user.created', 'setup.approval_policy_changed']));
    const check = await http.get('/api/audit/verify').set(admin).expect(200);
    expect(check.body.ok).toBe(true);
    expect(check.body.checked).toBeGreaterThan(10);

    const { pool, db } = createDb(process.env.DATABASE_URL!, 1);
    try {
      const dbError = (p: Promise<unknown>) => p.then(() => 'no error', (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
      expect(await dbError(db.execute(sql`UPDATE audit_events SET type = 'tampered' WHERE id = 2`))).toMatch(/append-only: UPDATE/);
      expect(await dbError(db.execute(sql`DELETE FROM audit_events`))).toMatch(/append-only: DELETE/);
      expect(await dbError(db.execute(sql`TRUNCATE audit_events`))).toMatch(/append-only: TRUNCATE/);

      // Someone with owner rights switches the trigger off and edits a row: the chain check catches it.
      await db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
      await db.execute(sql`UPDATE audit_events SET actor_email = 'someone-else@ruliba.com' WHERE id = 3`);
      await db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
      const broken = await new AuditService({ db }).verifyChain();
      expect(broken).toMatchObject({ ok: false, brokenAtId: 3, reason: 'event content was changed' });
    } finally {
      await pool.end();
    }
  });

  it('issues gap-free, unique reference numbers even when requested at the same moment', async () => {
    const { pool, db } = createDb(process.env.DATABASE_URL!, 10);
    const refs = new ReferenceService();
    try {
      const issued = await Promise.all(Array.from({ length: 25 }, () => db.transaction((tx) => refs.next(tx, 'PRO', 'CON', 2026))));
      expect(new Set(issued).size).toBe(25);
      expect([...issued].sort()[0]).toBe('RCL/PRO/CON/2026/0001');
      expect([...issued].sort()[24]).toBe('RCL/PRO/CON/2026/0025');

      // A failed approval does not use up a number
      await db.transaction(async (tx) => {
        await refs.next(tx, 'PRO', 'CON', 2026);
        tx.rollback();
      }).catch(() => undefined);
      expect(await db.transaction((tx) => refs.next(tx, 'PRO', 'CON', 2026))).toBe('RCL/PRO/CON/2026/0026');
      // New year starts again at 1
      expect(await db.transaction((tx) => refs.next(tx, 'PRO', 'CON', 2027))).toBe('RCL/PRO/CON/2027/0001');
    } finally {
      await pool.end();
    }
  });

  it('reports health without needing sign-in', async () => {
    const res = await http.get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'up', checks: { database: true, queue: true } });
  });
});
