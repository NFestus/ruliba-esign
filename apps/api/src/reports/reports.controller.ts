import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { Database, DbService } from '../db/db';
import { documentFiles, documents, fieldValues, recipients } from '../db/schema';
import { StorageService } from '../files/storage.service';

const range = (from?: string, to?: string) => {
  const ok = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { from: ok(from) ?? '2000-01-01', to: ok(to) ?? '2999-12-31' };
};

/** Management figures and the retention review. Admins and auditors only. */
@Controller()
@Roles('ADMIN', 'AUDITOR')
export class ReportsController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {
    this.db = dbs.db;
  }

  @Get('reports/summary')
  async summary(@Query('from') from?: string, @Query('to') to?: string) {
    const r = range(from, to);
    const where = sql`d.status <> 'DRAFT' and d.sent_at >= ${r.from}::date and d.sent_at < (${r.to}::date + 1)`;
    const q = <T>(s: ReturnType<typeof sql>) => this.db.execute<T & Record<string, unknown>>(s).then((x) => x.rows);
    const [totals] = await q<{ sent: number; completed: number; in_progress: number; declined: number; cancelled: number; expired: number; avg_hours: number | null; median_hours: number | null }>(sql`
      select count(*)::int sent,
        count(*) filter (where d.status = 'COMPLETED')::int completed,
        count(*) filter (where d.status in ('IN_PROGRESS','PENDING_APPROVAL'))::int in_progress,
        count(*) filter (where d.status = 'DECLINED')::int declined,
        count(*) filter (where d.status = 'VOIDED')::int cancelled,
        count(*) filter (where d.status = 'EXPIRED')::int expired,
        round(avg(extract(epoch from d.completed_at - d.sent_at) / 3600)::numeric, 1)::float avg_hours,
        round((percentile_cont(0.5) within group (order by extract(epoch from d.completed_at - d.sent_at) / 3600))::numeric, 1)::float median_hours
      from documents d where ${where}`);
    const byDepartment = await q<{ department: string; sent: number; completed: number }>(sql`
      select dep.name as department, count(*)::int sent, count(*) filter (where d.status = 'COMPLETED')::int completed
      from documents d join departments dep on dep.id = d.department_id where ${where} group by dep.name order by sent desc`);
    const byType = await q<{ type: string; sent: number; completed: number }>(sql`
      select t.name as type, count(*)::int sent, count(*) filter (where d.status = 'COMPLETED')::int completed
      from documents d join document_types t on t.id = d.document_type_id where ${where} group by t.name order by sent desc`);
    const byMonth = await q<{ month: string; sent: number; completed: number }>(sql`
      select to_char(date_trunc('month', d.sent_at at time zone 'Africa/Kigali'), 'YYYY-MM') as month,
        count(*)::int sent, count(*) filter (where d.status = 'COMPLETED')::int completed
      from documents d where ${where} group by 1 order by 1`);
    // Paper not printed: each completed document would have been printed once per person who signed or received it.
    const [paper] = await q<{ pages: number }>(sql`
      select coalesce(sum(coalesce(f.page_count, 1) * (select count(*) from recipients r where r.document_id = d.id)), 0)::int pages
      from documents d join document_files f on f.document_id = d.id and f.kind in ('CONVERTED','ORIGINAL') and f.mime_type = 'application/pdf'
      where ${where} and d.status = 'COMPLETED'`);
    return { range: r, totals, byDepartment, byType, byMonth, pagesNotPrinted: paper?.pages ?? 0 };
  }

  @Get('reports/documents.csv')
  async csv(@Query('from') from?: string, @Query('to') to?: string, @CurrentUser() user?: AuthUser, @Meta() meta?: RequestMeta) {
    const r = range(from, to);
    const rows = (
      await this.db.execute<Record<string, unknown>>(sql`
      select d.reference_no, d.title, t.name document_type, dep.name department, u.full_name sender, d.counterparty supplier,
        d.status, d.sent_at, d.completed_at,
        (select string_agg(r.full_name, '; ' order by r.step_order) from recipients r where r.document_id = d.id and r.role = 'SIGNER') signers
      from documents d join document_types t on t.id = d.document_type_id join departments dep on dep.id = d.department_id join users u on u.id = d.sender_id
      where d.status <> 'DRAFT' and d.sent_at >= ${r.from}::date and d.sent_at < (${r.to}::date + 1) order by d.sent_at`)
    ).rows;
    const cols = ['reference_no', 'title', 'document_type', 'department', 'sender', 'supplier', 'status', 'sent_at', 'completed_at', 'signers'];
    const cell = (v: unknown) => {
      let s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // no formula injection when opened in Excel
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((row) => cols.map((c) => cell(row[c])).join(','))].join('\r\n');
    await this.audit.record({ type: 'report.exported', meta, actor: user, details: { rows: rows.length, ...r } });
    return new StreamableFile(Buffer.from('﻿' + csv), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="esign-documents-${r.from}-to-${r.to}.csv"` });
  }

  /** Completed documents whose retention period (set per document type) has passed. Nothing is deleted automatically. */
  @Get('retention/due')
  async retentionDue() {
    return (
      await this.db.execute(sql`
      select d.id, d.title, d.reference_no, d.completed_at, t.name document_type, t.retention_years
      from documents d join document_types t on t.id = d.document_type_id
      where d.status = 'COMPLETED' and d.purged_at is null and t.retention_years is not null
        and d.completed_at < now() - make_interval(years => t.retention_years)
      order by d.completed_at`)
    ).rows;
  }

  /** Delete the stored files of a document past its retention period. The record, fingerprints and audit trail stay. */
  @Roles('ADMIN')
  @Post('retention/:id/purge')
  @HttpCode(200)
  async purge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().trim().min(5, 'Give the reason, e.g. the retention decision reference.').max(500) }))) body: { reason: string },
    @CurrentUser() user: AuthUser,
    @Meta() meta: RequestMeta,
  ) {
    const due = (await this.retentionDue()) as { id: string }[];
    if (!due.some((d) => d.id === id)) {
      const doc = await this.db.query.documents.findFirst({ where: eq(documents.id, id) });
      if (!doc) throw new NotFoundException('Document not found.');
      throw new BadRequestException('This document has not reached the end of its retention period.');
    }
    const files = await this.db.select().from(documentFiles).where(eq(documentFiles.documentId, id));
    const images = await this.db
      .select({ key: fieldValues.imageKey })
      .from(fieldValues)
      .innerJoin(recipients, eq(recipients.id, fieldValues.recipientId))
      .where(eq(recipients.documentId, id));
    await this.db.transaction(async (tx) => {
      await tx.update(documents).set({ purgedAt: new Date(), purgeReason: body.reason }).where(eq(documents.id, id));
      await this.audit.record({ type: 'document.files_purged', meta, actor: user, documentId: id, details: { reason: body.reason, files: files.map((f) => ({ kind: f.kind, sha256: f.sha256 })) } }, tx);
    });
    for (const f of files) await this.storage.remove(f.storageKey);
    for (const i of images) if (i.key) await this.storage.remove(i.key);
    return { purged: true, files: files.length };
  }
}
