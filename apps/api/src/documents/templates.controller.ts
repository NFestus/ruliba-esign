import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { TemplatesService } from './templates.service';

const saveSchema = z.object({
  documentId: z.string().uuid(),
  name: z.string().trim().min(2, 'Name the template.').max(160),
  description: z.string().trim().max(500).nullable().optional(),
  shared: z.boolean().default(false),
  roles: z.array(z.object({ recipientId: z.string().uuid(), roleName: z.string().trim().min(2).max(80) })).min(1).max(20),
});

const useSchema = z.object({
  title: z.string().trim().min(2).max(200),
  people: z
    .array(z.object({ roleId: z.string().uuid(), fullName: z.string().trim().min(2).max(160), email: z.string().trim().toLowerCase().email().max(254) }))
    .min(1)
    .max(20),
});

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.templates.list(user);
  }

  @Roles('SENDER')
  @Post()
  save(@CurrentUser() user: AuthUser, @Body(new ZodPipe(saveSchema)) body: z.infer<typeof saveSchema>, @Meta() meta: RequestMeta) {
    return this.templates.saveFromDocument(user, body, meta);
  }

  @Roles('SENDER')
  @Post(':id/use')
  @HttpCode(201)
  use(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(useSchema)) body: z.infer<typeof useSchema>, @Meta() meta: RequestMeta) {
    return this.templates.use(user, id, body, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.templates.remove(user, id, meta);
  }
}
