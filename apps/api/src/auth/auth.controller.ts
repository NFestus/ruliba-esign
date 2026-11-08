import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  activateAccountSchema,
  ActivateAccountInput,
  forgotPasswordSchema,
  loginSchema,
  mfaConfirmSchema,
  mfaSmsSetupSchema,
  mfaTokenSchema,
  mfaVerifySchema,
  newPasswordSchema,
  resetPasswordSchema,
  ResetPasswordInput,
} from '@ruliba/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { AppConfig, CONFIG } from '../config';
import { AuthService, SessionResult } from './auth.service';
import { AllowPendingPassword, AuthUser, CurrentUser, Public } from './decorators';

export const REFRESH_COOKIE = 'esign_rt';
const CSRF_HEADER = 'x-esign-csrf';
const AUTH_LIMIT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body.email, body.password, meta);
    if (result.kind === 'session') return this.sendSession(res, result.session);
    return result.kind === 'mfa-required'
      ? { mfaRequired: true, mfaToken: result.mfaToken, method: result.method, phoneHint: result.phoneHint }
      : { mfaSetupRequired: true, mfaToken: result.mfaToken };
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.sendSession(res, await this.auth.verifyMfa(body.mfaToken, body.code, meta));
  }

  /** Which ways of two-step sign-in are offered (authenticator app always; SMS when a provider is set up). */
  @Public()
  @Get('mfa/options')
  mfaOptions() {
    return this.auth.mfaOptions();
  }

  /** Enrolment by text message, during sign-in (mfaToken) or from the account page (access token). Sends a code. */
  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('mfa/sms/setup')
  @HttpCode(200)
  async setupSmsMfa(@Body(new ZodPipe(mfaSmsSetupSchema)) body: z.infer<typeof mfaSmsSetupSchema>, @Req() req: Request) {
    const userId = await this.userFromSetupTokenOrBearer(body.mfaToken, req);
    return this.auth.beginSmsSetup(userId, body.phone);
  }

  /** A new text-message code during sign-in. */
  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('mfa/sms/resend')
  @HttpCode(200)
  resendSms(@Body(new ZodPipe(mfaTokenSchema)) body: z.infer<typeof mfaTokenSchema>) {
    return this.auth.resendSmsCode(body.mfaToken);
  }

  /** Enrolment during sign-in (mfaToken in body) or later from "Your account and security" (access token). */
  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('mfa/setup')
  @HttpCode(200)
  async setupMfa(@Body() body: { mfaToken?: string }, @Req() req: Request) {
    const userId = await this.userFromSetupTokenOrBearer(body?.mfaToken, req);
    return this.auth.beginMfaSetup(userId);
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('mfa/confirm')
  @HttpCode(200)
  async confirmMfa(
    @Body(new ZodPipe(mfaConfirmSchema)) body: z.infer<typeof mfaConfirmSchema>,
    @Req() req: Request,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (body.mfaToken) {
      const { recoveryCodes, session } = await this.auth.confirmMfaFromLogin(body.mfaToken, body.code, meta);
      return { recoveryCodes, ...this.sendSession(res, session) };
    }
    const userId = await this.userFromSetupTokenOrBearer(undefined, req);
    return this.auth.confirmMfaSetup(userId, body.code, meta);
  }

  /** Checks an activation link and says whose account it is, before the person chooses a password. */
  @Public()
  @Throttle(AUTH_LIMIT)
  @Get('activation/:token')
  activationInfo(@Param('token') token: string) {
    return this.auth.activationInfo(token.slice(0, 200));
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('activate')
  @HttpCode(200)
  activate(@Body(new ZodPipe(activateAccountSchema)) body: ActivateAccountInput, @Meta() meta: RequestMeta) {
    return this.auth.activate(body.token, body.newPassword, meta);
  }

  /** "Forgot your password?". Always the same answer, so it does not reveal which emails have accounts. */
  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('password/forgot')
  @HttpCode(200)
  async forgotPassword(@Body(new ZodPipe(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>, @Meta() meta: RequestMeta) {
    await this.auth.forgotPassword(body.email, meta);
    return { ok: true };
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Get('password/reset/:token')
  passwordResetInfo(@Param('token') token: string) {
    return this.auth.passwordResetInfo(token.slice(0, 200));
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('password/reset')
  @HttpCode(200)
  resetPassword(@Body(new ZodPipe(resetPasswordSchema)) body: ResetPasswordInput, @Meta() meta: RequestMeta) {
    return this.auth.resetPassword(body.token, body.newPassword, meta);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    this.requireCsrfHeader(req);
    try {
      return this.sendSession(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta));
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    this.requireCsrfHeader(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], meta);
    this.clearCookie(res);
  }

  @AllowPendingPassword()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @AllowPendingPassword()
  @Throttle(AUTH_LIMIT)
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(newPasswordSchema)) body: z.infer<typeof newPasswordSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.sendSession(res, await this.auth.changePassword(user.id, body.currentPassword, body.newPassword, meta));
  }

  // ───────────── helpers ─────────────

  private sendSession(res: Response, s: SessionResult) {
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });
    return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user };
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  /** Cookie-authenticated endpoints need a custom header, which another site's form or link cannot send (CSRF defence). */
  private requireCsrfHeader(req: Request) {
    if (req.headers[CSRF_HEADER] !== '1') throw new BadRequestException('Missing request header.');
  }

  private async userFromSetupTokenOrBearer(mfaToken: string | undefined, req: Request): Promise<string> {
    if (mfaToken) return this.auth.setupUserIdFromToken(mfaToken);
    // Fall back to a normal signed-in session (enrolling voluntarily from the account page).
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Please sign in.');
    return this.auth.userIdFromAccessToken(header.slice(7));
  }
}
