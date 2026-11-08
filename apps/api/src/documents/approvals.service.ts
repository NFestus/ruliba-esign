import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/decorators';
import { RequestMeta } from '../common/request-meta';
import { Database, DbService } from '../db/db';
import { approvalPolicies, approvalPolicySteps, documents, recipients, users } from '../db/schema';
import { RoutingService } from './routing.service';

export interface ApprovalStep {
  label: string;
  approverUserId: string;
  approverName: string;
  approverEmail: string;
  minAmount: string | null;
}

/**
 * Internal approval before a document goes out (e.g. Procurement Manager, then Finance Director,
 * then the Managing Director above a value threshold).
 * The chain comes from Settings > Approvals: the most specific active chain wins
 * (type + department, then type for any department, then the catch-all chain).
 */
@Injectable()
export class ApprovalsService {
  private readonly db: Database;

  constructor(
    dbs: DbService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
  ) {
    this.db = dbs.db;
  }

  /** The approval steps that apply to a document, or a plain explanation of what is missing. */
  async stepsFor(doc: { documentTypeId: string; departmentId: string; contractValue: string | null }): Promise<{ steps: ApprovalStep[]; problem?: string; policyName?: string }> {
    const policies = await this.db.query.approvalPolicies.findMany({
      where: and(
        eq(approvalPolicies.active, true),
        or(eq(approvalPolicies.documentTypeId, doc.documentTypeId), isNull(approvalPolicies.documentTypeId)),
        or(eq(approvalPolicies.departmentId, doc.departmentId), isNull(approvalPolicies.departmentId)),
      ),
      with: { steps: { orderBy: asc(approvalPolicySteps.stepOrder), with: { approver: { columns: { id: true, fullName: true, email: true, status: true } } } } },
    });
    const score = (p: (typeof policies)[number]) => (p.documentTypeId ? 2 : 0) + (p.departmentId ? 1 : 0);
    const policy = policies.sort((a, b) => score(b) - score(a))[0];
    if (!policy) return { steps: [], problem: 'This document type needs approval, but no approval chain is set up. Ask the administrator (Settings, Approvals).' };

    const value = doc.contractValue === null ? null : Number(doc.contractValue);
    const applies = policy.steps.filter((s) => s.minAmount === null || value === null || value > Number(s.minAmount));
    if (value === null && policy.steps.some((s) => s.minAmount !== null)) {
      return { steps: [], policyName: policy.name, problem: 'Enter the contract value: it decides who needs to approve.' };
    }
    const unassigned = applies.find((s) => !s.approver || s.approver.status !== 'ACTIVE');
    if (unassigned) return { steps: [], policyName: policy.name, problem: `No one is assigned as ${unassigned.label}. Ask the administrator (Settings, Approvals).` };
    return {
      policyName: policy.name,
      steps: applies.map((s) => ({ label: s.label, approverUserId: s.approver!.id, approverName: s.approver!.fullName, approverEmail: s.approver!.email, minAmount: s.minAmount })),
    };
  }

  private async pending(user: AuthUser, id: string) {
    const doc = await this.db.query.documents.findFirst({ where: eq(documents.id, id), with: { recipients: true } });
    if (!doc) throw new NotFoundException('Document not found.');
    if (doc.status !== 'PENDING_APPROVAL') throw new ConflictException('This document is not waiting for approval.');
    const mine = doc.recipients.find((r) => r.role === 'APPROVER' && r.userId === user.id && ['SENT', 'VIEWED'].includes(r.status));
    if (!mine) throw new ConflictException('It is not your turn to approve this document.');
    return { doc, mine };
  }

  async approve(user: AuthUser, id: string, comment: string | null, meta: RequestMeta) {
    const { mine } = await this.pending(user, id);
    const outbox = await this.db.transaction(async (tx) => {
      const res = await tx
        .update(recipients)
        .set({ status: 'COMPLETED', completedAt: new Date() })
        .where(and(eq(recipients.id, mine.id), inArray(recipients.status, ['SENT', 'VIEWED'])))
        .returning({ id: recipients.id });
      if (!res.length) throw new ConflictException('You have already answered this approval.');
      await this.audit.record({ type: 'approval.approved', meta, actor: user, documentId: id, recipientId: mine.id, details: { step: mine.stepOrder, as: mine.fullName, comment } }, tx);
      return this.routing.activateNextStep(tx, id, meta);
    });
    await this.routing.deliver(outbox);
  }

  /** Sends the document back to the sender as a draft. The sender corrects it and sends it again. */
  async reject(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const { doc, mine } = await this.pending(user, id);
    const sender = await this.db.query.users.findFirst({ where: eq(users.id, doc.senderId), columns: { id: true, fullName: true, email: true } });
    await this.db.transaction(async (tx) => {
      await this.audit.record({ type: 'approval.returned', meta, actor: user, documentId: id, recipientId: mine.id, details: { step: mine.stepOrder, reason } }, tx);
      await tx.delete(recipients).where(and(eq(recipients.documentId, id), eq(recipients.role, 'APPROVER')));
      await tx.update(documents).set({ status: 'DRAFT', sentAt: null, expiresAt: null }).where(eq(documents.id, id));
    });
    if (sender)
      await this.routing.deliver([
        {
          to: sender.email,
          userId: sender.id,
          documentId: id,
          template: 'approval-returned',
          subject: `Returned for changes: ${doc.title}`,
          data: { name: sender.fullName, title: doc.title, approver: user.name, reason, link: `${this.routing.appUrl}/documents/${id}/prepare` },
        },
      ]);
  }
}

