import { Inject, Injectable, Logger } from '@nestjs/common';
import { formatSigningDate } from '@ruliba/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { sha256Hex } from '../common/crypto.service';
import { AppConfig, CONFIG } from '../config';
import { Database, DbService } from '../db/db';
import { auditEvents, documentFiles, documents, fieldValues, fields, recipients } from '../db/schema';
import { EmailService, OutgoingMail } from '../email/email.service';
import { StorageService } from '../files/storage.service';
import { SealService } from '../pdf/seal.service';
import { certificatePdf, stampDocument, StampField } from '../pdf/stamp';

const when = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'long', timeZone: 'Africa/Kigali' }).format(d) : 'n/a';

/** Graph allows about 3 MB of inline attachments; larger signed copies are downloaded from the app instead. */
const ATTACH_LIMIT = 3 * 1024 * 1024;

/**
 * When the last signer finishes: draw every field onto the PDF, add the signing record page,
 * store the signed copy with its fingerprint, mark the document completed and send everyone a copy.
 * Safe to run twice: it locks the document row and does nothing if it is already completed.
 * The worker re-runs it for any document left with everyone signed but no signed copy (self-repair).
 */
@Injectable()
export class FinalizerService {
  private readonly log = new Logger('Finalizer');
  private readonly db: Database;

  constructor(
    @Inject(DbService) dbs: { db: Database },
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly sealer: SealService,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'APP_URL'>,
  ) {
    this.db = dbs.db;
  }

  async finalize(documentId: string): Promise<boolean> {
    const outbox: OutgoingMail[] = [];
    const done = await this.db.transaction(async (tx) => {
      const locked = await tx.execute<{ status: string }>(sql`select status from documents where id = ${documentId} for update`);
      if (locked.rows[0]?.status !== 'IN_PROGRESS') return false;
      const doc = await tx.query.documents.findFirst({
        where: eq(documents.id, documentId),
        with: { recipients: { orderBy: [asc(recipients.stepOrder)] }, files: true, sender: { columns: { id: true, fullName: true, email: true } } },
      });
      if (!doc) return false;
      const signers = doc.recipients.filter((r) => r.role === 'SIGNER');
      if (!signers.length || signers.some((s) => s.status !== 'COMPLETED')) return false;

      const prepared = doc.files.find((f) => f.kind === 'CONVERTED') ?? doc.files.find((f) => f.kind === 'ORIGINAL')!;
      const pdf = await this.storage.get(prepared.storageKey, prepared.wrappedKey);
      if (sha256Hex(pdf) !== prepared.sha256) throw new Error(`Prepared file of ${documentId} does not match its fingerprint`);

      const rows = await tx
        .select({ f: fields, v: fieldValues })
        .from(fields)
        .leftJoin(fieldValues, eq(fieldValues.fieldId, fields.id))
        .where(eq(fields.documentId, documentId));
      const stamp: StampField[] = [];
      for (const { f, v } of rows) {
        if (!v) continue;
        const image = v.imageKey && v.wrappedKey ? await this.storage.get(v.imageKey, v.wrappedKey) : null;
        stamp.push({ type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, value: v.value, image });
      }

      const events = await tx.select().from(auditEvents).where(eq(auditEvents.documentId, documentId)).orderBy(asc(auditEvents.id));
      const completedAt = new Date();
      // Approvals first (they happened first), then signers, then copy recipients.
      const ordered = (['APPROVER', 'SIGNER', 'CC'] as const).flatMap((role) => doc.recipients.filter((r) => r.role === role));
      const people = ordered.map((r) => {
        const signed = events.filter((e) => e.recipientId === r.id && e.type === 'recipient.signed').at(-1);
        const verified = events.filter((e) => e.recipientId === r.id && e.type === 'recipient.verified').at(-1);
        const opened = events.find((e) => e.recipientId === r.id && e.type === 'document.viewed');
        const d = (signed?.details ?? {}) as { methods?: string[] };
        return {
          name: r.fullName,
          email: r.email,
          role:
            r.role === 'SIGNER'
              ? `Signer, step ${r.stepOrder}${r.isExternal ? ', outside Ruliba' : ', Ruliba staff'}`
              : r.role === 'APPROVER'
                ? `Internal approval, step ${r.stepOrder} (approval is not a signature on the document)`
                : 'Received a copy',
          rows:
            r.role === 'APPROVER'
              ? (() => {
                  const ok = events.filter((e) => e.recipientId === r.id && e.type === 'approval.approved').at(-1);
                  const c = (ok?.details as { comment?: string | null } | undefined)?.comment;
                  return [
                    { label: 'Asked to approve', value: when(r.sentAt) },
                    { label: 'Approved', value: when(r.completedAt) + ' (Ruliba staff sign-in)' },
                    ...(c ? [{ label: 'Comment', value: c }] : []),
                    { label: 'IP address', value: ok?.ip ?? 'n/a' },
                  ];
                })()
              : r.role === 'SIGNER'
              ? [
                  { label: 'Invited', value: when(r.sentAt) },
                  {
                    label: 'Identity checked by',
                    value: (() => {
                      const v = (verified?.details ?? {}) as { method?: string; twoStep?: boolean };
                      if (v.method !== 'account') return 'one-time code sent to this email address';
                      return v.twoStep ? 'Ruliba staff sign-in with two-step code' : 'Ruliba staff sign-in with password';
                    })(),
                  },
                  { label: 'First opened', value: when(opened?.occurredAt) },
                  { label: 'Agreed to sign electronically', value: when(r.consentAt) + (r.consentTextVersion ? ` (consent text ${r.consentTextVersion})` : '') },
                  { label: 'Signed', value: when(r.completedAt) },
                  { label: 'Signature made by', value: (d.methods ?? []).map((m) => m.toLowerCase()).join(', ') || 'n/a' },
                  ...((d as { stamps?: { name: string; sha256: string }[] }).stamps ?? []).map((st) => ({ label: 'Stamp applied', value: `${st.name} (image fingerprint ${st.sha256.slice(0, 16)})` })),
                  { label: 'IP address', value: signed?.ip ?? 'n/a' },
                  { label: 'Device', value: (signed?.userAgent ?? 'n/a').slice(0, 160) },
                ]
              : [],
        };
      });

      const record = {
        title: doc.title,
        reference: doc.referenceNo,
        documentId: doc.id,
        preparedSha256: prepared.sha256,
        sender: `${doc.sender.fullName} <${doc.sender.email}>`,
        sentAt: when(doc.sentAt),
        completedAt: when(completedAt),
        people,
        footer:
          'Signed with Ruliba Clays eSign. Every step above is held in a tamper-evident activity log, together with the fingerprint (SHA-256) ' +
          'of this signed file. The file carries the digital seal of Ruliba Clays Ltd: any change made after signing shows in a PDF reader. ' +
          `Anyone can check a copy at ${this.config.APP_URL}/check.`,
      };
      // Stamp the fields and the record page, then apply Ruliba's digital seal over the whole file.
      const stamped = await stampDocument(pdf, stamp, record);
      const { sealed: signed, certificateFingerprint } = await this.sealer.seal(stamped, 'Signed by all parties with Ruliba Clays eSign');
      const sha = sha256Hex(signed);
      const key = this.storage.newKey(`documents/${documentId}`);
      const { wrappedKey } = await this.storage.put(key, signed);
      const { sealed: cert } = await this.sealer.seal(await certificatePdf(record), 'Certificate of completion issued by Ruliba Clays eSign');
      const certKey = this.storage.newKey(`documents/${documentId}`);
      const certStored = await this.storage.put(certKey, cert);
      const pages = doc.files.find((f) => f.kind === 'CONVERTED')?.pageCount ?? prepared.pageCount ?? 0;
      const baseName = prepared.fileName.replace(/\.pdf$/i, '');
      const [file] = await tx
        .insert(documentFiles)
        .values({
          documentId,
          kind: 'SEALED',
          storageKey: key,
          fileName: `${baseName} (signed).pdf`,
          mimeType: 'application/pdf',
          sizeBytes: signed.length,
          sha256: sha,
          pageCount: pages + 1,
          wrappedKey,
        })
        .returning({ id: documentFiles.id });
      await tx.insert(documentFiles).values({
        documentId,
        kind: 'CERTIFICATE',
        storageKey: certKey,
        fileName: `${baseName} (certificate of completion).pdf`,
        mimeType: 'application/pdf',
        sizeBytes: cert.length,
        sha256: sha256Hex(cert),
        pageCount: null,
        wrappedKey: certStored.wrappedKey,
      });
      await tx.update(documents).set({ status: 'COMPLETED', completedAt }).where(eq(documents.id, documentId));
      await this.audit.record(
        {
          type: 'document.completed',
          documentId,
          docSha256: sha,
          details: { signedFileSha256: sha, certificateSha256: sha256Hex(cert), preparedSha256: prepared.sha256, signers: signers.length, fieldsStamped: stamp.length, sealCertificate: certificateFingerprint },
        },
        tx,
      );

      const attach = signed.length <= ATTACH_LIMIT ? [{ documentFileId: file.id }] : [];
      const everyone = [
        ...doc.recipients.map((r) => ({ email: r.email, name: r.fullName, userId: r.userId ?? undefined })),
        ...(doc.recipients.some((r) => r.email === doc.sender.email) ? [] : [{ email: doc.sender.email, name: doc.sender.fullName, userId: doc.sender.id }]),
      ];
      for (const p of everyone) {
        outbox.push({
          to: p.email,
          userId: p.userId,
          documentId,
          template: 'document-completed',
          subject: `Completed: ${doc.title}`,
          data: {
            name: p.name,
            title: doc.title,
            reference: doc.referenceNo ?? '',
            sha256: sha,
            attached: attach.length ? 'yes' : '',
            link: `${this.config.APP_URL}/documents/${documentId}`,
          },
          attachments: attach,
        });
      }
      return true;
    });
    for (const m of outbox) await this.email.enqueue(m);
    if (done) this.log.log(`Document ${documentId} completed`);
    return done;
  }

  /** Documents where everyone has signed but no signed copy was made (e.g. the server stopped mid-way). */
  async repairPending(): Promise<number> {
    const stuck = await this.db.execute<{ id: string }>(sql`
      select d.id from documents d
      where d.status = 'IN_PROGRESS'
        and exists (select 1 from recipients r where r.document_id = d.id and r.role = 'SIGNER')
        and not exists (select 1 from recipients r where r.document_id = d.id and r.role = 'SIGNER' and r.status <> 'COMPLETED')`);
    let n = 0;
    for (const { id } of stuck.rows) if (await this.finalize(id)) n++;
    return n;
  }
}

