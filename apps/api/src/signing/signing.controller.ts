import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { completeSigningSchema, CompleteSigningInput, declineSchema, otpVerifySchema } from '@ruliba/shared';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { SigningService } from './signing.service';

const LINK_LIMIT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 20), ttl: 60_000 } };

/**
 * Public signing endpoints. No staff account: the link token identifies the recipient,
 * the emailed code proves they control that mailbox, and a 60-minute signing session follows.
 * Session routes are declared before /:token so "session" is never read as a token.
 */
@Public()
@Controller('sign')
export class SigningController {
  constructor(private readonly signing: SigningService) {}

  @Get('session')
  async view(@Headers('authorization') auth: string) {
    return this.signing.view(await this.signing.claims(auth));
  }

  @Get('session/file')
  async file(@Headers('authorization') auth: string) {
    const data = await this.signing.file(await this.signing.claims(auth));
    return new StreamableFile(data, { type: 'application/pdf', disposition: 'inline; filename="document.pdf"' });
  }

  @Get('session/saved-signature')
  async saved(@Headers('authorization') auth: string, @Query('kind') kind: string) {
    return this.signing.savedSignature(await this.signing.claims(auth), kind === 'INITIALS' ? 'INITIALS' : 'SIGNATURE');
  }

  @Get('session/stamps')
  async stamps(@Headers('authorization') auth: string) {
    return this.signing.stampsFor(await this.signing.claims(auth));
  }

  @Post('session/consent')
  @HttpCode(200)
  async consent(@Headers('authorization') auth: string, @Body() body: { version?: string }, @Meta() meta: RequestMeta) {
    return this.signing.consent(await this.signing.claims(auth), String(body?.version ?? ''), meta);
  }

  @Post('session/complete')
  @HttpCode(200)
  async complete(@Headers('authorization') auth: string, @Body(new ZodPipe(completeSigningSchema)) body: CompleteSigningInput, @Meta() meta: RequestMeta) {
    return this.signing.complete(await this.signing.claims(auth), body, meta);
  }

  @Post('session/decline')
  @HttpCode(200)
  async decline(@Headers('authorization') auth: string, @Body(new ZodPipe(declineSchema)) body: z.infer<typeof declineSchema>, @Meta() meta: RequestMeta) {
    return this.signing.decline(await this.signing.claims(auth), body.reason, meta);
  }

  @Throttle(LINK_LIMIT)
  @Get(':token')
  open(@Param('token') token: string, @Meta() meta: RequestMeta) {
    return this.signing.open(token, meta);
  }

  @Throttle(LINK_LIMIT)
  @Post(':token/code')
  @HttpCode(200)
  sendCode(@Param('token') token: string, @Meta() meta: RequestMeta) {
    return this.signing.sendCode(token, meta);
  }

  @Throttle(LINK_LIMIT)
  @Post(':token/verify')
  @HttpCode(200)
  verify(@Param('token') token: string, @Body(new ZodPipe(otpVerifySchema)) body: z.infer<typeof otpVerifySchema>, @Meta() meta: RequestMeta) {
    return this.signing.verifyCode(token, body.code, meta);
  }
}
