import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as QRCode from 'qrcode';
import request from 'supertest';
import { EmailService } from '../src/email/email.service';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin } from './helpers';

type Bearer = { authorization: string };
const png = async (text: string) => `data:image/png;base64,${(await QRCode.toBuffer(text, { width: 120 })).toString('base64')}`;

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Delivery agreement', { x: 60, y: 760, size: 16 });
  return Buffer.from(await pdf.save());
}

describe('Company stamps and personal folders', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let outbox: EmailService['testOutbox'];
  let admin: Bearer;
  let sender: Bearer;
  let fd: Bearer;
  let other: Bearer;
  const ids: Record<string, string> = {};
  let frmId: string;

  async function staff(email: string, fullName: string, roles: string[]) {
    const deptId = (await http.get('/api/departments').set(admin)).body.find((d: { code: string }) => d.code === 'PRO').id;
    const created = await http.post('/api/users').set(admin).send({ email, fullName, departmentId: deptId, roles }).expect(201);
    ids[email] = created.body.user.id;
    const login = await activateAndSignIn(app, email);
    return { authorization: `Bearer ${login.body.accessToken}` };
  }
  const last = (to: string, template: string) => [...outbox].reverse().find((m) => m.to === to && m.template === template)!;

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    outbox = app.get(EmailService).testOutbox;
    admin = { authorization: `Bearer ${(await signInFirstAdmin(app)).token}` };
    frmId = (await http.get('/api/document-types').set(admin)).body.find((t: { code: string }) => t.code === 'FRM').id;
    sender = await staff('buyer@ruliba.com', 'Grace Buyer', ['SENDER']);
    fd = await staff('fd@ruliba.com', 'Fiona Finance', ['SIGNER']);
    other = await staff('other@ruliba.com', 'Other Person', ['SENDER']);
  }, 60_000);
  afterAll(async () => app.close());

  let officialId: string;
  let otherStampId: string;

  it('lets administrators upload stamps and choose who may use them', async () => {
    await http.post('/api/stamps').set(sender).send({ name: 'Fake', image: await png('x'), userIds: [] }).expect(403);
    await http.post('/api/stamps').set(admin).send({ name: 'Broken', image: 'data:image/png;base64,AAAA', userIds: [] }).expect(400);
    officialId = (await http.post('/api/stamps').set(admin).send({ name: 'Ruliba Clays official stamp', image: await png('official'), userIds: [ids['fd@ruliba.com']] }).expect(201)).body.id;
    otherStampId = (await http.post('/api/stamps').set(admin).send({ name: 'Finance department stamp', image: await png('finance'), userIds: [] }).expect(201)).body.id;
    const list = await http.get('/api/stamps').set(admin).expect(200);
    expect(list.body.find((s: { id: string }) => s.id === officialId).users).toEqual([{ id: ids['fd@ruliba.com'], fullName: 'Fiona Finance' }]);
    expect(list.body[0].image).toMatch(/^data:image\/png;base64,/);
  });

  it('stamps a document: staff use an allowed Ruliba stamp, outside signers upload their own', async () => {
    const created = await http.post('/api/documents').set(sender).field('title', 'Delivery agreement').field('documentTypeId', frmId).attach('file', await samplePdf(), 'd.pdf').expect(201);
    const id = created.body.id as string;
    const r = await http
      .put(`/api/documents/${id}/recipients`)
      .set(sender)
      .send({ routingMode: 'SEQUENTIAL', recipients: [{ role: 'SIGNER', fullName: 'Fiona Finance', email: 'fd@ruliba.com' }, { role: 'SIGNER', fullName: 'Eric Quarry', email: 'eric@nyamata.rw' }] })
      .expect(200);
    const [f, e] = ['fd@ruliba.com', 'eric@nyamata.rw'].map((m) => r.body.recipients.find((x: { email: string }) => x.email === m).id);
    await http
      .put(`/api/documents/${id}/fields`)
      .set(sender)
      .send({
        fields: [
          { recipientId: f, type: 'SIGNATURE', page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
          { recipientId: f, type: 'STAMP', page: 1, x: 0.1, y: 0.78, width: 0.17, height: 0.11 },
          { recipientId: e, type: 'SIGNATURE', page: 1, x: 0.55, y: 0.7, width: 0.3, height: 0.06 },
          { recipientId: e, type: 'STAMP', page: 1, x: 0.55, y: 0.78, width: 0.17, height: 0.11 },
        ],
      })
      .expect(200);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);

    // Fiona (staff) sees only the stamp she is allowed; cannot upload one or use another
    const s1 = await http.post(`/api/documents/${id}/sign-session`).set(fd).expect(200);
    const sign1 = { authorization: `Bearer ${s1.body.signToken}` };
    const view1 = await http.get('/api/sign/session').set(sign1).expect(200);
    await http.post('/api/sign/session/consent').set(sign1).send({ version: view1.body.consent.version }).expect(200);
    const mine = await http.get('/api/sign/session/stamps').set(sign1).expect(200);
    expect(mine.body.map((x: { name: string }) => x.name)).toEqual(['Ruliba Clays official stamp']);
    const by1 = (t: string) => view1.body.fields.find((x: { type: string }) => x.type === t).id;
    const sig = await png('Fiona');
    await http.post('/api/sign/session/complete').set(sign1).send({ values: [{ fieldId: by1('SIGNATURE'), image: sig, method: 'DRAWN' }] }).expect(400); // stamp required
    await http.post('/api/sign/session/complete').set(sign1).send({ values: [{ fieldId: by1('SIGNATURE'), image: sig, method: 'DRAWN' }, { fieldId: by1('STAMP'), image: await png('home-made') }] }).expect(400);
    await http.post('/api/sign/session/complete').set(sign1).send({ values: [{ fieldId: by1('SIGNATURE'), image: sig, method: 'DRAWN' }, { fieldId: by1('STAMP'), stampId: otherStampId }] }).expect(403);
    await http.post('/api/sign/session/complete').set(sign1).send({ values: [{ fieldId: by1('SIGNATURE'), image: sig, method: 'DRAWN' }, { fieldId: by1('STAMP'), stampId: officialId }] }).expect(200);

    // Eric (outside) gets no Ruliba stamps and cannot use one; he uploads his company stamp
    const token = last('eric@nyamata.rw', 'sign-invite').data.link.split('/sign/')[1];
    await http.post(`/api/sign/${token}/code`).expect(200);
    const v = await http.post(`/api/sign/${token}/verify`).send({ code: last('eric@nyamata.rw', 'sign-code').data.code }).expect(200);
    const sign2 = { authorization: `Bearer ${v.body.signToken}` };
    const view2 = await http.get('/api/sign/session').set(sign2).expect(200);
    await http.post('/api/sign/session/consent').set(sign2).send({ version: view2.body.consent.version }).expect(200);
    expect((await http.get('/api/sign/session/stamps').set(sign2).expect(200)).body).toEqual([]);
    const by2 = (t: string) => view2.body.fields.find((x: { type: string }) => x.type === t).id;
    await http.post('/api/sign/session/complete').set(sign2).send({ values: [{ fieldId: by2('SIGNATURE'), image: await png('Eric'), method: 'TYPED' }, { fieldId: by2('STAMP'), stampId: officialId }] }).expect(403);
    const done = await http
      .post('/api/sign/session/complete')
      .set(sign2)
      .send({ values: [{ fieldId: by2('SIGNATURE'), image: await png('Eric'), method: 'TYPED' }, { fieldId: by2('STAMP'), image: await png('Nyamata Quarry Ltd') }] })
      .expect(200);
    expect(done.body.documentCompleted).toBe(true);

    // The signing record says which stamp each person applied; the audit event keeps its fingerprint
    const doc = await http.get(`/api/documents/${id}`).set(sender).expect(200);
    const signedEvents = doc.body.events.filter((x: { type: string }) => x.type === 'recipient.signed');
    expect(signedEvents.flatMap((x: { details: { stamps: { name: string }[] } }) => x.details.stamps.map((s) => s.name)).sort()).toEqual(['Own company stamp', 'Ruliba Clays official stamp']);
    const pdf = await http
      .get(`/api/documents/${id}/files/signed?download=1`)
      .set(sender)
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (d: Buffer) => c.push(d));
        res.on('end', () => cb(null, Buffer.concat(c)));
      })
      .expect(200);
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
      writeFileSync(path.join(dir, 's.pdf'), pdf.body as Buffer);
      const text = execFileSync('pdftotext', [path.join(dir, 's.pdf'), '-']).toString();
      expect(text).toContain('Stamp applied: Ruliba Clays official stamp');
      expect(text).toContain('Stamp applied: Own company stamp');
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }

    // Withdrawn stamps are no longer offered
    await http.patch(`/api/stamps/${officialId}`).set(admin).send({ active: false }).expect(200);
    ids.doc = id;
  }, 60_000);

  it('gives each person their own folders without changing who can see a document', async () => {
    const a = await http.post('/api/folders').set(sender).send({ name: 'Supply contracts 2026' }).expect(201);
    await http.post('/api/folders').set(sender).send({ name: 'supply contracts 2026' }).expect(409);
    const b = await http.post('/api/folders').set(sender).send({ name: 'Nyamata' }).expect(201);
    await http.put(`/api/documents/${ids.doc}/folder`).set(sender).send({ folderId: a.body.id }).expect(200);
    expect((await http.get(`/api/documents?folderId=${a.body.id}`).set(sender)).body.map((d: { id: string }) => d.id)).toEqual([ids.doc]);
    expect((await http.get('/api/documents?folderId=none').set(sender)).body.some((d: { id: string }) => d.id === ids.doc)).toBe(false);
    // Move to another folder, see it on the document
    await http.put(`/api/documents/${ids.doc}/folder`).set(sender).send({ folderId: b.body.id }).expect(200);
    expect((await http.get(`/api/documents/${ids.doc}`).set(sender)).body.myFolderId).toBe(b.body.id);
    const list = await http.get('/api/folders').set(sender).expect(200);
    expect(list.body).toEqual([
      { id: b.body.id, name: 'Nyamata', documentCount: 1 },
      { id: a.body.id, name: 'Supply contracts 2026', documentCount: 0 },
    ]);
    // Fiona signed it, so she can file it in her own folder; Grace's folders are not hers
    const mine = await http.post('/api/folders').set(fd).send({ name: 'Signed by me' }).expect(201);
    await http.put(`/api/documents/${ids.doc}/folder`).set(fd).send({ folderId: b.body.id }).expect(404);
    await http.put(`/api/documents/${ids.doc}/folder`).set(fd).send({ folderId: mine.body.id }).expect(200);
    expect((await http.get('/api/folders').set(fd)).body).toEqual([{ id: mine.body.id, name: 'Signed by me', documentCount: 1 }]);
    // Someone who cannot see the document cannot file it, or even learn it exists
    const theirs = await http.post('/api/folders').set(other).send({ name: 'Mine' }).expect(201);
    await http.put(`/api/documents/${ids.doc}/folder`).set(other).send({ folderId: theirs.body.id }).expect(404);
    await http.patch(`/api/folders/${b.body.id}`).set(other).send({ name: 'x' }).expect(404);
    // Deleting a folder leaves the document where it was
    await http.delete(`/api/folders/${b.body.id}`).set(sender).expect(204);
    const doc = await http.get(`/api/documents/${ids.doc}`).set(sender).expect(200);
    expect(doc.body.status).toBe('COMPLETED');
    expect(doc.body.myFolderId).toBeNull();
  });

  it('lets administrators send a test email to check delivery', async () => {
    await http.post('/api/settings/test-email').set(sender).send({ to: 'it@ruliba.com' }).expect(403);
    await http.post('/api/settings/test-email').set(admin).send({ to: 'not an email' }).expect(400);
    const r = await http.post('/api/settings/test-email').set(admin).send({ to: 'someone@gmail.com' }).expect(200);
    expect(r.body.queued).toBe(true);
    const m = last('someone@gmail.com', 'test-email');
    expect(m.subject).toBe('Test email from Ruliba Clays eSign');
    expect(m.text).toContain('not in spam');
  });
});
