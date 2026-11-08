import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as QRCode from 'qrcode';
import request from 'supertest';
import { EmailService } from '../src/email/email.service';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin } from './helpers';

type Bearer = { authorization: string };

async function samplePdf(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842]).drawText(`Supply agreement page ${i + 1}`, { x: 60, y: 760, size: 16 });
  return Buffer.from(await pdf.save());
}

const png = async (text: string) => `data:image/png;base64,${(await QRCode.toBuffer(text, { width: 120 })).toString('base64')}`;
const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
};

describe('Preparing, sending and signing a document', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let outbox: EmailService['testOutbox'];
  let admin: Bearer;
  let sender: Bearer;
  let financeDirector: Bearer;
  let otherSender: Bearer;
  let auditor: Bearer;
  let typeId: string;
  let deptId: string;

  async function staff(email: string, fullName: string, roles: string[]): Promise<Bearer> {
    const created = await http.post('/api/users').set(admin).send({ email, fullName, departmentId: deptId, roles }).expect(201);
    expect(created.body.user.status).toBe('PENDING');
    const login = await activateAndSignIn(app, email);
    if (login.body.mfaSetupRequired) {
      const { totpNow } = await import('../src/auth/totp');
      const setup = await http.post('/api/auth/mfa/setup').send({ mfaToken: login.body.mfaToken }).expect(200);
      const c = await http.post('/api/auth/mfa/confirm').send({ mfaToken: login.body.mfaToken, code: totpNow(setup.body.secret) }).expect(200);
      login.body.accessToken = c.body.accessToken;
    }
    return { authorization: `Bearer ${login.body.accessToken}` };
  }

  const lastMail = (to: string, template: string) => [...outbox].reverse().find((m) => m.to === to && m.template === template);
  const tokenFrom = (to: string) => lastMail(to, 'sign-invite')!.data.link.split('/sign/')[1];

  function upload(as: Bearer, file: Buffer, name = 'supply.pdf', title = 'Supply agreement, Kigali Builders') {
    return http.post('/api/documents').set(as).field('title', title).field('documentTypeId', typeId).attach('file', file, name);
  }

  async function prepare(as: Bearer, routingMode = 'SEQUENTIAL') {
    const created = await upload(as, await samplePdf()).expect(201);
    const id = created.body.id as string;
    const r = await http
      .put(`/api/documents/${id}/recipients`)
      .set(as)
      .send({
        routingMode,
        recipients: [
          { role: 'SIGNER', fullName: 'Finance Director', email: 'fd@ruliba.com' },
          { role: 'SIGNER', fullName: 'Jean Supplier', email: 'jean@kigalibuilders.rw' },
          { role: 'CC', fullName: 'Archive', email: 'archive@ruliba.com' },
        ],
      })
      .expect(200);
    const find = (email: string) => r.body.recipients.find((x: { email: string }) => x.email === email);
    const fd = find('fd@ruliba.com');
    const jean = find('jean@kigalibuilders.rw');
    await http
      .put(`/api/documents/${id}/fields`)
      .set(as)
      .send({
        fields: [
          { recipientId: fd.id, type: 'SIGNATURE', page: 2, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
          { recipientId: fd.id, type: 'DATE_SIGNED', page: 2, x: 0.1, y: 0.78, width: 0.2, height: 0.03 },
          { recipientId: jean.id, type: 'SIGNATURE', page: 2, x: 0.55, y: 0.7, width: 0.3, height: 0.06 },
          { recipientId: jean.id, type: 'NAME', page: 2, x: 0.55, y: 0.78, width: 0.3, height: 0.03 },
          { recipientId: jean.id, type: 'TEXT', page: 1, x: 0.1, y: 0.3, width: 0.4, height: 0.03, label: 'TIN number' },
          { recipientId: jean.id, type: 'CHECKBOX', page: 1, x: 0.1, y: 0.35, width: 0.03, height: 0.02, label: 'I accept the delivery terms' },
          { recipientId: jean.id, type: 'DROPDOWN', page: 1, x: 0.1, y: 0.4, width: 0.2, height: 0.03, label: 'Payment', options: ['30 days', '60 days'] },
        ],
      })
      .expect(200);
    return { id, fd, jean };
  }

  async function externalSession(email: string) {
    const token = tokenFrom(email);
    const opened = await http.get(`/api/sign/${token}`).expect(200);
    expect(opened.body.state).toBe('ready');
    await http.post(`/api/sign/${token}/code`).expect(200);
    const code = lastMail(email, 'sign-code')!.data.code;
    const v = await http.post(`/api/sign/${token}/verify`).send({ code }).expect(200);
    return { token, sign: { authorization: `Bearer ${v.body.signToken}` } };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    outbox = app.get(EmailService).testOutbox;
    const a = await signInFirstAdmin(app);
    admin = { authorization: `Bearer ${a.token}` };
    deptId = (await http.get('/api/departments').set(admin)).body.find((d: { code: string }) => d.code === 'PRO').id;
    typeId = (await http.get('/api/document-types').set(admin)).body.find((t: { code: string }) => t.code === 'CON').id;
    // Approvals have their own tests (approvals.e2e-spec.ts); here the contract goes straight to signing.
    await http.patch(`/api/document-types/${typeId}`).set(admin).send({ requiresApproval: false }).expect(200);
    sender = await staff('buyer@ruliba.com', 'Grace Buyer', ['SENDER', 'SIGNER']);
    financeDirector = await staff('fd@ruliba.com', 'Finance Director', ['SIGNER', 'APPROVER']);
    otherSender = await staff('other@ruliba.com', 'Other Sender', ['SENDER']);
    auditor = await staff('auditor@ruliba.com', 'Internal Auditor', ['AUDITOR']);
  }, 60_000);
  afterAll(async () => app.close());

  it('refuses files that are not safe PDFs or Word documents', async () => {
    await upload(sender, Buffer.from('just text'), 'notes.txt').expect(400);
    const js = await PDFDocument.create();
    js.addPage();
    js.addJavaScript('x', 'app.alert(1)');
    const res = await upload(sender, Buffer.from(await js.save())).expect(422);
    expect(res.body.message).toMatch(/scripts/);
    await http.post('/api/documents').set(financeDirector).field('title', 'x').field('documentTypeId', typeId).attach('file', await samplePdf(), 'a.pdf').expect(403);
    const poa = (await http.get('/api/document-types').set(admin)).body.find((t: { code: string }) => t.code === 'POA').id;
    await http.post('/api/documents').set(sender).field('title', 'Power of attorney').field('documentTypeId', poa).attach('file', await samplePdf(), 'a.pdf').expect(400);
  });

  (has('soffice') ? it : it.skip)(
    'turns a Word document into PDF and keeps the original with its fingerprint',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'docx-'));
      writeFileSync(path.join(dir, 'contract.txt'), 'Supply contract\n\nRuliba Clays Ltd and the supplier agree as follows.');
      execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${dir}/p`, '--convert-to', 'docx:MS Word 2007 XML', '--outdir', dir, path.join(dir, 'contract.txt')], { timeout: 90_000 });
      const res = await upload(sender, readFileSync(path.join(dir, 'contract.docx')), 'contract.docx', 'Word contract').expect(201);
      const kinds = res.body.files.map((f: { kind: string }) => f.kind);
      expect(kinds).toEqual(['ORIGINAL', 'CONVERTED']);
      expect(res.body.files[0].sha256).not.toBe(res.body.files[1].sha256);
      const pdf = await http.get(`/api/documents/${res.body.id}/files/prepared`).set(sender).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
    },
    120_000,
  );

  it('runs a full sequential signing: staff signer, then an outside signer, then everyone gets the signed copy', async () => {
    const { id } = await prepare(sender);

    // Cannot send while a signer has no signature field
    const bare = await upload(sender, await samplePdf()).expect(201);
    await http
      .put(`/api/documents/${bare.body.id}/recipients`)
      .set(sender)
      .send({ routingMode: 'SEQUENTIAL', recipients: [{ role: 'SIGNER', fullName: 'Someone', email: 'someone@x.rw' }] })
      .expect(200);
    await http.post(`/api/documents/${bare.body.id}/send`).set(sender).send({}).expect(400);

    const sent = await http.post(`/api/documents/${id}/send`).set(sender).send({ emailMessage: 'Please sign by Friday.' }).expect(200);
    expect(sent.body.status).toBe('IN_PROGRESS');
    expect(sent.body.referenceNo).toBe(`RCL/PRO/CON/${new Date().getFullYear()}/0001`);
    // Only step 1 is invited
    expect(lastMail('fd@ruliba.com', 'sign-invite')).toBeDefined();
    expect(lastMail('jean@kigalibuilders.rw', 'sign-invite')).toBeUndefined();
    // A sent document cannot be edited
    await http.put(`/api/documents/${id}/fields`).set(sender).send({ fields: [] }).expect(409);

    // Staff signer signs from the dashboard (their two-step sign-in replaces the emailed code)
    const waiting = await http.get('/api/documents?filter=waiting').set(financeDirector).expect(200);
    expect(waiting.body.map((d: { id: string }) => d.id)).toContain(id);
    const s1 = await http.post(`/api/documents/${id}/sign-session`).set(financeDirector).expect(200);
    const fdSign = { authorization: `Bearer ${s1.body.signToken}` };
    const view1 = await http.get('/api/sign/session').set(fdSign).expect(200);
    expect(view1.body.fields).toHaveLength(2);
    await http.post('/api/sign/session/complete').set(fdSign).send({ values: [] }).expect(400); // no consent yet
    await http.post('/api/sign/session/consent').set(fdSign).send({ version: view1.body.consent.version }).expect(200);
    const sigField = view1.body.fields.find((f: { type: string }) => f.type === 'SIGNATURE');
    await http.post('/api/sign/session/complete').set(fdSign).send({ values: [] }).expect(400); // signature missing
    const done1 = await http
      .post('/api/sign/session/complete')
      .set(fdSign)
      .send({ values: [{ fieldId: sigField.id, image: await png('Finance Director'), method: 'DRAWN' }] })
      .expect(200);
    expect(done1.body.documentCompleted).toBe(false);
    await http.post('/api/sign/session/complete').set(fdSign).send({ values: [] }).expect(409); // cannot sign twice

    // Now the outside signer is invited
    const { token, sign } = await externalSession('jean@kigalibuilders.rw');
    const pdf = await http.get('/api/sign/session/file').set(sign).expect(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const view2 = await http.get('/api/sign/session').set(sign).expect(200);
    await http.post('/api/sign/session/consent').set(sign).send({ version: view2.body.consent.version }).expect(200);
    const by = (t: string) => view2.body.fields.find((f: { type: string }) => f.type === t);
    await http
      .post('/api/sign/session/complete')
      .set(sign)
      .send({ values: [{ fieldId: by('DROPDOWN').id, value: '90 days' }] })
      .expect(400); // not one of the choices
    const done2 = await http
      .post('/api/sign/session/complete')
      .set(sign)
      .send({
        values: [
          { fieldId: by('SIGNATURE').id, image: await png('Jean'), method: 'TYPED' },
          { fieldId: by('TEXT').id, value: '102345678' },
          { fieldId: by('CHECKBOX').id, value: 'true' },
          { fieldId: by('DROPDOWN').id, value: '30 days' },
        ],
      })
      .expect(200);
    expect(done2.body.documentCompleted).toBe(true);

    // Completed, with a signed copy that differs from what was sent and has an extra record page
    const doc = await http.get(`/api/documents/${id}`).set(sender).expect(200);
    expect(doc.body.status).toBe('COMPLETED');
    const signedMeta = doc.body.files.find((f: { kind: string }) => f.kind === 'SEALED');
    expect(doc.body.files.find((f: { kind: string }) => f.kind === 'CERTIFICATE')).toBeTruthy();
    const preparedMeta = doc.body.files.find((f: { kind: string }) => f.kind === 'ORIGINAL');
    expect(signedMeta.sha256).not.toBe(preparedMeta.sha256);
    expect(signedMeta.pageCount).toBe(3);
    const signed = await http.get(`/api/documents/${id}/files/signed?download=1`).set(sender).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(signed.headers['content-disposition']).toMatch(/attachment/);
    if (has('pdftotext')) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'signed-'));
      writeFileSync(path.join(dir, 's.pdf'), signed.body as Buffer);
      const text = execFileSync('pdftotext', [path.join(dir, 's.pdf'), '-']).toString();
      expect(text).toContain('Signing record');
      expect(text).toContain('Jean Supplier');
      expect(text).toContain('102345678');
      expect(text).toContain('one-time code sent to this email address');
      expect(text).toContain('Ruliba staff sign-in with password');
    }
    if (has('pdfsig')) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'sealed-'));
      writeFileSync(path.join(dir, 's.pdf'), signed.body as Buffer);
      let out = '';
      try {
        out = execFileSync('pdfsig', [path.join(dir, 's.pdf')]).toString();
      } catch (e) {
        out = String((e as { stdout?: Buffer }).stdout ?? '');
      }
      expect(out).toContain('Ruliba Clays Ltd - Document Seal');
      expect(out).toMatch(/Signature Validation: Signature is Valid/);
      // Any change after sealing is detected
      const tampered = Buffer.from(signed.body as Buffer);
      const at = tampered.indexOf('Ruliba Clays eSign'); // inside the document info, covered by the seal
      expect(at).toBeGreaterThan(0);
      tampered.write('X', at);
      writeFileSync(path.join(dir, 't.pdf'), tampered);
      let bad = '';
      try {
        bad = execFileSync('pdfsig', [path.join(dir, 't.pdf')]).toString();
      } catch (e) {
        bad = String((e as { stdout?: Buffer }).stdout ?? '');
      }
      expect(bad).not.toMatch(/Signature Validation: Signature is Valid/);
    }

    // "Check a document": the sealed copy is recognised; a changed copy is not
    const check = await http.post('/api/verify').attach('file', signed.body as Buffer, 'copy.pdf').expect(200);
    expect(check.body).toMatchObject({ match: true, sealed: true, title: 'Supply agreement, Kigali Builders' });
    expect(check.body.signers.map((x: { fullName: string }) => x.fullName)).toEqual(['Finance Director', 'Jean Supplier']);
    const other = await http.post('/api/verify').attach('file', await samplePdf(), 'other.pdf').expect(200);
    expect(other.body.match).toBe(false);
    const pem = await http.get('/api/verify/authority-certificate').expect(200);
    expect(String(pem.text ?? pem.body)).toContain('BEGIN CERTIFICATE');

    // Document emails read as coming from the sender (replies go to them); codes come from eSign itself
    expect(lastMail('jean@kigalibuilders.rw', 'sign-invite')?.onBehalfOf).toEqual({ name: 'Grace Buyer', email: 'buyer@ruliba.com' });
    expect(lastMail('jean@kigalibuilders.rw', 'sign-code')?.onBehalfOf).toBeUndefined();
    expect(lastMail('buyer@ruliba.com', 'document-completed')?.onBehalfOf).toBeUndefined();

    // Everyone, including the copy recipient and the sender, gets the signed copy attached
    for (const to of ['fd@ruliba.com', 'jean@kigalibuilders.rw', 'archive@ruliba.com', 'buyer@ruliba.com']) {
      expect(lastMail(to, 'document-completed')?.attachments).toHaveLength(1);
    }
    // The used link now only says "already signed"
    expect((await http.get(`/api/sign/${token}`).expect(200)).body.state).toBe('completed');
    await http.post(`/api/sign/${token}/code`).expect(403);
    await http.get('/api/sign/session').set(sign).expect(409);

    // Contacts remember the outside signer; the audit chain is intact
    const contacts = await http.get('/api/contacts?q=kigali').set(sender).expect(200);
    expect(contacts.body[0]).toMatchObject({ email: 'jean@kigalibuilders.rw', documentCount: 1 });
    const types = doc.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['document.created', 'document.sent', 'recipient.invited', 'recipient.verified', 'document.viewed', 'recipient.consented', 'recipient.signed', 'document.completed']),
    );
    expect((await http.get('/api/audit/verify').set(admin).expect(200)).body.ok).toBe(true);
  }, 60_000);

  it('keeps one-time codes strict: wrong codes run out, old codes stop working', async () => {
    const { id } = await prepare(sender, 'PARALLEL');
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    const token = tokenFrom('jean@kigalibuilders.rw');
    await http.post(`/api/sign/${token}/code`).expect(200);
    await http.post(`/api/sign/${token}/code`).expect(429); // resend too soon
    for (let i = 4; i >= 1; i--) {
      const r = await http.post(`/api/sign/${token}/verify`).send({ code: '000000' }).expect(401);
      expect(r.body.message).toContain(`${i} tries left`);
    }
    await http.post(`/api/sign/${token}/verify`).send({ code: '000000' }).expect(401);
    const real = lastMail('jean@kigalibuilders.rw', 'sign-code')!.data.code;
    await http.post(`/api/sign/${token}/verify`).send({ code: real }).expect(401); // used up: ask for a new one
    await http.get('/api/sign/session').set({ authorization: 'Bearer not-a-token' }).expect(401);
    await http.get('/api/sign/this-is-not-a-real-token-at-all-0000000000000').expect(200).expect((r) => expect(r.body.state).toBe('invalid'));
  });

  it('stops everything when someone declines, and tells the sender why', async () => {
    const { id } = await prepare(sender, 'PARALLEL');
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    const { sign } = await externalSession('jean@kigalibuilders.rw');
    await http.post('/api/sign/session/decline').set(sign).send({ reason: 'The price on page 1 is wrong.' }).expect(200);
    const doc = await http.get(`/api/documents/${id}`).set(sender).expect(200);
    expect(doc.body.status).toBe('DECLINED');
    expect(doc.body.recipients.find((r: { email: string }) => r.email === 'fd@ruliba.com').status).toBe('CANCELLED');
    expect(lastMail('buyer@ruliba.com', 'document-declined')!.data.reason).toBe('The price on page 1 is wrong.');
    await http.post(`/api/documents/${id}/sign-session`).set(financeDirector).expect(409);
  });

  it('lets the sender cancel a document, after which links stop working', async () => {
    const { id } = await prepare(sender, 'PARALLEL');
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    const token = tokenFrom('jean@kigalibuilders.rw');
    await http.post(`/api/documents/${id}/void`).set(otherSender).send({ reason: 'not mine' }).expect(404);
    await http.post(`/api/documents/${id}/void`).set(sender).send({ reason: 'Wrong supplier address.' }).expect(200);
    expect((await http.get(`/api/sign/${token}`).expect(200)).body.state).toBe('voided');
    await http.post(`/api/sign/${token}/code`).expect(403);
    expect(lastMail('jean@kigalibuilders.rw', 'document-voided')).toBeDefined();
  });

  it('shows a document only to its sender, the people on it, and auditors', async () => {
    const { id } = await prepare(sender);
    await http.get(`/api/documents/${id}`).set(otherSender).expect(404); // other people's drafts do not exist for them
    await http.get(`/api/documents/${id}/files/prepared`).set(otherSender).expect(404);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    await http.get(`/api/documents/${id}`).set(financeDirector).expect(200); // on the document
    await http.get(`/api/documents/${id}`).set(auditor).expect(200);
    await http.get(`/api/documents/${id}`).set(admin).expect(404); // admins manage the system, not documents
    await http.patch(`/api/documents/${id}`).set(financeDirector).send({ title: 'Changed' }).expect(403);
    const counts = await http.get('/api/documents/counts').set(sender).expect(200);
    expect(counts.body.progress).toBeGreaterThanOrEqual(1);
  });

  it('saves a staff member\'s signature and offers it only inside a signed-in session', async () => {
    await http.put('/api/me/signatures').set(financeDirector).send({ kind: 'SIGNATURE', method: 'DRAWN', image: await png('FD saved') }).expect(200);
    const mine = await http.get('/api/me/signatures').set(financeDirector).expect(200);
    expect(mine.body[0]).toMatchObject({ kind: 'SIGNATURE', method: 'DRAWN' });
    const { id } = await prepare(sender);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    const s = await http.post(`/api/documents/${id}/sign-session`).set(financeDirector).expect(200);
    const view = await http.get('/api/sign/session').set({ authorization: `Bearer ${s.body.signToken}` }).expect(200);
    expect(view.body.savedSignatures).toEqual(['SIGNATURE']);
    const saved = await http.get('/api/sign/session/saved-signature?kind=SIGNATURE').set({ authorization: `Bearer ${s.body.signToken}` }).expect(200);
    expect(saved.body.image).toMatch(/^data:image\/png;base64,/);
  });
});
