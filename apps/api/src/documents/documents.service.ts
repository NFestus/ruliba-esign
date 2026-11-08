import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  CreateDocumentInput,
  FieldInput,
  RecipientsInput,
  UpdateDocumentInput,
} from '@ruliba/shared';
import { and, asc, desc, eq, ilike, inArray, isNotNull, ne, or, SQL, sql } from 'drizzle-orm';
import path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/decorators';
import { sha256Hex } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { Database, DbService, Tx } from '../db/db';
import { contacts, departments, documentFiles, documents, documentTypes, fields, folderDocuments, recipients, users } from '../db/schema';
import { ConverterService } from '../files/converter.service';
import { ScannerService } from '../files/scanner.service';
import { StorageService } from '../files/storage.service';
import { inspectPdf, PdfRejected } from '../pdf/inspect';
import { ReferenceService } from '../reference/reference.service';
import { assertSender, assertView } from './access';
import { RoutingService } from './routing.service';
import { ApprovalsService } from './approvals.service';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

type Kind = 'PDF' | 'WORD';

function detectKind(f: UploadedFile): Kind {
  const head = f.buffer.subarray(0, 8);
  const ext = path.extname(f.originalname).toLowerCase();
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const isOle = head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ((isZip && ext === '.docx') || (isOle && ext === '.doc')) return 'WORD';
  throw new BadRequestException('Upload a PDF or a Word document (.docx or .doc).');
}

export const LIST_FILTERS = ['all', 'waiting', 'progress', 'completed', 'drafts', 'declined', 'voided', 'expired'] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

@Injectable()
export class DocumentsService {
  private readonly db: Database;

  constructor(
    dbs: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scanner: ScannerService,
    private readonly converter: ConverterService,
    private readonly references: ReferenceService,
    private readonly routing: RoutingService,
    private readonly approvals: ApprovalsService,
  ) {
    this.db = dbs.db;
  }

  // ───────────── Create a draft from an upload ─────────────

  async create(user: AuthUser, file: UploadedFile | undefined, input: CreateDocumentInput, meta: RequestMeta) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a file to upload.');
    if (!user.departmentId) throw new BadRequestException('Your account has no department. Ask the administrator to set it.');
    const type = await this.db.query.documentTypes.findFirst({ where: eq(documentTypes.id, input.documentTypeId) });
    if (!type || !type.active) throw new BadRequestException('Choose a document type.');
    if (!type.eSignAllowed) {
      throw new BadRequestException(`"${type.name}" documents may not be signed electronically. Use the paper process for this one.`);
    }

    const kind = detectKind(file);
    const scan = await this.scanner.scan(file.buffer);
    if (scan.status === 'infected') {
      await this.audit.record({ type: 'document.upload_refused', meta, actor: user, details: { reason: 'virus', signature: scan.signature, fileName: file.originalname } });
      throw new UnprocessableEntityException('This file contains a virus and was refused. Tell the IT office.');
    }

    const pdf = kind === 'WORD' ? await this.converter.wordToPdf(file.buffer, file.originalname) : file.buffer;
    let info;
    try {
      info = await inspectPdf(pdf);
    } catch (e) {
      if (e instanceof PdfRejected) {
        await this.audit.record({ type: 'document.upload_refused', meta, actor: user, details: { reason: e.message, fileName: file.originalname } });
        throw new UnprocessableEntityException(e.message);
      }
      throw e;
    }

    const safeName = file.originalname.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 200) || 'document';
    const docId = crypto.randomUUID();
    const stored: { kind: 'ORIGINAL' | 'CONVERTED'; data: Buffer; name: string; mime: string; pages: number | null }[] = [
      {
        kind: 'ORIGINAL',
        data: file.buffer,
        name: safeName,
        mime: kind === 'PDF' ? 'application/pdf' : file.originalname.toLowerCase().endsWith('.doc') ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        pages: kind === 'PDF' ? info.pageCount : null,
      },
    ];
    if (kind === 'WORD') stored.push({ kind: 'CONVERTED', data: pdf, name: safeName.replace(/\.docx?$/i, '') + '.pdf', mime: 'application/pdf', pages: info.pageCount });

    const files: (typeof stored[number] & { key: string; wrappedKey: string; sha256: string })[] = [];
    for (const s of stored) {
      const key = this.storage.newKey(`documents/${docId}`);
      const { wrappedKey } = await this.storage.put(key, s.data);
      files.push({ ...s, key, wrappedKey, sha256: sha256Hex(s.data) });
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(documents).values({
          id: docId,
          title: input.title,
          documentTypeId: type.id,
          departmentId: user.departmentId!,
          senderId: user.id,
          sensitivity: input.sensitivity,
          locale: input.locale,
        });
        await tx.insert(documentFiles).values(
          files.map((f) => ({
            documentId: docId,
            kind: f.kind,
            storageKey: f.key,
            fileName: f.name,
            mimeType: f.mime,
            sizeBytes: f.data.length,
            sha256: f.sha256,
            pageCount: f.pages,
            wrappedKey: f.wrappedKey,
          })),
        );
        await this.audit.record(
          {
            type: 'document.created',
            meta,
            actor: user,
            documentId: docId,
            docSha256: files[files.length - 1].sha256,
            details: {
              title: input.title,
              documentType: type.code,
              files: files.map((f) => ({ kind: f.kind, name: f.name, sha256: f.sha256, bytes: f.data.length })),
              virusScan: scan.status === 'skipped' ? `skipped: ${scan.reason}` : scan.status,
              pages: info.pageCount,
            },
          },
          tx,
        );
      });
    } catch (e) {
      await Promise.all(files.map((f) => this.storage.remove(f.key)));
      throw e;
    }
    return this.get(user, docId);
  }

  // ───────────── Read ─────────────

  async list(user: AuthUser, filter: ListFilter, q?: string, opts: { departmentId?: string; from?: Date; to?: Date; folderId?: string } = {}) {
    const mine = eq(documents.senderId, user.id);
    const addressedToMe = sql`exists (select 1 from ${recipients} r where r.document_id = ${documents.id} and (r.user_id = ${user.id} or r.email = ${user.email}))`;
    const waitingForMe = sql`${documents.status} in ('IN_PROGRESS','PENDING_APPROVAL') and exists (select 1 from ${recipients} r where r.document_id = ${documents.id} and (r.user_id = ${user.id} or r.email = ${user.email}) and r.status in ('SENT','VIEWED'))`;
    // Approvers (department heads) see every sent document of their own department, read-only.
    const myDepartment = user.roles.includes('APPROVER') && user.departmentId ? and(eq(documents.departmentId, user.departmentId), ne(documents.status, 'DRAFT')) : undefined;
    const visible = user.roles.includes('AUDITOR') ? undefined : or(mine, addressedToMe, myDepartment);

    const byFilter: Record<ListFilter, SQL | undefined> = {
      all: undefined,
      waiting: waitingForMe,
      progress: inArray(documents.status, ['IN_PROGRESS', 'PENDING_APPROVAL']),
      completed: eq(documents.status, 'COMPLETED'),
      drafts: and(eq(documents.status, 'DRAFT'), mine),
      declined: eq(documents.status, 'DECLINED'),
      voided: eq(documents.status, 'VOIDED'),
      expired: eq(documents.status, 'EXPIRED'),
    };
    const pattern = q ? `%${q.replace(/[%_\\]/g, '')}%` : null;
    const search = pattern ? or(ilike(documents.title, pattern), ilike(documents.counterparty, pattern), ilike(documents.referenceNo, pattern)) : undefined;
    // Other people's drafts are never listed, even for auditors: a draft is not a document yet.
    const notOthersDrafts = or(ne(documents.status, 'DRAFT'), mine);

    const rows = await this.db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        referenceNo: documents.referenceNo,
        counterparty: documents.counterparty,
        updatedAt: documents.updatedAt,
        senderId: documents.senderId,
        senderName: users.fullName,
        waitingForMe: sql<boolean>`(${waitingForMe})`,
        myAction: sql<string | null>`(select case when r.role = 'APPROVER' then 'approve' else 'sign' end from ${recipients} r where r.document_id = ${documents.id} and (r.user_id = ${user.id} or r.email = ${user.email}) and r.status in ('SENT','VIEWED') and ${documents.status} in ('IN_PROGRESS','PENDING_APPROVAL') limit 1)`,
        departmentName: departments.name,
        folderId: sql<string | null>`(select fd.folder_id from ${folderDocuments} fd where fd.user_id = ${user.id} and fd.document_id = ${documents.id})`,
      })
      .from(documents)
      .innerJoin(users, eq(users.id, documents.senderId))
      .innerJoin(departments, eq(departments.id, documents.departmentId))
      .where(
        and(
          visible,
          byFilter[filter],
          search,
          notOthersDrafts,
          opts.departmentId ? eq(documents.departmentId, opts.departmentId) : undefined,
          opts.folderId === 'none'
            ? sql`not exists (select 1 from ${folderDocuments} fd where fd.user_id = ${user.id} and fd.document_id = ${documents.id})`
            : opts.folderId
              ? sql`exists (select 1 from ${folderDocuments} fd where fd.user_id = ${user.id} and fd.document_id = ${documents.id} and fd.folder_id = ${opts.folderId})`
              : undefined,
          opts.from ? sql`${documents.createdAt} >= ${opts.from}` : undefined,
          opts.to ? sql`${documents.createdAt} < ${opts.to}` : undefined,
        ),
      )
      .orderBy(desc(documents.updatedAt))
      .limit(200);

    const ids = rows.map((r) => r.id);
    const people = ids.length
      ? await this.db
          .select({ documentId: recipients.documentId, fullName: recipients.fullName, role: recipients.role, status: recipients.status, stepOrder: recipients.stepOrder })
          .from(recipients)
          .where(inArray(recipients.documentId, ids))
          .orderBy(asc(recipients.stepOrder), asc(recipients.createdAt))
      : [];
    return rows.map((r) => ({ ...r, recipients: people.filter((p) => p.documentId === r.id) }));
  }

  async counts(user: AuthUser) {
    const all = await this.list(user, 'all');
    return {
      waiting: all.filter((d) => d.waitingForMe).length,
      progress: all.filter((d) => d.status === 'IN_PROGRESS' || d.status === 'PENDING_APPROVAL').length,
      completed: all.filter((d) => d.status === 'COMPLETED').length,
      drafts: all.filter((d) => d.status === 'DRAFT' && d.senderId === user.id).length,
    };
  }

  private async load(id: string) {
    return this.db.query.documents.findFirst({
      where: eq(documents.id, id),
      with: {
        recipients: { orderBy: [asc(recipients.stepOrder), asc(recipients.createdAt)] },
        fields: true,
        files: { orderBy: asc(documentFiles.createdAt) },
        documentType: true,
        department: true,
        sender: { columns: { id: true, fullName: true, email: true } },
      },
    });
  }

  async get(user: AuthUser, id: string) {
    const doc = await this.load(id);
    assertView(user, doc);
    const d = doc as NonNullable<Awaited<ReturnType<DocumentsService['load']>>>;
    const events = await this.audit.list({ documentId: id, limit: 200 });
    return {
      ...d,
      isSender: d.senderId === user.id,
      myFolderId: (await this.db.query.folderDocuments.findFirst({ where: and(eq(folderDocuments.userId, user.id), eq(folderDocuments.documentId, id)) }))?.folderId ?? null,
      recipients: d.recipients.map(({ accessTokenHash: _t, ...r }) => r),
      files: d.files.map(({ wrappedKey: _k, storageKey: _s, ...f }) => f),
      events: events.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, actorName: e.actorName, actorEmail: e.actorEmail, ip: e.ip, details: e.details })),
    };
  }

  async file(user: AuthUser, id: string, kind: string, meta: RequestMeta) {
    const doc = await this.load(id);
    assertView(user, doc);
    const d = doc!;
    if (d.purgedAt) throw new GoneException(`The files of this document were deleted on ${d.purgedAt.toISOString().slice(0, 10)} under the retention policy. Its record and fingerprints remain.`);
    const want =
      kind === 'prepared'
        ? (d.files.find((f) => f.kind === 'CONVERTED') ?? d.files.find((f) => f.kind === 'ORIGINAL'))
        : kind === 'signed'
          ? (d.files.find((f) => f.kind === 'SEALED') ?? d.files.find((f) => f.kind === 'SIGNED'))
          : d.files.find((f) => f.kind === kind.toUpperCase());
    if (!want) throw new NotFoundException('That file does not exist for this document.');
    const data = await this.storage.get(want.storageKey, want.wrappedKey);
    if (sha256Hex(data) !== want.sha256) throw new ConflictException('This file does not match its recorded fingerprint. Tell the IT office.');
    await this.audit.record({ type: 'document.file_opened', meta, actor: user, documentId: id, docSha256: want.sha256, details: { kind: want.kind } });
    return { data, fileName: want.fileName, mimeType: want.mimeType };
  }

  // ───────────── Prepare ─────────────

  private async draftFor(user: AuthUser, id: string) {
    const doc = await this.load(id);
    assertView(user, doc);
    assertSender(user, doc!);
    if (doc!.status !== 'DRAFT') throw new ConflictException('This document was already sent and can no longer be changed.');
    return doc!;
  }

  async update(user: AuthUser, id: string, input: UpdateDocumentInput, meta: RequestMeta) {
    await this.draftFor(user, id);
    const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    if ('contractValue' in set) set.contractValue = set.contractValue === null ? null : (set.contractValue as number).toFixed(2);
    if ('expiresAt' in set) set.expiresAt = set.expiresAt ? new Date(set.expiresAt as string) : null;
    if (Object.keys(set).length) await this.db.update(documents).set(set).where(eq(documents.id, id));
    await this.audit.record({ type: 'document.details_changed', meta, actor: user, documentId: id, details: { changes: input } });
    return this.get(user, id);
  }

  async setRecipients(user: AuthUser, id: string, input: RecipientsInput, meta: RequestMeta) {
    const doc = await this.draftFor(user, id);
    const steps = normaliseSteps(input);
    const emails = input.recipients.map((r) => r.email);
    const staff = await this.db.query.users.findMany({ where: and(inArray(users.email, emails), inArray(users.status, ['ACTIVE', 'PENDING'])), columns: { id: true, email: true } });
    const keep = new Set(input.recipients.map((r) => r.id).filter(Boolean));
    const existing = new Set(doc.recipients.map((r) => r.id));
    for (const r of input.recipients) if (r.id && !existing.has(r.id)) throw new BadRequestException('A signer in the list does not belong to this document.');

    await this.db.transaction(async (tx) => {
      const removed = doc.recipients.filter((r) => !keep.has(r.id)).map((r) => r.id);
      if (removed.length) await tx.delete(recipients).where(inArray(recipients.id, removed)); // their fields go with them
      for (const [i, r] of input.recipients.entries()) {
        const internal = staff.find((s) => s.email === r.email);
        const values = {
          role: r.role,
          fullName: r.fullName,
          email: r.email,
          stepOrder: steps[i],
          userId: internal?.id ?? null,
          isExternal: !internal,
          authMethod: internal ? ('ACCOUNT' as const) : ('EMAIL_OTP' as const),
        };
        if (r.id) await tx.update(recipients).set(values).where(eq(recipients.id, r.id));
        else await tx.insert(recipients).values({ ...values, documentId: id });
      }
      // A person changed from signer to copy keeps no fields
      await tx.execute(sql`delete from ${fields} f using ${recipients} r where f.recipient_id = r.id and r.document_id = ${id} and r.role <> 'SIGNER'`);
      await tx.update(documents).set({ routingMode: input.routingMode }).where(eq(documents.id, id));
      await this.audit.record(
        {
          type: 'document.recipients_set',
          meta,
          actor: user,
          documentId: id,
          details: { routingMode: input.routingMode, recipients: input.recipients.map((r, i) => ({ name: r.fullName, email: r.email, role: r.role, step: steps[i] })) },
        },
        tx,
      );
    });
    return this.get(user, id);
  }

  async setFields(user: AuthUser, id: string, input: FieldInput[], meta: RequestMeta) {
    const doc = await this.draftFor(user, id);
    const signers = new Set(doc.recipients.filter((r) => r.role === 'SIGNER').map((r) => r.id));
    const pages = doc.files.find((f) => f.kind === 'CONVERTED')?.pageCount ?? doc.files.find((f) => f.kind === 'ORIGINAL')?.pageCount ?? 0;
    for (const f of input) {
      if (!signers.has(f.recipientId)) throw new BadRequestException('Every field must belong to one of the signers.');
      if (f.page > pages) throw new BadRequestException(`A field is on page ${f.page}, but the document has ${pages} pages.`);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(fields).where(eq(fields.documentId, id));
      if (input.length) {
        await tx.insert(fields).values(
          input.map((f) => ({ ...f, documentId: id, label: f.label ?? null, options: f.type === 'DROPDOWN' ? f.options : null, required: f.type === 'CHECKBOX' ? false : f.required })),
        );
      }
      await this.audit.record({ type: 'document.fields_set', meta, actor: user, documentId: id, details: { count: input.length } }, tx);
    });
    return this.get(user, id);
  }

  async deleteDraft(user: AuthUser, id: string, meta: RequestMeta) {
    const doc = await this.draftFor(user, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(documentFiles).where(eq(documentFiles.documentId, id));
      await tx.delete(documents).where(eq(documents.id, id));
      await this.audit.record({ type: 'document.draft_deleted', meta, actor: user, documentId: id, details: { title: doc.title } }, tx);
    });
    await Promise.all(doc.files.map((f) => this.storage.remove(f.storageKey)));
  }

  // ───────────── Send ─────────────

  async approvalPreview(user: AuthUser, id: string) {
    const doc = await this.load(id);
    assertView(user, doc);
    if (!doc!.documentType.requiresApproval) return { required: false, steps: [] };
    const r = await this.approvals.stepsFor(doc!);
    return { required: true, policyName: r.policyName, problem: r.problem ?? null, steps: r.steps.map((s) => ({ label: s.label, approverName: s.approverName })) };
  }

  async send(
    user: AuthUser,
    id: string,
    input: { emailSubject?: string | null; emailMessage?: string | null; expiresInDays: number; reminderEveryDays?: number | null },
    meta: RequestMeta,
  ) {
    const doc = await this.draftFor(user, id);
    const signers = doc.recipients.filter((r) => r.role === 'SIGNER');
    if (!signers.length) throw new BadRequestException('Add at least one signer.');
    const missing = signers.filter((s) => !doc.fields.some((f) => f.recipientId === s.id && (f.type === 'SIGNATURE' || f.type === 'INITIALS')));
    if (missing.length) throw new BadRequestException(`Place a signature field for ${missing.map((m) => m.fullName).join(', ')}.`);
    if (!doc.documentType.eSignAllowed) throw new BadRequestException('This document type may not be signed electronically.');

    const prepared = doc.files.find((f) => f.kind === 'CONVERTED') ?? doc.files.find((f) => f.kind === 'ORIGINAL')!;
    const data = await this.storage.get(prepared.storageKey, prepared.wrappedKey);
    if (sha256Hex(data) !== prepared.sha256) throw new ConflictException('The stored file does not match its fingerprint. Upload it again.');
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    const approval = doc.documentType.requiresApproval ? await this.approvals.stepsFor(doc) : null;
    if (approval?.problem) throw new BadRequestException(approval.problem);

    const outbox = await this.db.transaction(async (tx) => {
      // With approvals: the number is issued at final approval (RoutingService). Without: now.
      const ref = approval?.steps.length ? null : await this.references.next(tx, doc.department.code, doc.documentType.code);
      if (approval?.steps.length) {
        await tx.insert(recipients).values(
          approval.steps.map((s, i) => ({
            documentId: id,
            role: 'APPROVER' as const,
            stepOrder: i + 1,
            fullName: `${s.approverName} (${s.label})`,
            email: s.approverEmail,
            userId: s.approverUserId,
            isExternal: false,
            authMethod: 'ACCOUNT' as const,
          })),
        );
      }
      await tx
        .update(documents)
        .set({
          status: approval?.steps.length ? 'PENDING_APPROVAL' : 'IN_PROGRESS',
          referenceNo: ref,
          sentAt: new Date(),
          expiresAt,
          reminderEveryDays: input.reminderEveryDays ?? null,
          emailSubject: input.emailSubject ?? doc.emailSubject,
          emailMessage: input.emailMessage ?? doc.emailMessage,
        })
        .where(and(eq(documents.id, id), eq(documents.status, 'DRAFT')));
      await this.upsertContacts(tx, doc.recipients.filter((r) => r.isExternal));
      await this.audit.record(
        {
          type: approval?.steps.length ? 'document.submitted_for_approval' : 'document.sent',
          meta,
          actor: user,
          documentId: id,
          docSha256: prepared.sha256,
          details: {
            referenceNo: ref,
            approvers: approval?.steps.map((s) => `${s.label}: ${s.approverName}`) ?? [],
            expiresAt: expiresAt.toISOString(),
            routingMode: doc.routingMode,
            recipients: doc.recipients.map((r) => ({ id: r.id, name: r.fullName, email: r.email, role: r.role, step: r.stepOrder, internal: !r.isExternal })),
            fields: doc.fields.length,
          },
        },
        tx,
      );
      return this.routing.activateNextStep(tx, id, meta);
    });
    await this.routing.deliver(outbox);
    return this.get(user, id);
  }

  async voidDocument(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const doc = await this.load(id);
    assertView(user, doc);
    assertSender(user, doc!);
    if (!['IN_PROGRESS', 'PENDING_APPROVAL'].includes(doc!.status)) throw new ConflictException('Only a document that is out for signing can be cancelled.');
    const outbox = await this.db.transaction(async (tx) => {
      const res = await tx
        .update(documents)
        .set({ status: 'VOIDED', voidedAt: new Date(), voidReason: reason })
        .where(and(eq(documents.id, id), inArray(documents.status, ['IN_PROGRESS', 'PENDING_APPROVAL'])))
        .returning({ id: documents.id });
      if (!res.length) throw new ConflictException('This document changed in the meantime. Reload and try again.');
      await tx
        .update(recipients)
        .set({ status: 'CANCELLED' })
        .where(and(eq(recipients.documentId, id), inArray(recipients.status, ['WAITING', 'SENT', 'VIEWED'])));
      await this.audit.record({ type: 'document.voided', meta, actor: user, documentId: id, details: { reason } }, tx);
      return this.routing.voidNotices(doc!, reason);
    });
    await this.routing.deliver(outbox);
    return this.get(user, id);
  }

  async resend(user: AuthUser, id: string, recipientId: string, meta: RequestMeta) {
    const doc = await this.load(id);
    assertView(user, doc);
    assertSender(user, doc!);
    if (doc!.status !== 'IN_PROGRESS') throw new ConflictException('This document is not out for signing.');
    const r = doc!.recipients.find((x) => x.id === recipientId);
    if (!r || !['SENT', 'VIEWED'].includes(r.status)) throw new ConflictException('This person is not waiting to sign right now.');
    const outbox = await this.db.transaction((tx) => this.routing.invite(tx, doc!, r, meta, true));
    await this.routing.deliver(outbox);
    return this.get(user, id);
  }

  async listContacts(q?: string) {
    const pattern = q ? `%${q.replace(/[%_\\]/g, '')}%` : null;
    return this.db
      .select()
      .from(contacts)
      .where(pattern ? or(ilike(contacts.fullName, pattern), ilike(contacts.email, pattern), ilike(contacts.company, pattern)) : undefined)
      .orderBy(desc(contacts.lastSentAt))
      .limit(100);
  }

  private async upsertContacts(tx: Tx, people: { email: string; fullName: string }[]) {
    for (const p of people) {
      await tx
        .insert(contacts)
        .values({ email: p.email, fullName: p.fullName, documentCount: 1, lastSentAt: new Date() })
        .onConflictDoUpdate({
          target: contacts.email,
          set: { fullName: p.fullName, documentCount: sql`${contacts.documentCount} + 1`, lastSentAt: new Date() },
        });
    }
  }
}

/** Sequential: 1, 2, 3… in list order. Parallel: everyone 1. Mixed: the steps given, renumbered without gaps. */
export function normaliseSteps(input: RecipientsInput): number[] {
  if (input.routingMode === 'PARALLEL') return input.recipients.map(() => 1);
  if (input.routingMode === 'SEQUENTIAL') {
    let n = 0;
    return input.recipients.map((r) => (r.role === 'CC' ? 1 : ++n));
  }
  const distinct = [...new Set(input.recipients.map((r) => r.stepOrder))].sort((a, b) => a - b);
  return input.recipients.map((r) => distinct.indexOf(r.stepOrder) + 1);
}

