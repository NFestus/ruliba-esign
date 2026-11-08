import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { Database, DbService } from '../db/db';
import { documents, recipients } from '../db/schema';
import { EmailService, OutgoingMail } from '../email/email.service';
import { RoutingService } from './routing.service';

/**
 * Timed work, run by the worker (and callable from tests):
 *  - reminders: anyone invited and not finished gets the link again every N days (per document);
 *  - expiry: documents past their end date stop, and the people involved are told;
 *  - audit anchor: the day's last audit-log fingerprint is emailed to an independent mailbox.
 */
@Injectable()
export class JobsService {
  private readonly log = new Logger('Jobs');
  private readonly db: Database;

  constructor(
    @Inject(DbService) dbs: { db: Database },
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly routing: RoutingService,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'APP_URL' | 'AUDIT_ANCHOR_EMAIL'>,
  ) {
    this.db = dbs.db;
  }

  async sendReminders(now = new Date()): Promise<number> {
    const due = await this.db
      .select({ r: recipients, d: documents })
      .from(recipients)
      .innerJoin(documents, eq(documents.id, recipients.documentId))
      .where(
        and(
          eq(documents.status, 'IN_PROGRESS'),
          eq(recipients.role, 'SIGNER'),
          inArray(recipients.status, ['SENT', 'VIEWED']),
          sql`${documents.reminderEveryDays} is not null`,
          sql`coalesce(${recipients.lastReminderAt}, ${recipients.sentAt}) < ${now}::timestamptz - make_interval(days => ${documents.reminderEveryDays})`,
          sql`(${documents.expiresAt} is null or ${documents.expiresAt} > ${now})`,
        ),
      );
    let n = 0;
    for (const { r, d } of due) {
      const outbox = await this.db.transaction((tx) => this.routing.invite(tx, d, r, undefined, true));
      await this.routing.deliver(outbox);
      n++;
    }
    if (n) this.log.log(`Sent ${n} reminder(s)`);
    return n;
  }

  async expireDocuments(now = new Date()): Promise<number> {
    const expired = await this.db.query.documents.findMany({
      where: and(inArray(documents.status, ['IN_PROGRESS', 'PENDING_APPROVAL']), lt(documents.expiresAt, now)),
      with: { recipients: true, sender: { columns: { id: true, fullName: true, email: true } } },
    });
    for (const d of expired) {
      const outbox: OutgoingMail[] = [];
      const done = await this.db.transaction(async (tx) => {
        const res = await tx
          .update(documents)
          .set({ status: 'EXPIRED' })
          .where(and(eq(documents.id, d.id), inArray(documents.status, ['IN_PROGRESS', 'PENDING_APPROVAL'])))
          .returning({ id: documents.id });
        if (!res.length) return false;
        await tx
          .update(recipients)
          .set({ status: 'CANCELLED' })
          .where(and(eq(recipients.documentId, d.id), inArray(recipients.status, ['WAITING', 'SENT', 'VIEWED'])));
        await this.audit.record({ type: 'document.expired', documentId: d.id, details: { expiresAt: d.expiresAt?.toISOString() } }, tx);
        return true;
      });
      if (!done) continue;
      const notify = [
        { email: d.sender.email, name: d.sender.fullName, userId: d.sender.id, link: `${this.config.APP_URL}/documents/${d.id}` },
        ...d.recipients.filter((r) => ['SENT', 'VIEWED', 'COMPLETED'].includes(r.status) && r.email !== d.sender.email).map((r) => ({ email: r.email, name: r.fullName, userId: r.userId ?? undefined, link: '' })),
      ];
      for (const p of notify) outbox.push({ to: p.email, userId: p.userId, documentId: d.id, template: 'document-expired', subject: `Expired: ${d.title}`, data: { name: p.name, title: d.title, link: p.link } });
      await this.routing.deliver(outbox);
    }
    if (expired.length) this.log.log(`Expired ${expired.length} document(s)`);
    return expired.length;
  }

  /** Off-box anchor: someone who rewrites the whole log cannot also rewrite these emails in another mailbox. */
  async anchorAuditLog() {
    const result = await this.audit.verifyChain();
    await this.audit.record({ type: result.ok ? 'system.audit_chain_ok' : 'system.audit_chain_broken', details: { ...result } });
    if (!result.ok) this.log.error(`AUDIT CHAIN BROKEN at event ${result.brokenAtId}: ${result.reason}`);
    if (this.config.AUDIT_ANCHOR_EMAIL) {
      await this.email.enqueue({
        to: this.config.AUDIT_ANCHOR_EMAIL,
        template: 'audit-anchor',
        subject: `eSign activity log fingerprint ${new Date().toISOString().slice(0, 10)}${result.ok ? '' : ' - CHECK FAILED'}`,
        data: { date: new Date().toISOString().slice(0, 10), hash: result.lastHash, count: String(result.checked), result: result.ok ? 'intact' : `BROKEN at entry ${result.brokenAtId}` },
      });
    }
    return result;
  }
}
