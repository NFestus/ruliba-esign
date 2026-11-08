import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  approvalPolicySchema,
  ApprovalPolicyInput,
  ApprovalSettings,
  approvalSettingsSchema,
  departmentSchema,
  documentTypeSchema,
} from '@ruliba/shared';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { Database, DbService } from '../db/db';
import { approvalPolicies, approvalPolicySteps, departments, documents, documentTypes, settings } from '../db/schema';

export const APPROVAL_SETTINGS_KEY = 'approval';
const DEFAULT_APPROVAL: ApprovalSettings = { currency: null };

/**
 * Organisation set-up an administrator manages: departments, document types,
 * approval chains and the approval currency. Every change is written to the audit log.
 */
@Controller()
export class SetupController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly audit: AuditService,
  ) {
    this.db = dbs.db;
  }

  // ───────────── Departments ─────────────

  @Get('departments')
  departments() {
    return this.db.select().from(departments).orderBy(asc(departments.name));
  }

  @Roles('ADMIN')
  @Post('departments')
  createDepartment(@Body(new ZodPipe(departmentSchema)) body: z.infer<typeof departmentSchema>, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.db
      .transaction(async (tx) => {
        const [d] = await tx.insert(departments).values(body).returning();
        await this.audit.record({ type: 'setup.department_created', meta, actor: by, details: { department: d } }, tx);
        return d;
      })
      .catch(uniqueToConflict('That department code is already used.'));
  }

  @Roles('ADMIN')
  @Patch('departments/:id')
  async updateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(departmentSchema.partial())) body: Partial<z.infer<typeof departmentSchema>>,
    @CurrentUser() by: AuthUser,
    @Meta() meta: RequestMeta,
  ) {
    const before = await this.db.query.departments.findFirst({ where: eq(departments.id, id) });
    if (!before) throw new NotFoundException('Department not found.');
    // Codes appear in issued reference numbers, so they cannot change once documents use them.
    if (body.code && body.code !== before.code) {
      const used = await this.db.$count(documents, and(eq(documents.departmentId, id), isNotNull(documents.referenceNo)));
      if (used) throw new ConflictException('This code already appears in reference numbers and cannot change.');
    }
    return this.db
      .transaction(async (tx) => {
        const [d] = await tx.update(departments).set(body).where(eq(departments.id, id)).returning();
        await this.audit.record({ type: 'setup.department_updated', meta, actor: by, details: { before, after: d } }, tx);
        return d;
      })
      .catch(uniqueToConflict('That department code is already used.'));
  }

  // ───────────── Document types ─────────────

  @Get('document-types')
  documentTypes() {
    return this.db.select().from(documentTypes).orderBy(asc(documentTypes.name));
  }

  @Roles('ADMIN')
  @Post('document-types')
  createDocumentType(@Body(new ZodPipe(documentTypeSchema)) body: z.infer<typeof documentTypeSchema>, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.db
      .transaction(async (tx) => {
        const [t] = await tx.insert(documentTypes).values(body).returning();
        await this.audit.record({ type: 'setup.document_type_created', meta, actor: by, details: { documentType: t } }, tx);
        return t;
      })
      .catch(uniqueToConflict('That type code is already used.'));
  }

  @Roles('ADMIN')
  @Patch('document-types/:id')
  async updateDocumentType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(documentTypeSchema.partial())) body: Partial<z.infer<typeof documentTypeSchema>>,
    @CurrentUser() by: AuthUser,
    @Meta() meta: RequestMeta,
  ) {
    const before = await this.db.query.documentTypes.findFirst({ where: eq(documentTypes.id, id) });
    if (!before) throw new NotFoundException('Document type not found.');
    if (body.code && body.code !== before.code) {
      const used = await this.db.$count(documents, and(eq(documents.documentTypeId, id), isNotNull(documents.referenceNo)));
      if (used) throw new ConflictException('This code already appears in reference numbers and cannot change.');
    }
    return this.db
      .transaction(async (tx) => {
        const [t] = await tx.update(documentTypes).set(body).where(eq(documentTypes.id, id)).returning();
        await this.audit.record({ type: 'setup.document_type_updated', meta, actor: by, details: { before, after: t } }, tx);
        return t;
      })
      .catch(uniqueToConflict('That type code is already used.'));
  }

  // ───────────── Approval currency ─────────────

  @Get('settings/approval')
  async approvalSettings(): Promise<ApprovalSettings> {
    const s = await this.db.query.settings.findFirst({ where: eq(settings.key, APPROVAL_SETTINGS_KEY) });
    return s ? approvalSettingsSchema.parse(s.value) : DEFAULT_APPROVAL;
  }

  @Roles('ADMIN')
  @Put('settings/approval')
  saveApprovalSettings(@Body(new ZodPipe(approvalSettingsSchema)) body: ApprovalSettings, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const before = await tx.query.settings.findFirst({ where: eq(settings.key, APPROVAL_SETTINGS_KEY) });
      await tx
        .insert(settings)
        .values({ key: APPROVAL_SETTINGS_KEY, value: body, updatedById: by.id })
        .onConflictDoUpdate({ target: settings.key, set: { value: body, updatedById: by.id } });
      await this.audit.record({ type: 'setup.approval_settings_changed', meta, actor: by, details: { before: before?.value ?? null, after: body } }, tx);
      return body;
    });
  }

  // ───────────── Approval chains ─────────────

  @Roles('ADMIN', 'AUDITOR', 'SENDER', 'APPROVER')
  @Get('approval-policies')
  policies() {
    return this.db.query.approvalPolicies.findMany({
      with: {
        steps: { orderBy: asc(approvalPolicySteps.stepOrder), with: { approver: { columns: { id: true, fullName: true, email: true } } } },
        documentType: { columns: { id: true, code: true, name: true } },
        department: { columns: { id: true, code: true, name: true } },
      },
      orderBy: asc(approvalPolicies.name),
    });
  }

  @Roles('ADMIN')
  @Post('approval-policies')
  createPolicy(@Body(new ZodPipe(approvalPolicySchema)) body: ApprovalPolicyInput, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(approvalPolicies)
        .values({ name: body.name, documentTypeId: body.documentTypeId, departmentId: body.departmentId, active: body.active })
        .returning();
      await tx.insert(approvalPolicySteps).values(stepRows(p.id, body));
      await this.audit.record({ type: 'setup.approval_policy_created', meta, actor: by, details: { id: p.id, policy: body } }, tx);
      return p;
    });
  }

  @Roles('ADMIN')
  @Put('approval-policies/:id')
  async replacePolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(approvalPolicySchema)) body: ApprovalPolicyInput,
    @CurrentUser() by: AuthUser,
    @Meta() meta: RequestMeta,
  ) {
    const before = await this.db.query.approvalPolicies.findFirst({ where: eq(approvalPolicies.id, id), with: { steps: true } });
    if (!before) throw new NotFoundException('Approval chain not found.');
    return this.db.transaction(async (tx) => {
      await tx.delete(approvalPolicySteps).where(eq(approvalPolicySteps.policyId, id));
      const [p] = await tx
        .update(approvalPolicies)
        .set({ name: body.name, documentTypeId: body.documentTypeId, departmentId: body.departmentId, active: body.active })
        .where(eq(approvalPolicies.id, id))
        .returning();
      await tx.insert(approvalPolicySteps).values(stepRows(id, body));
      await this.audit.record({ type: 'setup.approval_policy_changed', meta, actor: by, details: { id, before, after: body } }, tx);
      return p;
    });
  }
}

function stepRows(policyId: string, body: ApprovalPolicyInput) {
  return body.steps.map((s, i) => ({
    policyId,
    stepOrder: i + 1,
    label: s.label,
    approverUserId: s.approverUserId,
    minAmount: s.minAmount === null ? null : s.minAmount.toFixed(2),
  }));
}

function uniqueToConflict(message: string) {
  return (e: unknown): never => {
    const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === '23505') throw new ConflictException(message); // PostgreSQL unique violation
    throw e;
  };
}
