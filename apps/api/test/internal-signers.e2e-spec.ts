import { INestApplication } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { EmailService } from '../src/email/email.service';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin, STAFF_PASSWORD } from './helpers';

type Bearer = { authorization: string };

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Service agreement', { x: 60, y: 760, size: 16 });
  return Buffer.from(await pdf.save());
}

describe('Internal and external signers', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let outbox: EmailService['testOutbox'];
  let admin: Bearer;
  let sender: Bearer;
  let signerOnly: Bearer;
  let frmId: string;

  const last = (to: string, template: string) => [...outbox].reverse().find((m) => m.to === to && m.template === template);

  let deptId: string;
  async function staff(email: string, fullName: string, roles: string[]) {
    await http.post('/api/users').set(admin).send({ email, fullName, roles, departmentId: deptId }).expect(201);
    const login = await activateAndSignIn(app, email);
    return { authorization: `Bearer ${login.body.accessToken}` };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    outbox = app.get(EmailService).testOutbox;
    admin = { authorization: `Bearer ${(await signInFirstAdmin(app)).token}` };
    deptId = (await http.get('/api/departments').set(admin)).body.find((d: { code: string }) => d.code === 'PRO').id;
    sender = await staff('sender@ruliba.com', 'Sam Sender', ['SENDER', 'SIGNER']);
    signerOnly = await staff('signer@ruliba.com', 'Sia Signer', ['SIGNER']);
    await staff('approver@ruliba.com', 'Ann Approver', ['APPROVER']);
    frmId = (await http.get('/api/document-types').set(admin)).body.find((t: { code: string }) => t.code === 'FRM').id;
  });
  afterAll(async () => app.close());

  it('lists only staff with the Signer role, including those waiting for activation', async () => {
    await http.post('/api/users').set(admin).send({ email: 'newstaff@ruliba.com', fullName: 'Nina New', roles: ['SIGNER'] }).expect(201);
    const res = await http.get('/api/users/directory?signers=1').set(sender).expect(200);
    const emails = res.body.map((u: { email: string }) => u.email);
    expect(emails).toEqual(expect.arrayContaining(['sender@ruliba.com', 'signer@ruliba.com', 'newstaff@ruliba.com']));
    expect(emails).not.toContain('approver@ruliba.com');
    expect(res.body.find((u: { email: string }) => u.email === 'newstaff@ruliba.com').pending).toBe(true);
    expect(res.body.find((u: { email: string }) => u.email === 'signer@ruliba.com').pending).toBe(false);
  });

  it('lets a sender add a colleague as a Signer who must activate first; nobody else may', async () => {
    await http.post('/api/users/signers').set(signerOnly).send({ email: 'x@ruliba.com', fullName: 'Not Allowed' }).expect(403);

    const created = await http.post('/api/users/signers').set(sender).send({ email: 'Colleague@Ruliba.com', fullName: 'Cleo Colleague' }).expect(201);
    expect(created.body).toMatchObject({ email: 'colleague@ruliba.com', pending: true, existing: false });
    expect(last('colleague@ruliba.com', 'account-activation')).toBeDefined();
    const listed = (await http.get('/api/users?q=colleague').set(admin)).body[0];
    expect(listed).toMatchObject({ status: 'PENDING', roles: ['SIGNER'] });

    // Adding the same person again just returns them; someone without the Signer role is refused
    const again = await http.post('/api/users/signers').set(sender).send({ email: 'colleague@ruliba.com', fullName: 'Cleo' }).expect(201);
    expect(again.body).toMatchObject({ existing: true, pending: true });
    await http.post('/api/users/signers').set(sender).send({ email: 'approver@ruliba.com', fullName: 'Ann' }).expect(409);
  });

  it('makes a pending internal signer activate before signing, then lets them sign', async () => {
    const created = await http.post('/api/documents').set(sender).field('title', 'Service agreement').field('documentTypeId', frmId).attach('file', await samplePdf(), 'a.pdf').expect(201);
    const id = created.body.id as string;
    const r = await http
      .put(`/api/documents/${id}/recipients`)
      .set(sender)
      .send({ routingMode: 'PARALLEL', recipients: [{ role: 'SIGNER', fullName: 'Cleo Colleague', email: 'colleague@ruliba.com' }, { role: 'SIGNER', fullName: 'Olive Outside', email: 'olive@supplier.rw' }] })
      .expect(200);
    const cleo = r.body.recipients.find((x: { email: string }) => x.email === 'colleague@ruliba.com');
    const olive = r.body.recipients.find((x: { email: string }) => x.email === 'olive@supplier.rw');
    expect(cleo.isExternal).toBe(false);
    expect(olive.isExternal).toBe(true);
    await http
      .put(`/api/documents/${id}/fields`)
      .set(sender)
      .send({
        fields: [
          { recipientId: cleo.id, type: 'SIGNATURE', page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
          { recipientId: olive.id, type: 'SIGNATURE', page: 1, x: 0.55, y: 0.7, width: 0.3, height: 0.06 },
        ],
      })
      .expect(200);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);

    // Cleo's invitation goes to the document in eSign (sign-in first), with an activation link first; no emailed code
    const invite = last('colleague@ruliba.com', 'sign-invite')!;
    expect(invite.data.internal).toBe('1');
    expect(invite.data.link).toMatch(new RegExp(`/documents/${id}/sign$`));
    expect(invite.data.activationLink).toContain('/activate/');
    expect(invite.data.activationLink.endsWith(`?next=${encodeURIComponent(`/documents/${id}/sign`)}`)).toBe(true);
    expect(invite.html).toContain('Activate my account');
    expect(invite.text).not.toMatch(/one-time code/);

    // The outside signer still gets a personal link and an emailed code
    const outside = last('olive@supplier.rw', 'sign-invite')!;
    expect(outside.data.internal).toBe('');
    expect(outside.data.activationLink).toBe('');
    const oliveToken = outside.data.link.split('/sign/')[1];
    expect((await http.get(`/api/sign/${oliveToken}`).expect(200)).body).toMatchObject({ state: 'ready' });
    expect((await http.get(`/api/sign/${oliveToken}`).expect(200)).body.staffSignPath).toBeUndefined();
    await http.post(`/api/sign/${oliveToken}/code`).expect(200);

    // Not activated yet: cannot sign in, so cannot sign
    await http.post('/api/auth/login').send({ email: 'colleague@ruliba.com', password: STAFF_PASSWORD }).expect(401);

    // After activating (with the link from the invitation), signing in opens the signing session
    const activationToken = invite.data.activationLink.split('/activate/')[1].split('?')[0];
    await http.post('/api/auth/activate').send({ token: activationToken, newPassword: STAFF_PASSWORD }).expect(200);
    const login = await http.post('/api/auth/login').send({ email: 'colleague@ruliba.com', password: STAFF_PASSWORD }).expect(200);
    await http.post(`/api/documents/${id}/sign-session`).set({ authorization: `Bearer ${login.body.accessToken}` }).expect(200);
  });

  it('sends staff to eSign instead of an emailed code, even from an older link', async () => {
    const created = await http.post('/api/documents').set(sender).field('title', 'Leave form').field('documentTypeId', frmId).attach('file', await samplePdf(), 'b.pdf').expect(201);
    const id = created.body.id as string;
    const r = await http.put(`/api/documents/${id}/recipients`).set(sender).send({ routingMode: 'PARALLEL', recipients: [{ role: 'SIGNER', fullName: 'Sia Signer', email: 'signer@ruliba.com' }] }).expect(200);
    const sia = r.body.recipients[0];
    await http.put(`/api/documents/${id}/fields`).set(sender).send({ fields: [{ recipientId: sia.id, type: 'SIGNATURE', page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06 }] }).expect(200);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    const invite = last('signer@ruliba.com', 'sign-invite')!;
    expect(invite.data.link).toMatch(new RegExp(`/documents/${id}/sign$`));
    expect(invite.data.activationLink).toBe('');

    // An invitation sent before this change carried a link token: it now points to eSign and refuses codes
    const { createDb } = await import('../src/db/db');
    const { sha256Hex } = await import('../src/common/crypto.service');
    const { sql } = await import('drizzle-orm');
    const { pool, db } = createDb(process.env.DATABASE_URL!, 1);
    const oldToken = 'old-staff-link-token-0123456789abcdefghijklmnop';
    await db.execute(sql`update recipients set access_token_hash = ${sha256Hex(oldToken)} where id = ${sia.id}`);
    await pool.end();
    const opened = await http.get(`/api/sign/${oldToken}`).expect(200);
    expect(opened.body.staffSignPath).toBe(`/documents/${id}/sign`);
    const refused = await http.post(`/api/sign/${oldToken}/code`).expect(403);
    expect(refused.body.message).toMatch(/sign in to eSign/);
    await http.post(`/api/documents/${id}/sign-session`).set(signerOnly).expect(200);
  });
});
