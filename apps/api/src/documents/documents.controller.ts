import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  approveSchema,
  createDocumentSchema,
  declineSchema,
  fieldsSchema,
  recipientsSchema,
  RecipientsInput,
  savedSignatureSchema,
  sendDocumentSchema,
  updateDocumentSchema,
  UpdateDocumentInput,
  voidSchema,
} from '@ruliba/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { loadConfig } from '../config';
import { Database, DbService } from '../db/db';
import { savedSignatures } from '../db/schema';
import { StorageService } from '../files/storage.service';
import { SigningService } from '../signing/signing.service';
import { DocumentsService, LIST_FILTERS, ListFilter, UploadedFile as Upload } from './documents.service';
import { ApprovalsService } from './approvals.service';

const MAX_UPLOAD = loadConfig().MAX_UPLOAD_MB * 1024 * 1024;

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly signing: SigningService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('filter') filter = 'all',
    @Query('q') q?: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('folderId') folderId?: string,
  ) {
    const f = (LIST_FILTERS as readonly string[]).includes(filter) ? (filter as ListFilter) : 'all';
    const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+02:00`) : undefined);
    const toDate = date(to);
    if (toDate) toDate.setDate(toDate.getDate() + 1); // "to" includes that whole day
    const dept = departmentId && /^[0-9a-f-]{36}$/.test(departmentId) ? departmentId : undefined;
    const folder = folderId === 'none' || (folderId && /^[0-9a-f-]{36}$/.test(folderId)) ? folderId : undefined;
    return this.docs.list(user, f, q?.slice(0, 100), { departmentId: dept, from: date(from), to: toDate, folderId: folder });
  }

  @Get('counts')
  counts(@CurrentUser() user: AuthUser) {
    return this.docs.counts(user);
  }

  @Roles('SENDER')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 10 } }))
  create(@CurrentUser() user: AuthUser, @UploadedFile() file: Upload | undefined, @Body() body: Record<string, string>, @Meta() meta: RequestMeta) {
    const input = new ZodPipe(createDocumentSchema).transform(body);
    return this.docs.create(user, file, input, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(user, id);
  }

  /** kind = prepared (the PDF people sign), original, converted, sealed (signed + sealed copy), certificate; 'signed' = whichever final copy exists */
  @Get(':id/files/:kind')
  async file(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Query('download') download: string | undefined,
    @Meta() meta: RequestMeta,
  ) {
    if (!['prepared', 'original', 'converted', 'signed', 'sealed', 'certificate'].includes(kind)) throw new BadRequestException('Unknown file.');
    const f = await this.docs.file(user, id, kind, meta);
    const name = encodeURIComponent(f.fileName);
    return new StreamableFile(f.data, { type: f.mimeType, disposition: `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}` });
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateDocumentSchema)) body: UpdateDocumentInput, @Meta() meta: RequestMeta) {
    return this.docs.update(user, id, body, meta);
  }

  @Put(':id/recipients')
  recipients(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(recipientsSchema)) body: RecipientsInput, @Meta() meta: RequestMeta) {
    return this.docs.setRecipients(user, id, body, meta);
  }

  @Put(':id/fields')
  fields(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(fieldsSchema)) body: z.infer<typeof fieldsSchema>, @Meta() meta: RequestMeta) {
    return this.docs.setFields(user, id, body.fields, meta);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendDocumentSchema)) body: z.infer<typeof sendDocumentSchema>, @Meta() meta: RequestMeta) {
    return this.docs.send(user, id, body, meta);
  }

  @Post(':id/void')
  @HttpCode(200)
  void(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidSchema)) body: z.infer<typeof voidSchema>, @Meta() meta: RequestMeta) {
    return this.docs.voidDocument(user, id, body.reason, meta);
  }

  @Post(':id/recipients/:recipientId/resend')
  @HttpCode(200)
  resend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('recipientId', ParseUUIDPipe) rid: string, @Meta() meta: RequestMeta) {
    return this.docs.resend(user, id, rid, meta);
  }

  @Get(':id/approval-preview')
  approvalPreview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.approvalPreview(user, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(approveSchema)) body: z.infer<typeof approveSchema>, @Meta() meta: RequestMeta) {
    await this.approvals.approve(user, id, body.comment ?? null, meta);
    return this.docs.get(user, id);
  }

  @Post(':id/return')
  @HttpCode(200)
  async returnForChanges(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(declineSchema)) body: z.infer<typeof declineSchema>, @Meta() meta: RequestMeta) {
    await this.approvals.reject(user, id, body.reason, meta);
    return { returned: true };
  }

  /** Staff sign from their dashboard; their two-step sign-in replaces the emailed code. */
  @Post(':id/sign-session')
  @HttpCode(200)
  signSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.signing.sessionForStaff(user, id, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.docs.deleteDraft(user, id, meta);
  }
}

@Controller('contacts')
export class ContactsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.docs.listContacts(q?.slice(0, 100));
  }
}

/** The signed-in person's own signature and initials, saved for reuse. */
@Controller('me/signatures')
export class MySignatureController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {
    this.db = dbs.db;
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.db.select().from(savedSignatures).where(eq(savedSignatures.userId, user.id));
    return Promise.all(
      rows.map(async (r) => ({ kind: r.kind, method: r.method, image: `data:image/png;base64,${(await this.storage.get(r.imageKey, r.wrappedKey)).toString('base64')}` })),
    );
  }

  @Put()
  async save(@CurrentUser() user: AuthUser, @Body(new ZodPipe(savedSignatureSchema)) body: z.infer<typeof savedSignatureSchema>, @Meta() meta: RequestMeta) {
    const png = Buffer.from(body.image.split(',')[1], 'base64');
    if (png.length > 1_000_000 || !png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw new BadRequestException('The image could not be read.');
    const old = await this.db.query.savedSignatures.findFirst({ where: and(eq(savedSignatures.userId, user.id), eq(savedSignatures.kind, body.kind)) });
    const key = this.storage.newKey(`signatures/${user.id}`);
    const { wrappedKey } = await this.storage.put(key, png);
    await this.db
      .insert(savedSignatures)
      .values({ userId: user.id, kind: body.kind, method: body.method, imageKey: key, wrappedKey })
      .onConflictDoUpdate({ target: [savedSignatures.userId, savedSignatures.kind], set: { method: body.method, imageKey: key, wrappedKey, createdAt: new Date() } });
    if (old) await this.storage.remove(old.imageKey);
    await this.audit.record({ type: 'user.signature_saved', meta, actor: user, details: { kind: body.kind, method: body.method } });
    return { ok: true };
  }

  @Delete(':kind')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('kind') kind: string, @Meta() meta: RequestMeta) {
    const k = kind === 'INITIALS' ? 'INITIALS' : 'SIGNATURE';
    const old = await this.db.query.savedSignatures.findFirst({ where: and(eq(savedSignatures.userId, user.id), eq(savedSignatures.kind, k)) });
    if (!old) return;
    await this.db.delete(savedSignatures).where(eq(savedSignatures.id, old.id));
    await this.storage.remove(old.imageKey);
    await this.audit.record({ type: 'user.signature_removed', meta, actor: user, details: { kind: k } });
  }
}
