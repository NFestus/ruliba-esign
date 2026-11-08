import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { stampSchema, stampUpdateSchema } from '@ruliba/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { sha256Hex } from '../common/crypto.service';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { Database, DbService } from '../db/db';
import { stamps, stampUsers, users } from '../db/schema';
import { StorageService } from '../files/storage.service';

/** A PNG that really decodes, of a sensible size. */
export async function readPng(dataUrl: string, maxBytes = 1_000_000): Promise<Buffer | null> {
  const png = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
  if (png.length > maxBytes || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  try {
    const img = await (await PDFDocument.create()).embedPng(png);
    return img.width > 0 && img.height > 0 && img.width <= 4000 && img.height <= 4000 ? png : null;
  } catch {
    return null;
  }
}

/**
 * Settings > Stamps. Ruliba's company stamps, and who may apply each one.
 * The image is stored encrypted; at signing, a copy goes with the document, so changing or
 * withdrawing a stamp later never changes documents already stamped.
 */
@Controller('stamps')
@Roles('ADMIN')
export class StampsController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {
    this.db = dbs.db;
  }

  @Get()
  async list() {
    const rows = await this.db.select().from(stamps).orderBy(asc(stamps.name));
    const allowed = rows.length
      ? await this.db
          .select({ stampId: stampUsers.stampId, id: users.id, fullName: users.fullName })
          .from(stampUsers)
          .innerJoin(users, eq(users.id, stampUsers.userId))
          .where(inArray(stampUsers.stampId, rows.map((r) => r.id)))
      : [];
    return Promise.all(
      rows.map(async ({ imageKey, wrappedKey, ...s }) => ({
        ...s,
        image: `data:image/png;base64,${(await this.storage.get(imageKey, wrappedKey)).toString('base64')}`,
        users: allowed.filter((a) => a.stampId === s.id).map(({ id, fullName }) => ({ id, fullName })),
      })),
    );
  }

  private async checkUsers(ids: string[]) {
    if (!ids.length) return;
    const found = await this.db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (found.length !== new Set(ids).size) throw new BadRequestException('One of the people chosen does not exist.');
  }

  @Post()
  async create(@Body(new ZodPipe(stampSchema)) body: z.infer<typeof stampSchema>, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    const png = await readPng(body.image);
    if (!png) throw new BadRequestException('The stamp picture could not be read. Use a clear PNG or JPG photo or scan.');
    await this.checkUsers(body.userIds);
    const key = this.storage.newKey('stamps');
    const { wrappedKey } = await this.storage.put(key, png);
    const sha = sha256Hex(png);
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.insert(stamps).values({ name: body.name, imageKey: key, wrappedKey, sha256: sha, createdById: by.id }).returning({ id: stamps.id });
        if (body.userIds.length) await tx.insert(stampUsers).values([...new Set(body.userIds)].map((userId) => ({ stampId: s.id, userId })));
        await this.audit.record({ type: 'stamp.created', meta, actor: by, details: { id: s.id, name: body.name, sha256: sha, userIds: body.userIds } }, tx);
        return { id: s.id };
      });
    } catch (e) {
      await this.storage.remove(key);
      throw e;
    }
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(stampUpdateSchema)) body: z.infer<typeof stampUpdateSchema>, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    const before = await this.db.query.stamps.findFirst({ where: eq(stamps.id, id) });
    if (!before) throw new NotFoundException('Stamp not found.');
    if (body.userIds) await this.checkUsers(body.userIds);
    await this.db.transaction(async (tx) => {
      if (body.name !== undefined || body.active !== undefined) await tx.update(stamps).set({ name: body.name, active: body.active }).where(eq(stamps.id, id));
      if (body.userIds) {
        await tx.delete(stampUsers).where(eq(stampUsers.stampId, id));
        if (body.userIds.length) await tx.insert(stampUsers).values([...new Set(body.userIds)].map((userId) => ({ stampId: id, userId })));
      }
      await this.audit.record({ type: 'stamp.changed', meta, actor: by, details: { id, before: { name: before.name, active: before.active }, after: body } }, tx);
    });
    return { ok: true };
  }
}
