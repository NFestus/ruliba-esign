import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { mfaRequiredFor, passwordProblems, Role } from '@ruliba/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { CryptoService, randomToken, sha256Hex } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { AppConfig, CONFIG, smsAvailable } from '../config';
import { Database, DbOrTx, DbService } from '../db/db';
import { activationTokens, mfaFactors, mfaRecoveryCodes, mfaSmsCodes, refreshTokens, users } from '../db/schema';
import { EmailService } from '../email/email.service';
import { phoneHint, SmsService } from '../sms/sms.service';
import { consumeAccountToken, findAccountToken, issueAccountToken, kigaliTime } from './account-tokens';
import { isRecentPassword, PASSWORD_REUSED_MESSAGE, rememberPassword } from './password-history';
import { AccessClaims } from './auth.guard';
import { dummyVerify, hashPassword, verifyPassword } from './passwords';
import { newRecoveryCodes, newTotpSecret, otpauthUrl, totpStep } from './totp';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MFA_TOKEN_TTL = '5m';
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
const BAD_ACTIVATION_LINK = 'This activation link is not valid or has expired. Ask the IT office to send you a new one.';
const BAD_RESET_LINK = 'This password reset link is not valid or has expired. Ask for a new one from the sign-in page.';
const SMS_CODE_MINUTES = 10;
const SMS_CODE_ATTEMPTS = 5;
const SMS_CODES_PER_HOUR = 5;

type UserRow = typeof users.$inferSelect;
type UserWithRoles = UserRow & { roles: Role[] };
type MfaPurpose = 'mfa-verify' | 'mfa-setup';

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  departmentId: string | null;
  roles: Role[];
  mfaEnabled: boolean;
  mfaMethod: 'TOTP' | 'SMS' | null;
  /** Two-step sign-in is compulsory for this person (their role, or an administrator's choice). */
  mfaRequired: boolean;
  mustChangePassword: boolean;
}

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string; // set as an HttpOnly cookie by the controller, never returned in JSON
  user: PublicUser;
}

export type LoginResult =
  | { kind: 'session'; session: SessionResult }
  | { kind: 'mfa-required'; mfaToken: string; method: 'TOTP' | 'SMS'; phoneHint?: string }
  | { kind: 'mfa-setup-required'; mfaToken: string };

@Injectable()
export class AuthService {
  private readonly db: Database;

  constructor(
    dbs: DbService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.db = dbs.db;
  }

  // ───────────── Password sign-in ─────────────

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.findUser(eq(users.email, email));

    if (!user) {
      await dummyVerify(password); // same timing as a real check: does not reveal which emails exist
      await this.audit.record({ type: 'auth.login_failed', meta, actor: { email }, details: { reason: 'unknown_email' } });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await dummyVerify(password);
      await this.audit.record({ type: 'auth.login_failed', meta, actor: actor(user), details: { reason: 'locked' } });
      throw new UnauthorizedException(`${GENERIC_LOGIN_ERROR} After ${MAX_FAILED_LOGINS} failed tries the account is locked for ${LOCK_MINUTES} minutes.`);
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok || user.status !== 'ACTIVE') {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.db
        .update(users)
        .set({ failedLogins: lock ? 0 : failed, ...(lock ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}) })
        .where(eq(users.id, user.id));
      await this.audit.record({
        type: lock ? 'auth.account_locked' : 'auth.login_failed',
        meta,
        actor: actor(user),
        details: { reason: ok ? 'disabled' : 'bad_password', failedLogins: failed },
      });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    await this.db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
    const factor = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, user.id) });

    if (factor?.confirmedAt) {
      await this.audit.record({ type: 'auth.password_ok_mfa_pending', meta, actor: actor(user), details: { method: factor.method } });
      const mfaToken = await this.mfaToken(user.id, 'mfa-verify');
      if (factor.method === 'SMS') {
        // A code that is still valid (sent moments ago) keeps working; otherwise send one. Only the hourly limit applies here.
        if (!(await this.hasActiveSmsCode(user.id))) await this.sendSmsCode(user.id, factor.phone!, { perMinuteLimit: false });
        return { kind: 'mfa-required', mfaToken, method: 'SMS', phoneHint: phoneHint(factor.phone) };
      }
      return { kind: 'mfa-required', mfaToken, method: 'TOTP' };
    }
    if (mfaRequiredFor(user.roles) || user.mfaRequired) {
      await this.audit.record({ type: 'auth.password_ok_mfa_setup_pending', meta, actor: actor(user) });
      return { kind: 'mfa-setup-required', mfaToken: await this.mfaToken(user.id, 'mfa-setup') };
    }
    return { kind: 'session', session: await this.startSession(user, meta, 'password') };
  }

  // ───────────── MFA ─────────────

  async verifyMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<SessionResult> {
    const userId = await this.readMfaToken(mfaToken, 'mfa-verify');
    const user = await this.loadActiveUser(userId);
    const factor = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, userId) });
    if (!factor?.confirmedAt) throw new UnauthorizedException('Two-step sign-in is not set up.');

    if (/^\d{6}$/.test(code) && factor.method === 'SMS') {
      if (!(await this.checkSmsCode(userId, code))) {
        await this.audit.record({ type: 'auth.mfa_failed', meta, actor: actor(user), details: { method: 'SMS' } });
        throw new UnauthorizedException('That code is not right. Check the newest text message, or send a new code.');
      }
      return this.startSession(user, meta, 'password+sms');
    }
    if (/^\d{6}$/.test(code)) {
      const step = totpStep(code, this.crypto.decryptSecret(factor.secretEnc!, `mfa:${userId}`));
      if (step === null || (factor.lastUsedStep !== null && step <= factor.lastUsedStep)) {
        await this.audit.record({ type: 'auth.mfa_failed', meta, actor: actor(user) });
        throw new UnauthorizedException('That code is not right. Check the time on your phone and try the newest code.');
      }
      await this.db.update(mfaFactors).set({ lastUsedStep: step }).where(eq(mfaFactors.id, factor.id));
      return this.startSession(user, meta, 'password+totp');
    }

    // Recovery code: one use each. The conditional update is atomic, so a code cannot be used twice.
    const used = await this.db
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.codeHash, sha256Hex(code.trim().toUpperCase())), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    if (used.length !== 1) {
      await this.audit.record({ type: 'auth.mfa_failed', meta, actor: actor(user), details: { recoveryCode: true } });
      throw new UnauthorizedException('That recovery code is not right or was already used.');
    }
    const left = await this.db.$count(mfaRecoveryCodes, and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    await this.audit.record({ type: 'auth.mfa_recovery_code_used', meta, actor: actor(user), details: { remaining: left } });
    return this.startSession(user, meta, 'password+recovery-code');
  }

  /** Which ways of two-step sign-in this installation offers. */
  mfaOptions() {
    return { app: true, sms: smsAvailable(this.config) };
  }

  /** A new SMS code during sign-in (the first text did not arrive). */
  async resendSmsCode(mfaToken: string) {
    const userId = await this.readMfaToken(mfaToken, 'mfa-verify');
    const factor = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, userId) });
    if (!factor?.confirmedAt || factor.method !== 'SMS' || !factor.phone) throw new BadRequestException('This account does not use text-message codes.');
    await this.sendSmsCode(userId, factor.phone);
    return { phoneHint: phoneHint(factor.phone) };
  }

  /** Enrolment by text message: remember the number (not yet confirmed) and send it a code. */
  async beginSmsSetup(userId: string, phone: string) {
    await this.loadActiveUser(userId);
    if (!smsAvailable(this.config)) throw new BadRequestException('Text-message codes are not set up on this system. Use an authenticator app.');
    const existing = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, userId) });
    if (existing?.confirmedAt) throw new ConflictException('Two-step sign-in is already set up. Ask an administrator to reset it.');
    await this.db
      .insert(mfaFactors)
      .values({ userId, method: 'SMS', phone, secretEnc: null })
      .onConflictDoUpdate({ target: mfaFactors.userId, set: { method: 'SMS', phone, secretEnc: null, lastUsedStep: null } });
    await this.sendSmsCode(userId, phone);
    return { phoneHint: phoneHint(phone) };
  }

  /** Start (or restart) enrolment with an authenticator app. Allowed with an access token, or with the set-up token from sign-in. */
  async beginMfaSetup(userId: string) {
    const user = await this.loadActiveUser(userId);
    const existing = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, userId) });
    if (existing?.confirmedAt) throw new ConflictException('Two-step sign-in is already set up. Ask an administrator to reset it.');
    const secret = newTotpSecret();
    const secretEnc = this.crypto.encryptSecret(secret, `mfa:${userId}`);
    await this.db
      .insert(mfaFactors)
      .values({ userId, method: 'TOTP', secretEnc })
      .onConflictDoUpdate({ target: mfaFactors.userId, set: { method: 'TOTP', secretEnc, phone: null, lastUsedStep: null } });
    const url = otpauthUrl(user.email, secret);
    return { otpauthUrl: url, secret, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  }

  async confirmMfaSetup(userId: string, code: string, meta: RequestMeta) {
    const user = await this.loadActiveUser(userId);
    const factor = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, userId) });
    if (!factor) throw new UnauthorizedException('Start the set-up again.');
    if (factor.confirmedAt) throw new ConflictException('Two-step sign-in is already set up.');
    let step: number | null = null;
    if (factor.method === 'SMS') {
      if (!(await this.checkSmsCode(userId, code))) throw new UnauthorizedException('That code is not right. Check the newest text message, or send a new code.');
    } else {
      step = totpStep(code, this.crypto.decryptSecret(factor.secretEnc!, `mfa:${userId}`));
      if (step === null) throw new UnauthorizedException('That code is not right. Try the newest code in your app.');
    }

    const codes = newRecoveryCodes();
    await this.db.transaction(async (tx) => {
      await tx.update(mfaFactors).set({ confirmedAt: new Date(), lastUsedStep: step }).where(eq(mfaFactors.id, factor.id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: sha256Hex(c) })));
      await this.audit.record({ type: 'auth.mfa_enrolled', meta, actor: actor(user), details: { method: factor.method } }, tx);
    });
    return { recoveryCodes: codes };
  }

  /** From the sign-in set-up flow: confirm, then open a session. */
  async confirmMfaFromLogin(mfaToken: string, code: string, meta: RequestMeta) {
    const userId = await this.readMfaToken(mfaToken, 'mfa-setup');
    const { recoveryCodes } = await this.confirmMfaSetup(userId, code, meta);
    const user = await this.loadActiveUser(userId);
    return { recoveryCodes, session: await this.startSession(user, meta, 'password+totp-enrolment') };
  }

  // ───────────── SMS codes ─────────────

  private async hasActiveSmsCode(userId: string) {
    const [row] = await this.db
      .select({ id: mfaSmsCodes.id })
      .from(mfaSmsCodes)
      .where(and(eq(mfaSmsCodes.userId, userId), isNull(mfaSmsCodes.consumedAt), gt(mfaSmsCodes.expiresAt, new Date()), gt(mfaSmsCodes.attemptsLeft, 0)))
      .limit(1);
    return !!row;
  }

  /** Only the newest code works. At most five an hour per person, and (for "send a new code") one a minute. */
  private async sendSmsCode(userId: string, phone: string, { perMinuteLimit = true } = {}) {
    const recent = await this.db
      .select({ createdAt: mfaSmsCodes.createdAt })
      .from(mfaSmsCodes)
      .where(and(eq(mfaSmsCodes.userId, userId), gt(mfaSmsCodes.createdAt, new Date(Date.now() - 3_600_000))))
      .orderBy(desc(mfaSmsCodes.createdAt));
    if (perMinuteLimit && recent[0] && recent[0].createdAt > new Date(Date.now() - 60_000)) {
      throw new HttpException('A code was sent less than a minute ago. Wait a moment for the text message.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (recent.length >= SMS_CODES_PER_HOUR) throw new HttpException('Too many codes were sent. Try again in an hour, or use a recovery code.', HttpStatus.TOO_MANY_REQUESTS);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.transaction(async (tx) => {
      await tx.update(mfaSmsCodes).set({ consumedAt: new Date() }).where(and(eq(mfaSmsCodes.userId, userId), isNull(mfaSmsCodes.consumedAt)));
      await tx.insert(mfaSmsCodes).values({
        userId,
        codeHash: sha256Hex(`${userId}:${code}`),
        expiresAt: new Date(Date.now() + SMS_CODE_MINUTES * 60_000),
        attemptsLeft: SMS_CODE_ATTEMPTS,
      });
    });
    await this.sms.send({ to: phone, text: `${code} is your Ruliba Clays eSign sign-in code. It works for ${SMS_CODE_MINUTES} minutes. Never share it.` });
  }

  /** True if the code matches the newest unexpired one; a wrong code uses up one of its tries. */
  private async checkSmsCode(userId: string, code: string): Promise<boolean> {
    const [ch] = await this.db
      .select()
      .from(mfaSmsCodes)
      .where(and(eq(mfaSmsCodes.userId, userId), isNull(mfaSmsCodes.consumedAt), gt(mfaSmsCodes.expiresAt, new Date()), gt(mfaSmsCodes.attemptsLeft, 0)))
      .orderBy(desc(mfaSmsCodes.createdAt))
      .limit(1);
    if (!ch) return false;
    if (ch.codeHash !== sha256Hex(`${userId}:${code}`)) {
      await this.db.update(mfaSmsCodes).set({ attemptsLeft: sql`${mfaSmsCodes.attemptsLeft} - 1` }).where(eq(mfaSmsCodes.id, ch.id));
      return false;
    }
    const used = await this.db
      .update(mfaSmsCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(mfaSmsCodes.id, ch.id), isNull(mfaSmsCodes.consumedAt)))
      .returning({ id: mfaSmsCodes.id });
    return used.length === 1;
  }

  setupUserIdFromToken(mfaToken: string) {
    return this.readMfaToken(mfaToken, 'mfa-setup');
  }

  async userIdFromAccessToken(token: string): Promise<string> {
    try {
      const c = await this.jwt.verifyAsync<AccessClaims>(token, { secret: this.config.JWT_ACCESS_SECRET, algorithms: ['HS256'] });
      if (c.typ !== 'access') throw new Error('not an access token');
      return c.sub;
    } catch {
      throw new UnauthorizedException('Please sign in.');
    }
  }

  // ───────────── Sessions and refresh-token rotation ─────────────

  private async startSession(user: UserWithRoles, meta: RequestMeta, method: string): Promise<SessionResult> {
    const familyId = randomUUID();
    const refreshToken = randomToken(32);
    await this.db.transaction(async (tx) => {
      await tx.insert(refreshTokens).values({
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await this.audit.record({ type: 'auth.login', meta, actor: actor(user), details: { method } }, tx);
    });
    return this.buildSession(user, familyId, refreshToken);
  }

  /**
   * Swap a refresh token for a new pair. If an already-used token comes back, someone copied it:
   * every token of that sign-in is revoked and the event is logged.
   */
  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<SessionResult> {
    if (!rawToken) throw new UnauthorizedException('Please sign in.');
    const stored = await this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256Hex(rawToken)) });
    if (!stored) throw new UnauthorizedException('Please sign in.');

    if (stored.revokedAt) {
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, stored.familyId), isNull(refreshTokens.revokedAt)));
      await this.audit.record({
        type: 'auth.refresh_token_reuse',
        meta,
        actor: { id: stored.userId },
        details: { familyId: stored.familyId, action: 'all sessions of this sign-in revoked' },
      });
      throw new UnauthorizedException('Your session was ended for safety. Please sign in again.');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Your session has ended. Please sign in again.');

    const user = await this.findUser(eq(users.id, stored.userId));
    if (!user || user.status !== 'ACTIVE') {
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, stored.id));
      throw new UnauthorizedException('Your account is not active.');
    }

    const next = randomToken(32);
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(refreshTokens)
        .values({
          userId: user.id,
          familyId: stored.familyId,
          tokenHash: sha256Hex(next),
          expiresAt: stored.expiresAt, // the sign-in still ends when its first token would have
          ip: meta.ip,
          userAgent: meta.userAgent,
        })
        .returning({ id: refreshTokens.id });
      // Conditional update: if two refreshes race, only one wins.
      const res = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedById: created.id })
        .where(and(eq(refreshTokens.id, stored.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (res.length !== 1) throw new UnauthorizedException('Please sign in again.');
    });
    return this.buildSession(user, stored.familyId, next);
  }

  async logout(rawToken: string | undefined, meta: RequestMeta) {
    if (!rawToken) return;
    const stored = await this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256Hex(rawToken)) });
    if (!stored) return;
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, stored.familyId), isNull(refreshTokens.revokedAt)));
    await this.audit.record({ type: 'auth.logout', meta, actor: { id: stored.userId } });
  }

  static async revokeAllSessions(db: DbOrTx, userId: string) {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  // ───────────── Password change ─────────────

  async changePassword(userId: string, current: string, next: string, meta: RequestMeta) {
    const user = await this.loadActiveUser(userId);
    if (!(await verifyPassword(user.passwordHash, current))) {
      await this.audit.record({ type: 'auth.password_change_failed', meta, actor: actor(user) });
      throw new ForbiddenException('Your current password is not right.');
    }
    const problems = passwordProblems(next, user.email);
    if (problems.length) throw new ForbiddenException({ message: problems.join(' '), errors: problems.map((m) => ({ field: 'newPassword', message: m })) });
    if (await isRecentPassword(this.db, userId, next)) {
      throw new ForbiddenException({ message: PASSWORD_REUSED_MESSAGE, errors: [{ field: 'newPassword', message: PASSWORD_REUSED_MESSAGE }] });
    }

    const passwordHash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date() }).where(eq(users.id, userId));
      await rememberPassword(tx, userId, passwordHash);
      await AuthService.revokeAllSessions(tx, userId); // sign out every other device
      await this.audit.record({ type: 'auth.password_changed', meta, actor: actor(user) }, tx);
    });
    return this.startSession(await this.loadActiveUser(userId), meta, 'password-change');
  }

  // ───────────── Account activation (new users) ─────────────

  /** What the activation page shows before the person chooses a password. */
  async activationInfo(rawToken: string) {
    const { user } = await this.findActivation(rawToken);
    return { email: user.email, fullName: user.fullName };
  }

  /**
   * Set the first password from the emailed link and make the account ACTIVE. The person then signs in
   * normally (and sets up two-step sign-in there if their role needs it).
   */
  async activate(rawToken: string, newPassword: string, meta: RequestMeta) {
    const { token, user } = await this.findActivation(rawToken);
    const problems = passwordProblems(newPassword, user.email);
    if (problems.length) throw new BadRequestException({ message: problems.join(' '), errors: problems.map((m) => ({ field: 'newPassword', message: m })) });

    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      // Conditional updates: a link works once, even if submitted twice at the same moment.
      if (!(await consumeAccountToken(tx, token.id))) throw new BadRequestException(BAD_ACTIVATION_LINK);
      const now = new Date();
      const activated = await tx
        .update(users)
        .set({ passwordHash, status: 'ACTIVE', activatedAt: now, passwordChangedAt: now, mustChangePassword: false, failedLogins: 0, lockedUntil: null })
        .where(and(eq(users.id, user.id), eq(users.status, 'PENDING')))
        .returning({ id: users.id });
      if (activated.length !== 1) throw new BadRequestException(BAD_ACTIVATION_LINK);
      await rememberPassword(tx, user.id, passwordHash);
      await this.audit.record({ type: 'user.activated', meta, actor: actor(user) }, tx);
    });
    return { email: user.email };
  }

  private async findActivation(rawToken: string) {
    const token = await findAccountToken(this.db, rawToken, 'ACTIVATION');
    const user = token && (await this.findUser(eq(users.id, token.userId)));
    if (!token || !user || user.status !== 'PENDING') throw new BadRequestException(BAD_ACTIVATION_LINK);
    return { token, user };
  }

  /** The activation email (new user, resend, or "forgot password" before activating). */
  emailActivationLink(to: string, name: string, userId: string, token: string, expiresAt: Date) {
    return this.email.enqueue({
      to,
      userId,
      template: 'account-activation',
      subject: 'Activate your Ruliba Clays eSign account',
      data: { name, link: `${this.config.APP_URL}/activate/${token}`, expires: kigaliTime(expiresAt) },
    });
  }

  // ───────────── Password reset ─────────────

  /**
   * "Forgot your password?". The answer is the same whether or not the email has an account, so the
   * form cannot be used to find out who works here. Someone who never activated gets a new activation link.
   */
  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.findUser(eq(users.email, email));
    if (!user || user.status === 'DISABLED') {
      await this.audit.record({ type: 'auth.password_reset_requested', meta, actor: { email }, details: { sent: false } });
      return;
    }
    const purpose = user.status === 'PENDING' ? 'ACTIVATION' : 'PASSWORD_RESET';
    const recent = await this.db.query.activationTokens.findFirst({
      where: and(eq(activationTokens.userId, user.id), eq(activationTokens.purpose, purpose), gt(activationTokens.createdAt, new Date(Date.now() - 60_000))),
    });
    if (recent) return; // one email of this kind a minute is enough
    if (user.status === 'PENDING') {
      const { token, expiresAt } = await issueAccountToken(this.db, user.id, 'ACTIVATION', this.config.ACTIVATION_TOKEN_TTL_HOURS * 3_600_000);
      await this.emailActivationLink(user.email, user.fullName, user.id, token, expiresAt);
    } else {
      await this.sendPasswordReset(user.id, false);
    }
    await this.audit.record({ type: 'auth.password_reset_requested', meta, actor: actor(user), details: { sent: true, activation: user.status === 'PENDING' } });
  }

  /** Issues a reset link and emails it. Earlier reset links stop working. */
  async sendPasswordReset(userId: string, byAdmin: boolean) {
    const user = await this.loadActiveUser(userId);
    const { token, expiresAt } = await issueAccountToken(this.db, userId, 'PASSWORD_RESET', this.config.PASSWORD_RESET_TTL_MINUTES * 60_000);
    await this.email.enqueue({
      to: user.email,
      userId,
      template: 'password-reset',
      subject: 'Reset your Ruliba Clays eSign password',
      data: { name: user.fullName, link: `${this.config.APP_URL}/reset-password/${token}`, expires: kigaliTime(expiresAt), byAdmin: byAdmin ? '1' : '' },
    });
    return { expiresAt };
  }

  async passwordResetInfo(rawToken: string) {
    const { user } = await this.findReset(rawToken);
    return { email: user.email, fullName: user.fullName };
  }

  /** New password from the emailed link. Every session ends; two-step sign-in still applies at the next sign-in. */
  async resetPassword(rawToken: string, newPassword: string, meta: RequestMeta) {
    const { token, user } = await this.findReset(rawToken);
    const problems = passwordProblems(newPassword, user.email);
    if (problems.length) throw new BadRequestException({ message: problems.join(' '), errors: problems.map((m) => ({ field: 'newPassword', message: m })) });
    if (await isRecentPassword(this.db, user.id, newPassword)) {
      throw new BadRequestException({ message: PASSWORD_REUSED_MESSAGE, errors: [{ field: 'newPassword', message: PASSWORD_REUSED_MESSAGE }] });
    }

    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      if (!(await consumeAccountToken(tx, token.id))) throw new BadRequestException(BAD_RESET_LINK);
      await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      await rememberPassword(tx, user.id, passwordHash);
      await AuthService.revokeAllSessions(tx, user.id);
      await this.audit.record({ type: 'auth.password_reset', meta, actor: actor(user) }, tx);
    });
    return { email: user.email };
  }

  private async findReset(rawToken: string) {
    const token = await findAccountToken(this.db, rawToken, 'PASSWORD_RESET');
    const user = token && (await this.findUser(eq(users.id, token.userId)));
    if (!token || !user || user.status !== 'ACTIVE') throw new BadRequestException(BAD_RESET_LINK);
    return { token, user };
  }

  // ───────────── Helpers ─────────────

  async me(userId: string): Promise<PublicUser> {
    return this.publicUser(await this.loadActiveUser(userId));
  }

  private async findUser(where: ReturnType<typeof eq>): Promise<UserWithRoles | undefined> {
    const row = await this.db.query.users.findFirst({ where, with: { roles: true } });
    return row ? { ...row, roles: row.roles.map((r) => r.role) } : undefined;
  }

  private async loadActiveUser(id: string): Promise<UserWithRoles> {
    const user = await this.findUser(eq(users.id, id));
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Your account is not active.');
    return user;
  }

  private async buildSession(user: UserWithRoles, familyId: string, refreshToken: string): Promise<SessionResult> {
    const claims: AccessClaims = {
      sub: user.id,
      email: user.email,
      name: user.fullName,
      roles: user.roles,
      dept: user.departmentId,
      sid: familyId,
      pwc: user.mustChangePassword,
      typ: 'access',
    };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.JWT_ACCESS_SECRET,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      algorithm: 'HS256',
    });
    return { accessToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS, refreshToken, user: await this.publicUser(user) };
  }

  private async publicUser(user: UserWithRoles): Promise<PublicUser> {
    const mfa = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, user.id), columns: { confirmedAt: true, method: true } });
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      jobTitle: user.jobTitle,
      departmentId: user.departmentId,
      roles: user.roles,
      mfaEnabled: !!mfa?.confirmedAt,
      mfaMethod: mfa?.confirmedAt ? mfa.method : null,
      mfaRequired: mfaRequiredFor(user.roles) || user.mfaRequired,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private mfaToken(userId: string, purpose: MfaPurpose) {
    return this.jwt.signAsync({ sub: userId, typ: purpose }, { secret: this.config.JWT_MFA_SECRET, expiresIn: MFA_TOKEN_TTL, algorithm: 'HS256' });
  }

  private async readMfaToken(token: string, purpose: MfaPurpose): Promise<string> {
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; typ: string }>(token, { secret: this.config.JWT_MFA_SECRET, algorithms: ['HS256'] });
      if (claims.typ !== purpose) throw new Error('wrong purpose');
      return claims.sub;
    } catch {
      throw new UnauthorizedException('This step timed out. Please sign in again.');
    }
  }
}

function actor(user: UserRow) {
  return { id: user.id, email: user.email, name: user.fullName };
}

