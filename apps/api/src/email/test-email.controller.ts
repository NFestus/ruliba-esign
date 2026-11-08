import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { AppConfig, CONFIG } from '../config';
import { EmailService } from './email.service';

const schema = z.object({ to: z.string().trim().toLowerCase().email('Enter an email address.').max(254) });

/** Settings > Email: send a test to any mailbox (e.g. a Gmail and an Outlook address) to check it lands in the inbox. */
@Controller('settings/test-email')
@Roles('ADMIN')
export class TestEmailController {
  constructor(
    private readonly email: EmailService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async send(@Body(new ZodPipe(schema)) body: z.infer<typeof schema>, @CurrentUser() user: AuthUser, @Meta() meta: RequestMeta) {
    const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date());
    const transport = { smtp: `SMTP (${this.config.SMTP_HOST})`, graph: `Microsoft 365 (${this.config.GRAPH_SENDER})`, console: 'the development log (not really sent)' }[this.config.EMAIL_TRANSPORT];
    await this.email.enqueue({ to: body.to, template: 'test-email', subject: 'Test email from Ruliba Clays eSign', data: { by: user.name, when, transport } });
    await this.audit.record({ type: 'setup.test_email_sent', meta, actor: user, details: { to: body.to, transport: this.config.EMAIL_TRANSPORT } });
    return { queued: true, transport, from: this.config.EMAIL_TRANSPORT === 'graph' ? this.config.GRAPH_SENDER : this.config.EMAIL_FROM };
  }
}
