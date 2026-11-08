import { INestApplication } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { JobsService } from '../src/documents/jobs.service';
import { EmailService } from '../src/email/email.service';
import { activateAndSignIn, createApp, resetDatabase, signInFirstAdmin } from './helpers';

type Bearer = { authorization: string };

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Supply agreement', { x: 60, y: 760, size: 16 });
  return Buffer.from(await pdf.save());
}

/** Phase 2 and 3: approvals, templates, reminders and expiry, notifications, reports and retention. */
describe('Approvals, templates, reminders and reports', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let outbox: EmailService['testOutbox'];
  let admin: Bearer;
  let sender: Bearer;
  let pm: Bearer;
  let fd: Bearer;
  let md: Bearer;
  const ids: Record<string, string> = {};
  let conId: string;
  let frmId: string;
  let deptId: string;

  async function staff(email: string, fullName: string, roles: string[]) {
    const created = await http.post('/api/users').set(admin).send({ email, fullName, departmentId: deptId, roles }).expect(201);
    ids[email] = created.body.user.id;
    const login = await activateAndSignIn(app, email);
    return { authorization: `Bearer ${login.body.accessToken}` };
  }

  const mails = (to: string, template: string) => outbox.filter((m) => m.to === to && m.template === template);

  async function draft(typeId: string, value: number | null, title = 'Supply of clay, Nyamata quarry') {
    const created = await http.post('/api/documents').set(sender).field('title', title).field('documentTypeId', typeId).attach('file', await samplePdf(), 'contract.pdf').expect(201);
    const id = created.body.id as string;
    await http.patch(`/api/documents/${id}`).set(sender).send({ counterparty: 'Nyamata Quarry Ltd', contractValue: value, currency: value === null ? null : 'RWF' }).expect(200);
    const r = await http
      .put(`/api/documents/${id}/recipients`)
      .set(sender)
      .send({ routingMode: 'SEQUENTIAL', recipients: [{ role: 'SIGNER', fullName: 'Eric Quarry', email: 'eric@nyamata.rw' }] })
      .expect(200);
    const eric = r.body.recipients[0];
    await http
      .put(`/api/documents/${id}/fields`)
      .set(sender)
      .send({ fields: [{ recipientId: eric.id, type: 'SIGNATURE', page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.06 }] })
      .expect(200);
    return { id, eric };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await createApp();
    http = request(app.getHttpServer());
    outbox = app.get(EmailService).testOutbox;
    admin = { authorization: `Bearer ${(await signInFirstAdmin(app)).token}` };
    deptId = (await http.get('/api/departments').set(admin)).body.find((d: { code: string }) => d.code === 'PRO').id;
    const types = (await http.get('/api/document-types').set(admin)).body as { id: string; code: string }[];
    conId = types.find((t) => t.code === 'CON')!.id;
    frmId = types.find((t) => t.code === 'FRM')!.id;
    sender = await staff('buyer@ruliba.com', 'Grace Buyer', ['SENDER']);
    pm = await staff('pm@ruliba.com', 'Paul Procurement', ['APPROVER']);
    fd = await staff('fd@ruliba.com', 'Fiona Finance', ['APPROVER', 'SIGNER']);
    md = await staff('md@ruliba.com', 'Moses Director', ['APPROVER', 'SIGNER']);
  }, 60_000);
  afterAll(async () => app.close());

  it('asks for the approval chain to be completed before a supply contract can go out', async () => {
    const { id } = await draft(conId, 10_000_000);
    const preview = await http.get(`/api/documents/${id}/approval-preview`).set(sender).expect(200);
    expect(preview.body.required).toBe(true);
    expect(preview.body.problem).toMatch(/No one is assigned as Procurement Manager/);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(400);

    // Admin assigns the people and the Managing Director threshold (50 million RWF)
    await http.put('/api/settings/approval').set(admin).send({ currency: 'RWF' }).expect(200);
    const policy = (await http.get('/api/approval-policies').set(admin)).body[0];
    await http
      .put(`/api/approval-policies/${policy.id}`)
      .set(admin)
      .send({
        name: policy.name,
        documentTypeId: conId,
        departmentId: null,
        active: true,
        steps: [
          { label: 'Procurement Manager', approverUserId: ids['pm@ruliba.com'], minAmount: null },
          { label: 'Finance Director', approverUserId: ids['fd@ruliba.com'], minAmount: null },
          { label: 'Managing Director', approverUserId: ids['md@ruliba.com'], minAmount: 50_000_000 },
        ],
      })
            .expect(200);
    const ok = await http.get(`/api/documents/${id}/approval-preview`).set(sender).expect(200);
    expect(ok.body.steps.map((s: { label: string }) => s.label)).toEqual(['Procurement Manager', 'Finance Director']);
  });

  it('runs Procurement Manager, then Finance Director, then sends to the supplier with a reference number', async () => {
    const { id } = await draft(conId, 10_000_000);
    const sent = await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    expect(sent.body.status).toBe('PENDING_APPROVAL');
    expect(sent.body.referenceNo).toBeNull();
    expect(mails('pm@ruliba.com', 'approval-request')).toHaveLength(1);
    expect(mails('fd@ruliba.com', 'approval-request')).toHaveLength(0);
    expect(mails('eric@nyamata.rw', 'sign-invite')).toHaveLength(0);

    // Not your turn yet; senders cannot approve
    await http.post(`/api/documents/${id}/approve`).set(fd).send({}).expect(409);
    await http.post(`/api/documents/${id}/approve`).set(sender).send({}).expect(409);

    // The approver sees it in their list as something to do
    const list = await http.get('/api/documents').set(pm).expect(200);
    expect(list.body.find((d: { id: string }) => d.id === id)?.myAction).toBe('approve');

    await http.post(`/api/documents/${id}/approve`).set(pm).send({ comment: 'Prices match the tender.' }).expect(200);
    await http.post(`/api/documents/${id}/approve`).set(pm).send({}).expect(409); // only once
    expect(mails('fd@ruliba.com', 'approval-request')).toHaveLength(1);
    const after = await http.post(`/api/documents/${id}/approve`).set(fd).send({}).expect(200);
    expect(after.body.status).toBe('IN_PROGRESS');
    expect(after.body.referenceNo).toBe(`RCL/PRO/CON/${new Date().getFullYear()}/0001`);
    expect(mails('eric@nyamata.rw', 'sign-invite')).toHaveLength(1);
    expect(mails('md@ruliba.com', 'approval-request')).toHaveLength(0); // under the threshold
    const types = after.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['approval.approved', 'document.approved']));

    // In-app notification for the sender's dashboard bell
    const bell = await http.get('/api/notifications').set(pm).expect(200);
    expect(bell.body.items.length).toBeGreaterThan(0);
    await http.post('/api/notifications/read').set(pm).send({}).expect(200);
    expect((await http.get('/api/notifications').set(pm).expect(200)).body.unread).toBe(0);
  });

  it('adds the Managing Director above the threshold, and can return the document for changes', async () => {
    const { id } = await draft(conId, 80_000_000);
    const preview = await http.get(`/api/documents/${id}/approval-preview`).set(sender).expect(200);
    expect(preview.body.steps).toHaveLength(3);
    await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    await http.post(`/api/documents/${id}/approve`).set(pm).send({}).expect(200);
    await http.post(`/api/documents/${id}/approve`).set(fd).send({}).expect(200);
    expect(mails('md@ruliba.com', 'approval-request')).toHaveLength(1);
    await http.post(`/api/documents/${id}/return`).set(md).send({ reason: 'Payment terms must be 60 days.' }).expect(200);
    const back = await http.get(`/api/documents/${id}`).set(sender).expect(200);
    expect(back.body.status).toBe('DRAFT');
    expect(back.body.recipients.every((r: { role: string }) => r.role !== 'APPROVER')).toBe(true);
    expect(mails('buyer@ruliba.com', 'approval-returned').at(-1)?.data.reason).toBe('Payment terms must be 60 days.');
    // A missing value is refused when the chain depends on it
    await http.patch(`/api/documents/${id}`).set(sender).send({ contractValue: null }).expect(200);
    expect((await http.get(`/api/documents/${id}/approval-preview`).set(sender)).body.problem).toMatch(/contract value/);
  });

  it('skips approval for internal forms', async () => {
    const { id } = await draft(frmId, null, 'Leave request');
    const sent = await http.post(`/api/documents/${id}/send`).set(sender).send({}).expect(200);
    expect(sent.body.status).toBe('IN_PROGRESS');
    expect(sent.body.referenceNo).toMatch(/^RCL\/PRO\/FRM\//);
  });

  it('saves a prepared document as a template and creates new drafts from it', async () => {
    const { id, eric } = await draft(frmId, null, 'Delivery note');
    const saved = await http
      .post('/api/templates')
      .set(sender)
      .send({ documentId: id, name: 'Delivery note', shared: false, roles: [{ recipientId: eric.id, roleName: 'Supplier' }] })
      .expect(201);
    const list = await http.get('/api/templates').set(sender).expect(200);
    const t = list.body.find((x: { id: string }) => x.id === saved.body.id);
    expect(t.roles.map((r: { roleName: string }) => r.roleName)).toEqual(['Supplier']);
    // Someone in another department does not see a department-only template
    expect((await http.get('/api/templates').set(admin).expect(200)).body.some((x: { id: string }) => x.id === t.id)).toBe(false);

    await http.post(`/api/templates/${t.id}/use`).set(sender).send({ title: 'Delivery note 12 Nov', people: [] }).expect(400);
    const made = await http
      .post(`/api/templates/${t.id}/use`)
      .set(sender)
      .send({ title: 'Delivery note 12 Nov', people: [{ roleId: t.roles[0].id, fullName: 'Alice Trucks', email: 'alice@trucks.rw' }] })
      .expect(201);
    const doc = await http.get(`/api/documents/${made.body.id}`).set(sender).expect(200);
    expect(doc.body.status).toBe('DRAFT');
    expect(doc.body.recipients[0]).toMatchObject({ fullName: 'Alice Trucks', email: 'alice@trucks.rw' });
    expect(doc.body.fields).toHaveLength(1);
    await http.post(`/api/documents/${made.body.id}/send`).set(sender).send({}).expect(200);
  });

  it('reminds signers who have not signed, and expires documents past their deadline', async () => {
    const jobs = app.get(JobsService);
    const { id } = await draft(frmId, null, 'Stock count sheet');
    await http.post(`/api/documents/${id}/send`).set(sender).send({ reminderEveryDays: 2, expiresInDays: 7 }).expect(200);
    const before = mails('eric@nyamata.rw', 'sign-invite').length;
    expect(await jobs.sendReminders(new Date())).toBe(0); // not yet due
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
    expect(await jobs.sendReminders(inThreeDays)).toBeGreaterThan(0);
    expect(mails('eric@nyamata.rw', 'sign-invite').length).toBeGreaterThan(before);
    await jobs.expireDocuments(new Date(Date.now() + 8 * 86_400_000));
    const doc = await http.get(`/api/documents/${id}`).set(sender).expect(200);
    expect(doc.body.status).toBe('EXPIRED');
    expect(mails('buyer@ruliba.com', 'document-expired').length).toBeGreaterThan(0);
  });

  it('gives administrators reports and a retention review, and keeps them from everyone else', async () => {
    const summary = await http.get('/api/reports/summary').set(admin).expect(200);
    expect(summary.body.totals.sent).toBeGreaterThanOrEqual(4);
    expect(summary.body.byDepartment[0].department).toBe('Procurement');
    await http.get('/api/reports/summary').set(sender).expect(403);

    await http.patch(`/api/documents/${(await draft(frmId, null, '=HYPERLINK("http://evil")')).id}`).set(sender).send({}).expect(200);
    const csv = await http.get('/api/reports/documents.csv').set(admin).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('reference_no,title');

    const due = await http.get('/api/retention/due').set(admin).expect(200);
    expect(due.body).toEqual([]);
    const any = (await http.get('/api/documents').set(sender)).body[0].id;
    await http.post(`/api/retention/${any}/purge`).set(admin).send({ reason: 'Retention decision 2026/1' }).expect(400);
    await http.get('/api/signing/certificates').set(admin).expect(200);
    expect((await http.get('/api/audit/verify').set(admin).expect(200)).body.ok).toBe(true);
  }, 60_000);

  it('anchors the audit log fingerprint', async () => {
    const r = await app.get(JobsService).anchorAuditLog();
    expect(r.ok).toBe(true);
  });
});
