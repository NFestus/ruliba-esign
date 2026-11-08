import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256Hex } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { AppConfig, CONFIG } from '../config';
import { issueAccountToken } from '../auth/account-tokens';
import { Tx } from '../db/db';
import { departments, documents, documentTypes, recipients, users } from '../db/schema';
import { ReferenceService } from '../reference/reference.service';
import { EmailService, OutgoingMail } from '../email/email.service';

type RecipientRow = typeof recipients.$inferSelect;
type DocRow = typeof documents.$inferSelect & { sender?: { fullName: string; email: string } };

const fmt = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Kigali' }).format(d) : '';

/**
 * Signing order. Every recipient has a step number; people with the same number sign in parallel,
 * and the next step starts only when everyone in the current step has signed.
 * Sequential = 1, 2, 3…; parallel = all 1; mixed = any grouping.
 *
 * Emails are collected in an "outbox" during the database transaction and queued only after it
 * commits, so nobody is ever invited to sign a change that was rolled back.
 */
@Injectable()
export class RoutingService {
  constructor(
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly references: ReferenceService,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'APP_URL' | 'ACTIVATION_TOKEN_TTL_HOURS'>,
  ) {}

  get appUrl() {
    return this.config.APP_URL;
  }

  async deliver(outbox: OutgoingMail[]) {
    for (const m of outbox) await this.email.enqueue(m);
  }

  /**
   * Moves the document on. Approvers (staff, in the app) come first, one step at a time; when the last
   * approver agrees the document gets its reference number and the signers' first step is invited.
   * Returns `complete` when every signer has signed.
   */
  async activateNextStep(tx: Tx, documentId: string, meta?: RequestMeta): Promise<OutgoingMail[] & { complete?: boolean }> {
    const doc = await tx.query.documents.findFirst({ where: eq(documents.id, documentId), with: { sender: { columns: { fullName: true, email: true } } } });
    const people = await tx.select().from(recipients).where(eq(recipients.documentId, documentId)).orderBy(asc(recipients.stepOrder));
    const outbox: OutgoingMail[] & { complete?: boolean } = [];
    if (!doc) return outbox;

    if (doc.status === 'PENDING_APPROVAL') {
      const approvers = people.filter((p) => p.role === 'APPROVER');
      if (approvers.some((a) => a.status === 'SENT' || a.status === 'VIEWED')) return outbox;
      const waitingA = approvers.filter((a) => a.status === 'WAITING');
      if (waitingA.length) {
        const step = Math.min(...waitingA.map((a) => a.stepOrder));
        for (const a of waitingA.filter((x) => x.stepOrder === step)) outbox.push(...(await this.askApproval(tx, doc, a, meta)));
        return outbox;
      }
      // Everyone approved: number the document and start signing.
      const [codes] = await tx
        .select({ dept: departments.code, type: documentTypes.code })
        .from(documents)
        .innerJoin(departments, eq(departments.id, documents.departmentId))
        .innerJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
        .where(eq(documents.id, documentId));
      const ref = await this.references.next(tx, codes.dept, codes.type);
      await tx.update(documents).set({ status: 'IN_PROGRESS', referenceNo: ref }).where(and(eq(documents.id, documentId), eq(documents.status, 'PENDING_APPROVAL')));
      await this.audit.record({ type: 'document.approved', meta, documentId, details: { referenceNo: ref, approvers: approvers.map((a) => a.fullName) } }, tx);
      doc.status = 'IN_PROGRESS';
      doc.referenceNo = ref;
    }

    const signers = people.filter((p) => p.role === 'SIGNER');
    if (signers.some((s) => s.status === 'SENT' || s.status === 'VIEWED')) return outbox; // current step still open
    const waiting = signers.filter((s) => s.status === 'WAITING');
    if (!waiting.length) {
      outbox.complete = signers.length > 0 && signers.every((s) => s.status === 'COMPLETED');
      return outbox;
    }
    const step = Math.min(...waiting.map((s) => s.stepOrder));
    for (const r of waiting.filter((s) => s.stepOrder === step)) outbox.push(...(await this.invite(tx, doc, r, meta)));
    return outbox;
  }

  private async askApproval(tx: Tx, doc: DocRow, a: RecipientRow, meta?: RequestMeta): Promise<OutgoingMail[]> {
    await tx.update(recipients).set({ status: 'SENT', sentAt: new Date() }).where(eq(recipients.id, a.id));
    await this.audit.record({ type: 'approval.requested', meta, documentId: doc.id, recipientId: a.id, details: { name: a.fullName, email: a.email, step: a.stepOrder } }, tx);
    return [
      {
        to: a.email,
        userId: a.userId ?? undefined,
        documentId: doc.id,
        template: 'approval-request',
        subject: `Approval needed: ${doc.title}`,
        data: { name: a.fullName, senderName: doc.sender?.fullName ?? 'A colleague', title: doc.title, message: doc.emailMessage ?? '', link: `${this.config.APP_URL}/documents/${doc.id}` },
      },
    ];
  }

  /**
   * Prepare the invitation email. People outside Ruliba get a fresh personal link (older links stop working)
   * and confirm with an emailed code. Ruliba staff (an eSign account) get a link to the document in eSign:
   * they sign in, with two-step sign-in where set up, and land on it. No link token or code for them.
   */
  async invite(tx: Tx, doc: DocRow, r: RecipientRow, meta?: RequestMeta, reminder = false): Promise<OutgoingMail[]> {
    const internal = !!r.userId;
    const token = internal ? null : randomToken(32);
    await tx
      .update(recipients)
      .set({
        ...(token ? { accessTokenHash: sha256Hex(token) } : {}),
        tokenExpiresAt: doc.expiresAt,
        status: r.status === 'VIEWED' ? 'VIEWED' : 'SENT',
        sentAt: r.sentAt ?? new Date(),
        lastReminderAt: reminder ? new Date() : r.lastReminderAt,
      })
      .where(eq(recipients.id, r.id));
    await this.audit.record(
      {
        type: reminder ? 'recipient.reminded' : 'recipient.invited',
        meta,
        documentId: doc.id,
        recipientId: r.id,
        details: { name: r.fullName, email: r.email, step: r.stepOrder, linkExpiresAt: doc.expiresAt?.toISOString() ?? null },
      },
      tx,
    );
    const sender = doc.sender ?? (await tx.query.users.findFirst({ where: eq(users.id, doc.senderId), columns: { fullName: true, email: true } }));
    // A staff signer who has not activated their account yet gets a fresh activation link in the same email.
    let activationLink = '';
    if (r.userId) {
      const u = await tx.query.users.findFirst({ where: eq(users.id, r.userId), columns: { status: true } });
      if (u?.status === 'PENDING') {
        const { token: t } = await issueAccountToken(tx, r.userId, 'ACTIVATION', this.config.ACTIVATION_TOKEN_TTL_HOURS * 3_600_000);
        // After activating, the sign-in page takes them straight to the document.
        activationLink = `${this.config.APP_URL}/activate/${t}?next=${encodeURIComponent(`/documents/${doc.id}/sign`)}`;
      }
    }
    return [
      {
        to: r.email,
        userId: r.userId ?? undefined,
        documentId: doc.id,
        template: 'sign-invite',
        subject: doc.emailSubject || `${reminder ? 'Reminder: ' : ''}Please sign: ${doc.title}`,
        data: {
          name: r.fullName,
          senderName: sender?.fullName ?? 'Ruliba Clays',
          title: doc.title,
          reference: doc.referenceNo ?? '',
          message: doc.emailMessage ?? '',
          expires: fmt(doc.expiresAt),
          link: token ? `${this.config.APP_URL}/sign/${token}` : `${this.config.APP_URL}/documents/${doc.id}/sign`,
          internal: internal ? '1' : '',
          reminder: reminder ? 'yes' : '',
          activationLink,
        },
      },
    ];
  }

  voidNotices(doc: DocRow & { recipients: RecipientRow[] }, reason: string): OutgoingMail[] {
    return doc.recipients
      .filter((r) => r.role === 'SIGNER' && ['SENT', 'VIEWED', 'COMPLETED'].includes(r.status))
      .map((r) => ({
        to: r.email,
        userId: r.userId ?? undefined,
        documentId: doc.id,
        template: 'document-voided' as const,
        subject: `Cancelled: ${doc.title}`,
        data: { name: r.fullName, title: doc.title, reason, senderName: doc.sender?.fullName ?? 'The sender' },
      }));
  }

  /** People still to act are told nothing more; the sender learns who declined and why. */
  async declineNotices(tx: Tx, documentId: string, decliner: RecipientRow, reason: string): Promise<OutgoingMail[]> {
    const doc = await tx.query.documents.findFirst({ where: eq(documents.id, documentId), with: { sender: { columns: { fullName: true, email: true, id: true } } } });
    if (!doc) return [];
    const signed = await tx.select().from(recipients).where(and(eq(recipients.documentId, documentId), inArray(recipients.status, ['COMPLETED'])));
    const notice = (to: string, name: string, userId?: string): OutgoingMail => ({
      to,
      userId,
      documentId,
      template: 'document-declined',
      subject: `Declined: ${doc.title}`,
      data: { name, title: doc.title, decliner: `${decliner.fullName} (${decliner.email})`, reason, link: `${this.config.APP_URL}/documents/${documentId}` },
    });
    return [notice(doc.sender.email, doc.sender.fullName, doc.sender.id), ...signed.filter((s) => s.id !== decliner.id).map((s) => notice(s.email, s.fullName, s.userId ?? undefined))];
  }
}
