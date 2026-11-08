import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/decorators';
import { sha256Hex } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { Database, DbService } from '../db/db';
import { documentFiles, documents, fields, recipients, templateFields, templateRoles, templates, users } from '../db/schema';
import { StorageService } from '../files/storage.service';
import { assertSender, assertView } from './access';
import { DocumentsService } from './documents.service';

export interface SaveTemplateInput {
  documentId: string;
  name: string;
  description?: string | null;
  shared: boolean; // true = every department; false = my department only
  roles: { recipientId: string; roleName: string }[];
}

export interface UseTemplateInput {
  title: string;
  people: { roleId: string; fullName: string; email: string }[];
}

/**
 * Documents sent again and again (standard supply contract, NDA, delivery note), prepared once:
 * the same PDF, fields and signing order, with roles ("Supplier", "Finance Director") instead of people.
 * Using a template creates an ordinary draft that the sender checks and sends.
 */
@Injectable()
export class TemplatesService {
  private readonly db: Database;

  constructor(
    dbs: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
  ) {
    this.db = dbs.db;
  }

  private visible(user: AuthUser) {
    return and(eq(templates.active, true), or(isNull(templates.departmentId), user.departmentId ? eq(templates.departmentId, user.departmentId) : undefined, eq(templates.ownerId, user.id)));
  }

  async list(user: AuthUser) {
    const rows = await this.db.query.templates.findMany({
      where: this.visible(user),
      with: { roles: { orderBy: asc(templateRoles.stepOrder) }, fields: { columns: { id: true } }, documentType: { columns: { name: true, code: true } }, owner: { columns: { fullName: true } } },
      orderBy: desc(templates.updatedAt),
    });
    return rows.map(({ storageKey: _s, wrappedKey: _w, fields: f, ...t }) => ({ ...t, fieldCount: f.length }));
  }

  async saveFromDocument(user: AuthUser, input: SaveTemplateInput, meta: RequestMeta) {
    const doc = await this.db.query.documents.findFirst({ where: eq(documents.id, input.documentId), with: { recipients: true, fields: true, files: true } });
    assertView(user, doc);
    assertSender(user, doc!);
    const d = doc!;
    const signers = d.recipients.filter((r) => r.role !== 'APPROVER');
    if (!signers.some((r) => r.role === 'SIGNER')) throw new BadRequestException('Add signers and fields first, then save the document as a template.');
    const names = new Map(input.roles.map((r) => [r.recipientId, r.roleName.trim()]));
    for (const r of signers) if (!names.get(r.id)) throw new BadRequestException(`Give a role name for ${r.fullName}, e.g. "Supplier".`);

    const prepared = d.files.find((f) => f.kind === 'CONVERTED') ?? d.files.find((f) => f.kind === 'ORIGINAL')!;
    const pdf = await this.storage.get(prepared.storageKey, prepared.wrappedKey);
    if (sha256Hex(pdf) !== prepared.sha256) throw new ConflictException('The stored file does not match its fingerprint.');
    const templateId = crypto.randomUUID();
    const key = this.storage.newKey(`templates/${templateId}`);
    const { wrappedKey } = await this.storage.put(key, pdf);

    await this.db.transaction(async (tx) => {
      await tx.insert(templates).values({
        id: templateId,
        name: input.name,
        description: input.description ?? null,
        documentTypeId: d.documentTypeId,
        departmentId: input.shared ? null : d.departmentId,
        ownerId: user.id,
        routingMode: d.routingMode,
        storageKey: key,
        wrappedKey,
        sha256: prepared.sha256,
        pageCount: prepared.pageCount ?? 1,
        emailSubject: d.emailSubject,
        emailMessage: d.emailMessage,
      });
      const roleIds = new Map<string, string>();
      for (const r of signers) {
        const [row] = await tx
          .insert(templateRoles)
          .values({
            templateId,
            roleName: names.get(r.id)!,
            role: r.role,
            stepOrder: r.stepOrder,
            // Staff and fixed addresses (e.g. the archive mailbox) are kept as defaults; outside people usually change.
            defaultName: r.isExternal ? null : r.fullName,
            defaultEmail: r.isExternal ? null : r.email,
          })
          .returning({ id: templateRoles.id });
        roleIds.set(r.id, row.id);
      }
      const fs = d.fields.filter((f) => roleIds.has(f.recipientId));
      if (fs.length) {
        await tx.insert(templateFields).values(
          fs.map((f) => ({ templateId, templateRoleId: roleIds.get(f.recipientId)!, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label, options: f.options })),
        );
      }
      await this.audit.record({ type: 'template.created', meta, actor: user, documentId: d.id, details: { templateId, name: input.name, roles: [...names.values()], fields: fs.length } }, tx);
    });
    return { id: templateId };
  }

  async use(user: AuthUser, id: string, input: UseTemplateInput, meta: RequestMeta) {
    const t = await this.db.query.templates.findFirst({ where: and(eq(templates.id, id), this.visible(user)), with: { roles: true, fields: true } });
    if (!t) throw new NotFoundException('Template not found.');
    if (!user.departmentId) throw new BadRequestException('Your account has no department. Ask the administrator to set it.');
    const byRole = new Map(input.people.map((p) => [p.roleId, p]));
    for (const r of t.roles) if (!byRole.get(r.id)?.email) throw new BadRequestException(`Fill in the ${r.roleName}.`);

    const pdf = await this.storage.get(t.storageKey, t.wrappedKey);
    if (sha256Hex(pdf) !== t.sha256) throw new ConflictException('The template file does not match its fingerprint. Tell the IT office.');
    const docId = crypto.randomUUID();
    const key = this.storage.newKey(`documents/${docId}`);
    const { wrappedKey } = await this.storage.put(key, pdf);
    const staff = await this.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.status, ['ACTIVE', 'PENDING']));

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(documents).values({
          id: docId,
          title: input.title,
          documentTypeId: t.documentTypeId,
          departmentId: user.departmentId!,
          senderId: user.id,
          templateId: t.id,
          routingMode: t.routingMode,
          emailSubject: t.emailSubject,
          emailMessage: t.emailMessage,
        });
        await tx.insert(documentFiles).values({
          documentId: docId,
          kind: 'ORIGINAL',
          storageKey: key,
          fileName: `${t.name}.pdf`.replace(/[^\p{L}\p{N} ._()-]/gu, '_'),
          mimeType: 'application/pdf',
          sizeBytes: pdf.length,
          sha256: t.sha256,
          pageCount: t.pageCount,
          wrappedKey,
        });
        const rid = new Map<string, string>();
        for (const r of t.roles) {
          const p = byRole.get(r.id)!;
          const email = p.email.trim().toLowerCase();
          const internal = staff.find((s) => s.email === email);
          const [row] = await tx
            .insert(recipients)
            .values({ documentId: docId, role: r.role, stepOrder: r.stepOrder, fullName: p.fullName.trim(), email, userId: internal?.id ?? null, isExternal: !internal, authMethod: internal ? 'ACCOUNT' : 'EMAIL_OTP' })
            .returning({ id: recipients.id });
          rid.set(r.id, row.id);
        }
        if (t.fields.length) {
          await tx.insert(fields).values(
            t.fields.map((f) => ({ documentId: docId, recipientId: rid.get(f.templateRoleId)!, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label, options: f.options })),
          );
        }
        await this.audit.record(
          { type: 'document.created', meta, actor: user, documentId: docId, docSha256: t.sha256, details: { fromTemplate: t.name, templateId: t.id, title: input.title } },
          tx,
        );
      });
    } catch (e) {
      await this.storage.remove(key);
      throw e;
    }
    return this.docs.get(user, docId);
  }

  async remove(user: AuthUser, id: string, meta: RequestMeta) {
    const t = await this.db.query.templates.findFirst({ where: eq(templates.id, id) });
    if (!t) throw new NotFoundException('Template not found.');
    if (t.ownerId !== user.id && !user.roles.includes('ADMIN')) throw new ForbiddenException('Only the person who made this template, or an administrator, can remove it.');
    await this.db.update(templates).set({ active: false }).where(eq(templates.id, id));
    await this.audit.record({ type: 'template.removed', meta, actor: user, details: { templateId: id, name: t.name } });
  }
}
