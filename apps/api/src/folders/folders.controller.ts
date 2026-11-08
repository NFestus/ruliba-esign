import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { fileDocumentSchema, folderSchema } from '@ruliba/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { Database, DbService } from '../db/db';
import { folderDocuments, folders } from '../db/schema';
import { DocumentsService } from '../documents/documents.service';

const duplicate = (e: unknown) => {
  const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
  if (code === '23505') throw new ConflictException('You already have a folder with that name.');
  throw e;
};

/**
 * Personal folders. Each person files the documents they can see into their own folders.
 * A folder never changes who can see a document, and nobody else sees your folders.
 */
@Controller()
export class FoldersController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly docs: DocumentsService,
  ) {
    this.db = dbs.db;
  }

  @Get('folders')
  async list(@CurrentUser() user: AuthUser) {
    return this.db
      .select({
        id: folders.id,
        name: folders.name,
        documentCount: sql<number>`(select count(*)::int from ${folderDocuments} fd where fd.folder_id = ${folders.id})`,
      })
      .from(folders)
      .where(eq(folders.ownerId, user.id))
      .orderBy(asc(sql`lower(${folders.name})`));
  }

  private async mine(user: AuthUser, id: string) {
    const f = await this.db.query.folders.findFirst({ where: and(eq(folders.id, id), eq(folders.ownerId, user.id)) });
    if (!f) throw new NotFoundException('Folder not found.');
    return f;
  }

  @Post('folders')
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(folderSchema)) body: z.infer<typeof folderSchema>) {
    const [f] = await this.db.insert(folders).values({ ownerId: user.id, name: body.name }).returning({ id: folders.id, name: folders.name }).catch(duplicate);
    return f;
  }

  @Patch('folders/:id')
  async rename(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(folderSchema)) body: z.infer<typeof folderSchema>) {
    await this.mine(user, id);
    await this.db.update(folders).set({ name: body.name }).where(eq(folders.id, id)).catch(duplicate);
    return { id, name: body.name };
  }

  /** Deletes the folder only. Its documents are untouched and appear again under "All". */
  @Delete('folders/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.mine(user, id);
    await this.db.delete(folders).where(eq(folders.id, id));
  }

  /** Put a document in one of my folders, or take it out (folderId null). */
  @Put('documents/:id/folder')
  async file(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(fileDocumentSchema)) body: z.infer<typeof fileDocumentSchema>) {
    await this.docs.get(user, id); // 404 unless this person may see the document
    if (body.folderId === null) {
      await this.db.delete(folderDocuments).where(and(eq(folderDocuments.userId, user.id), eq(folderDocuments.documentId, id)));
      return { folderId: null };
    }
    await this.mine(user, body.folderId);
    await this.db
      .insert(folderDocuments)
      .values({ userId: user.id, documentId: id, folderId: body.folderId })
      .onConflictDoUpdate({ target: [folderDocuments.userId, folderDocuments.documentId], set: { folderId: body.folderId, filedAt: new Date() } });
    return { folderId: body.folderId };
  }
}

