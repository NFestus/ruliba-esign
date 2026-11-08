import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AllowPendingPassword, AuthUser, CurrentUser } from './auth/decorators';
import { Database, DbService } from './db/db';
import { notifications } from './db/schema';

/** The bell in the top bar: what happened to my documents, newest first. */
@Controller('notifications')
export class NotificationsController {
  private readonly db: Database;
  constructor(dbs: DbService) {
    this.db = dbs.db;
  }

  @AllowPendingPassword()
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const mine = and(eq(notifications.userId, user.id), eq(notifications.channel, 'IN_APP'));
    const [items, [{ unread }]] = await Promise.all([
      this.db
        .select({ id: notifications.id, subject: notifications.subject, link: notifications.link, createdAt: notifications.createdAt, readAt: notifications.readAt, documentId: notifications.documentId })
        .from(notifications)
        .where(mine)
        .orderBy(desc(notifications.createdAt))
        .limit(30),
      this.db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt))),
    ]);
    return { unread, items };
  }

  @Post('read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Body() body: { ids?: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((i) => /^[0-9a-f-]{36}$/.test(i)).slice(0, 100) : null;
    await this.db
      .update(notifications)
      .set({ readAt: new Date(), status: 'READ' })
      .where(and(eq(notifications.userId, user.id), eq(notifications.channel, 'IN_APP'), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
    return { ok: true };
  }
}
