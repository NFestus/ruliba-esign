import './env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './common/crypto.service';
import { loadConfig } from './config';
import { createDb } from './db/db';
import { documentFiles, notifications } from './db/schema';
import { FinalizerService } from './documents/finalizer.service';
import { JobsService } from './documents/jobs.service';
import { RoutingService } from './documents/routing.service';
import { EMAIL_QUEUE, EmailJob, EmailService, redisConnection } from './email/email.service';
import { createTransport, OutgoingEmail } from './email/transports';
import { SMS_QUEUE, SmsJob } from './sms/sms.service';
import { createSmsTransport } from './sms/transports';
import { StorageService } from './files/storage.service';
import { SealService } from './pdf/seal.service';
import { ReferenceService } from './reference/reference.service';

/**
 * Background worker: same code base, separate container.
 *  - sends queued emails (attachments are decrypted here, at send time) and text messages (sign-in codes);
 *  - every 5 minutes: finishes documents whose signers are all done but have no signed copy yet;
 *  - every hour: reminders and expiry;
 *  - nightly: re-checks the whole audit chain and emails its fingerprint to an independent mailbox.
 */
const MAINTENANCE_QUEUE = 'maintenance';

async function main() {
  const cfg = loadConfig();
  const log = new Logger('Worker');
  const { pool, db } = createDb(cfg.DATABASE_URL, 5);
  const dbs = { db } as never;
  const audit = new AuditService({ db });
  const crypto = new CryptoService(cfg);
  const storage = new StorageService(crypto, cfg);
  const email = new EmailService(dbs, cfg);
  const sealer = new SealService({ db }, crypto, audit);
  const finalizer = new FinalizerService({ db }, storage, audit, email, sealer, cfg);
  const routing = new RoutingService(audit, email, new ReferenceService(), cfg);
  const jobs = new JobsService({ db }, audit, email, routing, cfg);
  const transport = createTransport(cfg);
  const connection = redisConnection(cfg.REDIS_URL);

  const emailWorker = new Worker<EmailJob>(
    EMAIL_QUEUE,
    async (job) => {
      const msg: OutgoingEmail = { to: job.data.to, onBehalfOf: job.data.onBehalfOf, subject: job.data.subject, html: job.data.html, text: job.data.text };
      if (job.data.attachments?.length) {
        msg.attachments = [];
        for (const a of job.data.attachments) {
          const f = await db.query.documentFiles.findFirst({ where: eq(documentFiles.id, a.documentFileId) });
          if (!f) continue;
          msg.attachments.push({ filename: f.fileName, contentType: f.mimeType, content: await storage.get(f.storageKey, f.wrappedKey) });
        }
      }
      await transport.send(msg);
      await db.update(notifications).set({ status: 'SENT', sentAt: new Date(), error: null }).where(eq(notifications.id, job.data.notificationId));
    },
    { connection, concurrency: 4 },
  );
  emailWorker.on('failed', async (job, err) => {
    log.warn(`Email job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await db
        .update(notifications)
        .set({ status: 'FAILED', error: err.message.slice(0, 500) })
        .where(eq(notifications.id, job.data.notificationId))
        .catch(() => undefined);
    }
  });

  const smsTransport = createSmsTransport(cfg);
  const smsWorker = new Worker<SmsJob>(SMS_QUEUE, async (job) => smsTransport.send(job.data), { connection, concurrency: 4 });
  smsWorker.on('failed', (job, err) => log.warn(`SMS job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));

  const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenance.upsertJobScheduler('audit-chain-check', { pattern: '15 2 * * *', tz: 'Africa/Kigali' }, { name: 'audit-chain-check' });
  await maintenance.upsertJobScheduler('finish-documents', { every: 5 * 60_000 }, { name: 'finish-documents' });
  await maintenance.upsertJobScheduler('reminders', { pattern: '0 * * * *', tz: 'Africa/Kigali' }, { name: 'reminders' });
  await maintenance.upsertJobScheduler('expiry', { pattern: '5 * * * *', tz: 'Africa/Kigali' }, { name: 'expiry' });
  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'audit-chain-check':
          await jobs.anchorAuditLog();
          break;
        case 'finish-documents': {
          const n = await finalizer.repairPending();
          if (n) log.log(`Finished ${n} document(s) that were waiting for their signed copy`);
          break;
        }
        case 'reminders':
          await jobs.sendReminders();
          break;
        case 'expiry':
          await jobs.expireDocuments();
          break;
      }
    },
    { connection },
  );

  log.log(`Worker started; email via ${transport.name}, SMS via ${smsTransport.name}`);
  const stop = async () => {
    await Promise.allSettled([emailWorker.close(), smsWorker.close(), maintenanceWorker.close(), maintenance.close(), email.onModuleDestroy()]);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
