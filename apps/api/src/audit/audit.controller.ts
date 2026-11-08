import { BadRequestException, Controller, DefaultValuePipe, Get, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { AuditService } from './audit.service';

@Controller('audit')
@Roles('ADMIN', 'AUDITOR')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('events')
  events(
    @Query('documentId', new ParseUUIDPipe({ optional: true })) documentId?: string,
    @Query('actorUserId', new ParseUUIDPipe({ optional: true })) actorUserId?: string,
    @Query('type') type?: string,
    @Query('before') before?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    if (before && !/^\d+$/.test(before)) throw new BadRequestException('before must be an event number');
    return this.audit.list({
      documentId,
      actorUserId,
      type: type?.slice(0, 60),
      beforeId: before ? Number(before) : undefined,
      limit: Math.min(Math.max(limit, 1), 200),
    });
  }

  /** Re-checks every link of the audit chain. */
  @Get('verify')
  verify() {
    return this.audit.verifyChain();
  }
}
