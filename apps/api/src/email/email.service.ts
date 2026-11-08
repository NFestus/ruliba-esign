import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db';
import { eq } from 'drizzle-orm';
import { documents, notifications, users } from '../db/schema';
import { render, TemplateName } from './templates';

export const EMAIL_QUEUE = 'email';

/** Attachments point at a stored document file; the worker decrypts it when sending, so no copy sits in Redis. */
export interface MailAttachment {
  documentFileId: string;
}

export interface OutgoingMail {
  to: string;
  template: TemplateName;
  subject: string;
  data: Record<string, string>;
  userId?: string;
  documentId?: string;
  attachments?: MailAttachment[];
}

/** Shown as "Grace Uwase via Ruliba eSign"; replies go to that person. The address stays sign@ruliba.com. */
export interface OnBehalfOf {
  name: string;
  email: string;
}

/** Emails about a document that read as coming from the staff member who sent it. */
const ON_BEHALF_TEMPLATES = new Set(['sign-invite', 'approval-request', 'document-completed', 'document-voided', 'document-expired']);

export interface EmailJob {
  notificationId: string;
  to: string;
  onBehalfOf?: OnBehalfOf;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

/**
 * Emails are never sent inside a web request: they are recorded as a notification and queued.
 * The worker sends them with retries (5 tries, growing delays), so a slow or failing mail server
 * never blocks or breaks the person using the app.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly queue: Queue<EmailJob>;
  /** In tests, every queued message is also kept here so tests can read links and codes. */
  readonly testOutbox: (EmailJob & { template: string; data: Record<string, string> })[] = [];

  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.queue = new Queue<EmailJob>(EMAIL_QUEUE, { connection: redisConnection(config.REDIS_URL) });
  }

  async enqueue(input: OutgoingMail) {
    const { html, text } = render(input.template, input.data, this.config.APP_URL);
    const [n] = await this.dbs.db
      .insert(notifications)
      .values({ channel: 'EMAIL', email: input.to, userId: input.userId, documentId: input.documentId, template: input.template, subject: input.subject })
      .returning({ id: notifications.id });
    // Staff also see it under the bell in the app (not for codes, account mails or the audit anchor).
    if (input.userId && !['sign-code', 'account-activation', 'password-reset', 'audit-anchor'].includes(input.template)) {
      const link = input.documentId ? (input.template === 'sign-invite' ? `/documents/${input.documentId}/sign` : `/documents/${input.documentId}`) : null;
      await this.dbs.db.insert(notifications).values({ channel: 'IN_APP', userId: input.userId, documentId: input.documentId, template: input.template, subject: input.subject, link, status: 'SENT' });
    }
    const onBehalfOf = await this.senderOf(input);
    const job: EmailJob = { notificationId: n.id, to: input.to, onBehalfOf, subject: input.subject, html, text, attachments: input.attachments };
    if (this.config.NODE_ENV === 'test') this.testOutbox.push({ ...job, template: input.template, data: input.data });
    await this.queue.add('send', job, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      // Message bodies hold signing links: do not keep them in Redis after sending.
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400 },
    });
    return n.id;
  }

  private async senderOf(input: OutgoingMail): Promise<OnBehalfOf | undefined> {
    if (!input.documentId || !ON_BEHALF_TEMPLATES.has(input.template)) return undefined;
    const [row] = await this.dbs.db
      .select({ name: users.fullName, email: users.email })
      .from(documents)
      .innerJoin(users, eq(users.id, documents.senderId))
      .where(eq(documents.id, input.documentId))
      .limit(1);
    if (!row || row.email.toLowerCase() === input.to.toLowerCase()) return undefined;
    return row;
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
