import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CreateSignerInput, CreateUserInput, mfaRequiredFor, Role, updateUserSchema } from '@ruliba/shared';
import { and, asc, eq, exists, ilike, inArray, ne, or, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../auth/decorators';
import { issueAccountToken } from '../auth/account-tokens';
import { hashPassword } from '../auth/passwords';
import { randomToken } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { AppConfig, CONFIG } from '../config';
import { Database, DbOrTx, DbService } from '../db/db';
import { departments, mfaFactors, mfaRecoveryCodes, mfaSmsCodes, userRoles, users } from '../db/schema';
import { EmailService } from '../email/email.service';

function search(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q.replace(/[%_\\]/g, '')}%`;
  return or(ilike(users.email, pattern), ilike(users.fullName, pattern));
}

@Injectable()
export class UsersService {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.db = dbs.db;
  }

  async list(q?: string) {
    const rows = await this.db.query.users.findMany({
      where: search(q),
      columns: { passwordHash: false, failedLogins: false },
      with: { roles: true, department: { columns: { id: true, code: true, name: true } }, mfa: { columns: { confirmedAt: true, method: true } } },
      orderBy: asc(users.fullName),
    });
    return rows.map(({ roles, mfa, ...u }) => {
      const r = roles.map((x) => x.role);
      return {
        ...u,
        roles: r,
        mfaEnabled: !!mfa?.confirmedAt,
        mfaMethod: mfa?.confirmedAt ? mfa.method : null,
        mfaRoleRequired: mfaRequiredFor(r), // Administrators and Auditors always need it
      };
    });
  }

  async get(id: string) {
    const rows = await this.list();
    const u = rows.find((r) => r.id === id);
    if (!u) throw new NotFoundException('User not found.');
    return u;
  }

  /**
   * Short list any signed-in user may see, for picking internal signers and approvers.
   * With `signers`, only people with the Signer role, including those still waiting to activate.
   */
  async directory(q?: string, signers = false) {
    if (signers) {
      const rows = await this.db.query.users.findMany({
        where: and(
          inArray(users.status, ['ACTIVE', 'PENDING']),
          exists(this.db.select().from(userRoles).where(and(eq(userRoles.userId, users.id), eq(userRoles.role, 'SIGNER')))),
          search(q),
        ),
        columns: { id: true, fullName: true, email: true, jobTitle: true, status: true },
        with: { department: { columns: { code: true, name: true } } },
        orderBy: asc(users.fullName),
        limit: 50,
      });
      return rows.map(({ status, ...u }) => ({ ...u, pending: status === 'PENDING' }));
    }
    const where = and(eq(users.status, 'ACTIVE'), search(q));
    return this.db.query.users.findMany({
      where,
      columns: { id: true, fullName: true, email: true, jobTitle: true },
      with: { department: { columns: { code: true, name: true } } },
      orderBy: asc(users.fullName),
      limit: 50,
    });
  }

  /**
   * The account starts PENDING with a random password nobody knows. The person receives a one-use
   * activation link by email, chooses their own password there, and only then can sign in.
   */
  async create(input: CreateUserInput, by: AuthUser, meta: RequestMeta) {
    const exists = await this.db.query.users.findFirst({ where: eq(users.email, input.email), columns: { id: true } });
    if (exists) throw new ConflictException('A user with this email already exists.');
    await this.assertDepartment(input.departmentId);

    const passwordHash = await hashPassword(randomToken(32)); // unusable until activation
    const { id, token, expiresAt } = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          fullName: input.fullName,
          jobTitle: input.jobTitle ?? null,
          departmentId: input.departmentId ?? null,
          passwordHash,
          status: 'PENDING',
          mustChangePassword: false, // they choose their own password when activating
          mfaRequired: input.mfaRequired ?? false,
        })
        .returning({ id: users.id });
      await tx.insert(userRoles).values([...new Set(input.roles)].map((role) => ({ userId: u.id, role })));
      const link = await this.issueActivationToken(tx, u.id);
      await this.audit.record(
        {
          type: 'user.created',
          meta,
          actor: by,
          details: { userId: u.id, email: input.email, roles: input.roles, departmentId: input.departmentId ?? null, mfaRequired: input.mfaRequired ?? false },
        },
        tx,
      );
      return { id: u.id, ...link };
    });

    await this.sendActivationEmail(input.email, input.fullName, id, token, expiresAt);
    return { user: await this.get(id), activationExpiresAt: expiresAt };
  }

  /**
   * A sender adds a colleague who has no account yet, to sign a document. The account gets the Signer role
   * only and waits for activation like any new account. If the person already has a Signer account, it is returned.
   */
  async createSigner(input: CreateSignerInput, by: AuthUser, meta: RequestMeta) {
    const domains = this.config.INTERNAL_EMAIL_DOMAINS;
    const isAdmin = by.roles.includes('ADMIN');
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, input.email), with: { roles: true } });
    if (existing) {
      if (existing.status === 'DISABLED') throw new ConflictException('This person has a disabled account. Ask an administrator to enable it.');
      if (!existing.roles.some((r) => r.role === 'SIGNER')) {
        throw new ConflictException('This person already has an account without the Signer role. Ask an administrator to add it, or add them as an external signer.');
      }
      return { id: existing.id, fullName: existing.fullName, email: existing.email, pending: existing.status === 'PENDING', existing: true };
    }
    if (!isAdmin && domains.length && !domains.includes(input.email.split('@')[1])) {
      throw new BadRequestException({
        message: `Ruliba staff use ${domains.map((d) => '@' + d).join(' or ')} addresses. For anyone else, add them as an external signer.`,
        errors: [{ field: 'email', message: `Use a ${domains.map((d) => '@' + d).join(' or ')} address.` }],
      });
    }
    const { user } = await this.create({ email: input.email, fullName: input.fullName, roles: ['SIGNER'] }, by, meta);
    return { id: user.id, fullName: user.fullName, email: user.email, pending: true, existing: false };
  }

  /** New link for a user who has not activated yet (lost or expired email). Earlier links stop working. */
  async resendActivation(id: string, by: AuthUser, meta: RequestMeta) {
    const u = await this.get(id);
    if (u.status !== 'PENDING') throw new BadRequestException('This account is already activated or disabled.');
    const { token, expiresAt } = await this.db.transaction(async (tx) => {
      const link = await this.issueActivationToken(tx, id);
      await this.audit.record({ type: 'user.activation_resent', meta, actor: by, details: { userId: id } }, tx);
      return link;
    });
    await this.sendActivationEmail(u.email, u.fullName, id, token, expiresAt);
    return { activationExpiresAt: expiresAt };
  }

  private issueActivationToken(tx: DbOrTx, userId: string) {
    return issueAccountToken(tx, userId, 'ACTIVATION', this.config.ACTIVATION_TOKEN_TTL_HOURS * 3_600_000);
  }

  private sendActivationEmail(to: string, name: string, userId: string, token: string, expiresAt: Date) {
    return this.auth.emailActivationLink(to, name, userId, token, expiresAt);
  }


  async update(id: string, input: z.infer<typeof updateUserSchema>, by: AuthUser, meta: RequestMeta) {
    const before = await this.get(id);
    await this.assertDepartment(input.departmentId);

    if (id === by.id && ((input.roles && !input.roles.includes('ADMIN')) || input.status === 'DISABLED')) {
      throw new BadRequestException('You cannot remove your own administrator access. Ask another administrator.');
    }
    if (input.status === 'ACTIVE' && before.status === 'PENDING') {
      throw new BadRequestException('This person activates the account themselves from the emailed link. Send a new link if needed.');
    }
    // Re-enabling someone who never activated puts them back to waiting for activation, not ACTIVE with an unknown password.
    const status = input.status === 'ACTIVE' && !before.activatedAt ? 'PENDING' : input.status;
    const losesAdmin = before.roles.includes('ADMIN') && ((input.roles && !input.roles.includes('ADMIN')) || input.status === 'DISABLED');
    if (losesAdmin) await this.assertAnotherActiveAdmin(id);

    await this.db.transaction(async (tx) => {
      if (input.roles) {
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values([...new Set(input.roles)].map((role) => ({ userId: id, role: role as Role })));
      }
      const set = Object.fromEntries(
        Object.entries({ fullName: input.fullName, jobTitle: input.jobTitle, departmentId: input.departmentId, status, mfaRequired: input.mfaRequired }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      if (Object.keys(set).length) await tx.update(users).set(set).where(eq(users.id, id));
      // Ends existing sessions so a role change or disabling applies now, not at token expiry.
      // Newly required two-step sign-in also ends sessions, so they set it up at their next sign-in.
      const mustEnrolNow = input.mfaRequired === true && !before.mfaRequired && !before.mfaEnabled;
      if (input.status === 'DISABLED' || input.roles || mustEnrolNow) await AuthService.revokeAllSessions(tx, id);
      await this.audit.record(
        {
          type: 'user.updated',
          meta,
          actor: by,
          details: {
            userId: id,
            changes: input,
            before: { roles: before.roles, status: before.status, departmentId: before.departmentId, fullName: before.fullName, mfaRequired: before.mfaRequired },
          },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Administrator reset: the current password stops working at once, every session ends, and the person
   * gets an emailed link to choose a new password. No password passes through the administrator.
   */
  async resetPassword(id: string, by: AuthUser, meta: RequestMeta) {
    const u = await this.get(id);
    if (u.status === 'PENDING') throw new BadRequestException('This account is not activated yet. Send a new activation link instead.');
    if (u.status === 'DISABLED') throw new BadRequestException('This account is disabled. Enable it first.');
    const passwordHash = await hashPassword(randomToken(32));
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null }).where(eq(users.id, id));
      await AuthService.revokeAllSessions(tx, id);
      await this.audit.record({ type: 'user.password_reset', meta, actor: by, details: { userId: id, via: 'emailed link' } }, tx);
    });
    const { expiresAt } = await this.auth.sendPasswordReset(id, true);
    return { email: u.email, resetExpiresAt: expiresAt };
  }

  async resetMfa(id: string, by: AuthUser, meta: RequestMeta) {
    await this.get(id);
    await this.db.transaction(async (tx) => {
      await tx.delete(mfaFactors).where(eq(mfaFactors.userId, id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
      await tx.delete(mfaSmsCodes).where(eq(mfaSmsCodes.userId, id));
      await AuthService.revokeAllSessions(tx, id);
      await this.audit.record({ type: 'user.mfa_reset', meta, actor: by, details: { userId: id } }, tx);
    });
    return { ok: true };
  }

  private async assertDepartment(id: string | null | undefined) {
    if (!id) return;
    const d = await this.db.query.departments.findFirst({ where: eq(departments.id, id) });
    if (!d || !d.active) throw new BadRequestException('Choose an active department.');
  }

  private async assertAnotherActiveAdmin(exceptId: string) {
    const others = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'ADMIN')))
      .where(and(ne(users.id, exceptId), eq(users.status, 'ACTIVE')))
      .limit(1);
    if (others.length === 0) throw new BadRequestException('At least one active administrator must remain.');
  }
}
