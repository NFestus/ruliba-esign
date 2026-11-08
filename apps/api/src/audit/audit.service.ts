import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, like, lt, sql, SQL } from 'drizzle-orm';
import { Database, DbOrTx, DbService } from '../db/db';
import { auditEvents } from '../db/schema';
import { RequestMeta } from '../common/request-meta';
import { ChainedFields, GENESIS_HASH, chainHash } from './hash';

/** Fixed key for pg_advisory_xact_lock: one audit row is appended at a time, so the chain never forks. */
const AUDIT_LOCK_KEY = 7_204_211;

export interface AuditInput {
  type: string;
  meta?: RequestMeta;
  actor?: { id?: string | null; email?: string | null; name?: string | null };
  documentId?: string | null;
  recipientId?: string | null;
  docSha256?: string | null;
  details?: Record<string, unknown>;
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  lastHash: string;
  brokenAtId?: number;
  reason?: string;
}

/** Can be built with a plain Database (worker, seed) or injected (API). */
@Injectable()
export class AuditService {
  private readonly db: Database;
  constructor(@Inject(DbService) dbs: { db: Database }) {
    this.db = dbs.db;
  }

  /**
   * Append an event. Pass `tx` to write it in the same transaction as the change it records,
   * so the change and its evidence are saved together or not at all.
   */
  async record(input: AuditInput, tx?: DbOrTx): Promise<void> {
    if (tx && tx !== this.db) return this.append(tx, input);
    await this.db.transaction((t) => this.append(t, input));
  }

  private async append(tx: DbOrTx, input: AuditInput): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
    const [last] = await tx.select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const fields: ChainedFields = {
      occurredAt: new Date(),
      type: input.type,
      documentId: input.documentId ?? null,
      recipientId: input.recipientId ?? null,
      actorUserId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      actorName: input.actor?.name ?? null,
      ip: input.meta?.ip ?? null,
      userAgent: input.meta?.userAgent ?? null,
      docSha256: input.docSha256 ?? null,
      // JSON round-trip so what is hashed is exactly what jsonb stores (no Dates, no undefined)
      details: JSON.parse(JSON.stringify(input.details ?? {})),
    };
    const hash = chainHash(prevHash, fields);
    await tx.insert(auditEvents).values({
      occurredAt: fields.occurredAt,
      type: fields.type,
      documentId: fields.documentId,
      recipientId: fields.recipientId,
      actorUserId: fields.actorUserId,
      actorEmail: fields.actorEmail,
      actorName: fields.actorName,
      ip: fields.ip,
      userAgent: fields.userAgent,
      docSha256: fields.docSha256,
      details: fields.details,
      prevHash,
      hash,
    });
  }

  /** Re-compute the whole chain. Used by the nightly integrity job and the Auditor's "check" button. */
  async verifyChain(batchSize = 1000): Promise<ChainCheck> {
    let prev = GENESIS_HASH;
    let checked = 0;
    let afterId = 0;
    for (;;) {
      const rows = await this.db.select().from(auditEvents).where(gt(auditEvents.id, afterId)).orderBy(asc(auditEvents.id)).limit(batchSize);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.prevHash !== prev) return { ok: false, checked, lastHash: prev, brokenAtId: r.id, reason: 'previous-hash link does not match' };
        if (chainHash(prev, r) !== r.hash) return { ok: false, checked, lastHash: prev, brokenAtId: r.id, reason: 'event content was changed' };
        prev = r.hash;
        checked++;
      }
      afterId = rows[rows.length - 1].id;
    }
    return { ok: true, checked, lastHash: prev };
  }

  list(p: { documentId?: string; actorUserId?: string; type?: string; beforeId?: number; limit: number }) {
    const where: SQL[] = [];
    if (p.documentId) where.push(eq(auditEvents.documentId, p.documentId));
    if (p.actorUserId) where.push(eq(auditEvents.actorUserId, p.actorUserId));
    if (p.type) where.push(like(auditEvents.type, `${p.type.replace(/[%_\\]/g, '')}%`));
    if (p.beforeId) where.push(lt(auditEvents.id, p.beforeId));
    return this.db
      .select()
      .from(auditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditEvents.id))
      .limit(p.limit);
  }
}
