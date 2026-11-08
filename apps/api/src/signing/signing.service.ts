import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AUTO_FIELDS, CompleteSigningInput, CONSENT_TEXT, CONSENT_VERSION, formatSigningDate, MAX_SIGNATURE_BYTES } from '@ruliba/shared';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/decorators';
import { sha256Hex } from '../common/crypto.service';
import { RequestMeta } from '../common/request-meta';
import { AppConfig, CONFIG } from '../config';
import { Database, DbService } from '../db/db';
import { documents, fields, fieldValues, mfaFactors, otpChallenges, recipients, savedSignatures, stamps, stampUsers, users } from '../db/schema';
import { readPng } from '../stamps/stamps.controller';
import { FinalizerService } from '../documents/finalizer.service';
import { RoutingService } from '../documents/routing.service';
import { EmailService } from '../email/email.service';
import { StorageService } from '../files/storage.service';

const CODE_TTL_MIN = 10;
const CODE_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;
const CODES_PER_HOUR = 5;
const SESSION_MINUTES = 60;

/** Emailed codes are for people outside Ruliba; staff prove who they are by signing in. */
const STAFF_SIGN_IN = 'You have a Ruliba Clays eSign account: sign in to eSign to sign this document.';

export type LinkState = 'ready' | 'completed' | 'declined' | 'voided' | 'expired' | 'waiting' | 'activate' | 'invalid';

interface SignClaims {
  sub: string; // recipient id
  doc: string;
  via: 'email-code' | 'account';
  typ: 'sign';
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/**
 * The signing journey for one recipient:
 *   link (token in the email) → one-time code by email → signing session (60 min) →
 *   consent → fill fields → finish (or decline).
 * Staff who are signed in can skip the emailed code: their two-step sign-in already proves who they are.
 */
@Injectable()
export class SigningService {
  private readonly log = new Logger('Signing');
  private readonly db: Database;

  constructor(
    dbs: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly storage: StorageService,
    private readonly routing: RoutingService,
    private readonly finalizer: FinalizerService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.db = dbs.db;
  }

  // ───────────── The link ─────────────

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    return this.db.query.recipients.findFirst({
      where: eq(recipients.accessTokenHash, sha256Hex(token)),
      with: { document: { with: { sender: { columns: { fullName: true, email: true } } } }, user: { columns: { status: true } } },
    });
  }

  private state(r: Omit<NonNullable<Awaited<ReturnType<SigningService['byToken']>>>, 'user'> & { user?: { status: string } | null }): LinkState {
    const d = r.document;
    if (d.status === 'VOIDED') return 'voided';
    if (d.status === 'DECLINED') return 'declined';
    if (d.status === 'EXPIRED' || (d.expiresAt && d.expiresAt < new Date()) || (r.tokenExpiresAt && r.tokenExpiresAt < new Date())) return 'expired';
    if (r.status === 'COMPLETED' || d.status === 'COMPLETED') return 'completed';
    if (r.status === 'DECLINED') return 'declined';
    if (r.status === 'CANCELLED') return 'voided';
    if (r.status === 'WAITING') return 'waiting';
    // A Ruliba staff signer whose account is not activated yet signs only after activating it.
    if (r.user?.status === 'PENDING') return 'activate';
    return 'ready';
  }

  async open(token: string, meta: RequestMeta) {
    const r = await this.byToken(token);
    if (!r) return { state: 'invalid' as LinkState };
    const state = this.state(r);
    // Ruliba staff sign inside eSign with their own account (older invitations still carry a link token).
    const staffSignPath = r.userId ? `/documents/${r.documentId}/sign` : undefined;
    await this.audit.record({ type: 'recipient.link_opened', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName }, details: { state } });
    return {
      state,
      documentTitle: r.document.title,
      senderName: r.document.sender.fullName,
      recipientName: r.fullName,
      emailHint: maskEmail(r.email),
      expiresAt: r.document.expiresAt,
      staffSignPath,
    };
  }

  async sendCode(token: string, meta: RequestMeta) {
    const r = await this.byToken(token);
    if (!r || this.state(r) !== 'ready') throw new ForbiddenException('This link cannot be used to sign any more.');
    if (r.userId) throw new ForbiddenException(STAFF_SIGN_IN);
    const recent = await this.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.recipientId, r.id), gt(otpChallenges.createdAt, new Date(Date.now() - 3_600_000))))
      .orderBy(desc(otpChallenges.createdAt));
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < CODE_RESEND_SECONDS * 1000) {
      throw new HttpException('A code was sent less than a minute ago. Check your inbox and spam folder.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (recent.length >= CODES_PER_HOUR) throw new HttpException('Too many codes were asked for. Try again in an hour, or contact the sender.', HttpStatus.TOO_MANY_REQUESTS);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.transaction(async (tx) => {
      // Only the newest code works
      await tx.update(otpChallenges).set({ consumedAt: new Date() }).where(and(eq(otpChallenges.recipientId, r.id), isNull(otpChallenges.consumedAt)));
      await tx.insert(otpChallenges).values({
        recipientId: r.id,
        codeHash: sha256Hex(`${r.id}:${code}`),
        expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000),
        attemptsLeft: CODE_ATTEMPTS,
        ip: meta.ip,
      });
      await this.audit.record({ type: 'recipient.code_sent', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName } }, tx);
    });
    await this.email.enqueue({
      to: r.email,
      documentId: r.documentId,
      userId: r.userId ?? undefined,
      template: 'sign-code',
      subject: `${code} is your code for ${r.document.title}`,
      data: { name: r.fullName, title: r.document.title, code },
    });
    return { sentTo: maskEmail(r.email), validMinutes: CODE_TTL_MIN };
  }

  async verifyCode(token: string, code: string, meta: RequestMeta) {
    const r = await this.byToken(token);
    if (!r || this.state(r) !== 'ready') throw new ForbiddenException('This link cannot be used to sign any more.');
    if (r.userId) throw new ForbiddenException(STAFF_SIGN_IN);
    const [ch] = await this.db
      .select()
      .from(otpChallenges)
      .where(and(eq(otpChallenges.recipientId, r.id), isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, new Date()), gt(otpChallenges.attemptsLeft, 0)))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    if (!ch) throw new UnauthorizedException('This code has run out. Ask for a new one.');
    if (ch.codeHash !== sha256Hex(`${r.id}:${code}`)) {
      const [left] = await this.db
        .update(otpChallenges)
        .set({ attemptsLeft: sql`${otpChallenges.attemptsLeft} - 1` })
        .where(eq(otpChallenges.id, ch.id))
        .returning({ attemptsLeft: otpChallenges.attemptsLeft });
      await this.audit.record({ type: 'recipient.code_failed', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName }, details: { attemptsLeft: left.attemptsLeft } });
      throw new UnauthorizedException(left.attemptsLeft > 0 ? `That code is not right. ${left.attemptsLeft} tries left.` : 'Too many wrong codes. Ask for a new one.');
    }
    const used = await this.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(otpChallenges.id, ch.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    if (!used.length) throw new UnauthorizedException('This code was already used. Ask for a new one.');
    return this.startSession(r, 'email-code', meta);
  }

  /** Signed-in staff signing from their dashboard. */
  async sessionForStaff(user: AuthUser, documentId: string, meta: RequestMeta) {
    const r = await this.db.query.recipients.findFirst({
      where: and(eq(recipients.documentId, documentId), eq(recipients.role, 'SIGNER'), or(eq(recipients.userId, user.id), eq(recipients.email, user.email)), inArray(recipients.status, ['SENT', 'VIEWED'])),
      with: { document: { with: { sender: { columns: { fullName: true, email: true } } } } },
    });
    if (!r || this.state(r) !== 'ready') throw new ConflictException('There is nothing for you to sign on this document right now.');
    // Sign-in always asks for the two-step code once it is set up, so a confirmed factor means it was used.
    const factor = await this.db.query.mfaFactors.findFirst({ where: eq(mfaFactors.userId, user.id) });
    return this.startSession(r, 'account', meta, { twoStep: !!factor?.confirmedAt });
  }

  private async startSession(r: { id: string; documentId: string; email: string; fullName: string; viewedAt: Date | null }, via: SignClaims['via'], meta: RequestMeta, extra: Record<string, unknown> = {}) {
    await this.db.transaction(async (tx) => {
      await this.audit.record(
        { type: 'recipient.verified', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName }, details: { method: via, ...extra } },
        tx,
      );
      if (!r.viewedAt) {
        await tx.update(recipients).set({ status: 'VIEWED', viewedAt: new Date() }).where(and(eq(recipients.id, r.id), eq(recipients.status, 'SENT')));
        await this.audit.record({ type: 'document.viewed', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName } }, tx);
      }
    });
    const claims: SignClaims = { sub: r.id, doc: r.documentId, via, typ: 'sign' };
    const signToken = await this.jwt.signAsync(claims, { secret: this.config.JWT_SIGN_SECRET, expiresIn: SESSION_MINUTES * 60, algorithm: 'HS256' });
    return { signToken, expiresIn: SESSION_MINUTES * 60 };
  }

  // ───────────── Inside a signing session ─────────────

  async claims(bearer: string | undefined): Promise<SignClaims> {
    if (!bearer?.startsWith('Bearer ')) throw new UnauthorizedException('Open the link from your email again.');
    try {
      const c = await this.jwt.verifyAsync<SignClaims>(bearer.slice(7), { secret: this.config.JWT_SIGN_SECRET, algorithms: ['HS256'] });
      if (c.typ !== 'sign') throw new Error();
      return c;
    } catch {
      throw new UnauthorizedException('Your signing session has ended. Open the link from your email again.');
    }
  }

  private async activeRecipient(c: SignClaims) {
    const r = await this.db.query.recipients.findFirst({
      where: eq(recipients.id, c.sub),
      with: { document: { with: { sender: { columns: { fullName: true, email: true } }, files: true } } },
    });
    if (!r || r.documentId !== c.doc) throw new UnauthorizedException('Open the link from your email again.');
    const state = this.state(r);
    if (state !== 'ready') throw new ConflictException({ message: stateMessage(state), state });
    return r;
  }

  async view(c: SignClaims) {
    const r = await this.activeRecipient(c);
    const mine = await this.db.select().from(fields).where(eq(fields.recipientId, r.id)).orderBy(asc(fields.page), asc(fields.y));
    const prepared = r.document.files.find((f) => f.kind === 'CONVERTED') ?? r.document.files.find((f) => f.kind === 'ORIGINAL')!;
    let saved: string[] = [];
    if (c.via === 'account' && r.userId) {
      saved = (await this.db.select({ kind: savedSignatures.kind }).from(savedSignatures).where(eq(savedSignatures.userId, r.userId))).map((s) => s.kind);
    }
    return {
      document: {
        title: r.document.title,
        referenceNo: r.document.referenceNo,
        senderName: r.document.sender.fullName,
        message: r.document.emailMessage,
        pageCount: prepared.pageCount,
        sha256: prepared.sha256,
        dateToday: formatSigningDate(new Date(), r.document.locale),
      },
      recipient: { name: r.fullName, email: r.email, consentAt: r.consentAt, via: c.via },
      consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
      fields: mine.map((f) => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label, options: f.options })),
      savedSignatures: saved,
    };
  }

  async file(c: SignClaims) {
    const r = await this.activeRecipient(c);
    const prepared = r.document.files.find((f) => f.kind === 'CONVERTED') ?? r.document.files.find((f) => f.kind === 'ORIGINAL')!;
    const data = await this.storage.get(prepared.storageKey, prepared.wrappedKey);
    if (sha256Hex(data) !== prepared.sha256) throw new ConflictException('This document failed its integrity check. Contact the sender.');
    return data;
  }

  async savedSignature(c: SignClaims, kind: 'SIGNATURE' | 'INITIALS') {
    const r = await this.activeRecipient(c);
    // Saved signatures are only offered after a staff sign-in, never through an emailed link.
    if (c.via !== 'account' || !r.userId) throw new ForbiddenException('Saved signatures are only available after signing in to eSign.');
    const s = await this.db.query.savedSignatures.findFirst({ where: and(eq(savedSignatures.userId, r.userId), eq(savedSignatures.kind, kind)) });
    if (!s) throw new BadRequestException('No saved signature.');
    const png = await this.storage.get(s.imageKey, s.wrappedKey);
    return { image: `data:image/png;base64,${png.toString('base64')}`, method: s.method };
  }

  /** Ruliba stamps this staff signer may apply. Outside signers upload their own company stamp instead. */
  private async allowedStamps(c: SignClaims, userId: string | null) {
    if (c.via !== 'account' || !userId) return [];
    return this.db
      .select({ id: stamps.id, name: stamps.name, imageKey: stamps.imageKey, wrappedKey: stamps.wrappedKey, sha256: stamps.sha256 })
      .from(stampUsers)
      .innerJoin(stamps, eq(stamps.id, stampUsers.stampId))
      .where(and(eq(stampUsers.userId, userId), eq(stamps.active, true)))
      .orderBy(asc(stamps.name));
  }

  async stampsFor(c: SignClaims) {
    const r = await this.activeRecipient(c);
    const list = await this.allowedStamps(c, r.userId);
    return Promise.all(list.map(async (st) => ({ id: st.id, name: st.name, image: `data:image/png;base64,${(await this.storage.get(st.imageKey, st.wrappedKey)).toString('base64')}` })));
  }

  async consent(c: SignClaims, version: string, meta: RequestMeta) {
    const r = await this.activeRecipient(c);
    if (version !== CONSENT_VERSION) throw new BadRequestException('The consent text has changed. Reload the page.');
    if (r.consentAt) return { consentAt: r.consentAt };
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(recipients).set({ consentAt: now, consentTextVersion: CONSENT_VERSION }).where(eq(recipients.id, r.id));
      await this.audit.record(
        {
          type: 'recipient.consented',
          meta,
          documentId: r.documentId,
          recipientId: r.id,
          actor: { email: r.email, name: r.fullName },
          details: { version: CONSENT_VERSION, text: CONSENT_TEXT, textSha256: sha256Hex(CONSENT_TEXT) },
        },
        tx,
      );
    });
    return { consentAt: now };
  }

  async complete(c: SignClaims, input: CompleteSigningInput, meta: RequestMeta) {
    const r = await this.activeRecipient(c);
    if (!r.consentAt) throw new BadRequestException('Agree to sign electronically first.');
    const mine = await this.db.select().from(fields).where(eq(fields.recipientId, r.id));
    const byId = new Map(input.values.map((v) => [v.fieldId, v]));
    for (const v of input.values) if (!mine.some((f) => f.id === v.fieldId)) throw new BadRequestException('A field does not belong to you.');

    const now = new Date();
    const prepared = r.document.files.find((f) => f.kind === 'CONVERTED') ?? r.document.files.find((f) => f.kind === 'ORIGINAL')!;
    type Value = { fieldId: string; value: string | null; image?: Buffer; method?: 'DRAWN' | 'TYPED' | 'UPLOADED'; stamp?: { id: string | null; name: string; sha256: string } };
    const myStamps = mine.some((f) => f.type === 'STAMP') ? await this.allowedStamps(c, r.userId) : [];
    const values: Value[] = [];
    const problems: string[] = [];
    for (const f of mine) {
      const v = byId.get(f.id);
      const label = f.label || f.type.toLowerCase().replace('_', ' ');
      if (f.type === 'NAME') values.push({ fieldId: f.id, value: r.fullName });
      else if (f.type === 'DATE_SIGNED') values.push({ fieldId: f.id, value: formatSigningDate(now, r.document.locale) });
      else if (f.type === 'SIGNATURE' || f.type === 'INITIALS') {
        if (!v?.image) {
          if (f.required) problems.push(`Add your ${label}.`);
          continue;
        }
        const png = Buffer.from(v.image.split(',')[1], 'base64');
        if (png.length > MAX_SIGNATURE_BYTES || !(await isPng(png))) throw new BadRequestException('The signature image could not be read. Draw or type it again.');
        values.push({ fieldId: f.id, value: null, image: png, method: v.method ?? 'DRAWN' });
      } else if (f.type === 'STAMP') {
        if (v?.stampId) {
          // Ruliba stamps: only staff signed in to eSign, and only the stamps the administrator allowed them.
          const st = myStamps.find((x) => x.id === v.stampId);
          if (!st) throw new ForbiddenException('You may not use that stamp. Ask the administrator (Settings, Stamps).');
          const png = await this.storage.get(st.imageKey, st.wrappedKey);
          if (sha256Hex(png) !== st.sha256) throw new ConflictException('The stamp image failed its integrity check. Tell the IT office.');
          values.push({ fieldId: f.id, value: st.name, image: png, stamp: { id: st.id, name: st.name, sha256: st.sha256 } });
        } else if (v?.image) {
          if (c.via === 'account') throw new BadRequestException('Choose one of the Ruliba stamps you may use. If none is listed, ask the administrator (Settings, Stamps).');
          const png = await readPng(v.image);
          if (!png) throw new BadRequestException('The stamp picture could not be read. Upload it again.');
          values.push({ fieldId: f.id, value: 'Own company stamp (uploaded by the signer)', image: png, method: 'UPLOADED', stamp: { id: null, name: 'Own company stamp', sha256: sha256Hex(png) } });
        } else if (f.required) problems.push(`Add your ${f.label || 'stamp'}.`);
      } else if (f.type === 'CHECKBOX') values.push({ fieldId: f.id, value: v?.value === 'true' ? 'true' : 'false' });
      else if (f.type === 'DROPDOWN') {
        if (!v?.value) {
          if (f.required) problems.push(`Choose an option for ${label}.`);
          continue;
        }
        if (!(f.options as string[] | null)?.includes(v.value)) throw new BadRequestException(`"${v.value}" is not one of the choices for ${label}.`);
        values.push({ fieldId: f.id, value: v.value });
      } else {
        const text = v?.value?.trim();
        if (!text) {
          if (f.required) problems.push(`Fill in ${label}.`);
          continue;
        }
        values.push({ fieldId: f.id, value: text });
      }
    }
    if (problems.length) throw new BadRequestException({ message: problems.join(' '), errors: problems.map((m) => ({ field: 'values', message: m })) });

    // Store signature images (encrypted) before the transaction; remove them if it fails.
    const stored: { fieldId: string; key: string; wrappedKey: string }[] = [];
    for (const v of values.filter((x) => x.image)) {
      const key = this.storage.newKey(`documents/${r.documentId}/signatures`);
      const { wrappedKey } = await this.storage.put(key, v.image!);
      stored.push({ fieldId: v.fieldId, key, wrappedKey });
    }

    let outbox: Awaited<ReturnType<RoutingService['activateNextStep']>>;
    try {
      outbox = await this.db.transaction(async (tx) => {
        // Lock this signer's row: a double tap on "Finish" can only sign once.
        const lock = await tx.execute<{ status: string }>(sql`select status from recipients where id = ${r.id} for update`);
        if (!['SENT', 'VIEWED'].includes(lock.rows[0]?.status)) throw new ConflictException('You have already finished signing this document.');
        for (const v of values) {
          const img = stored.find((s) => s.fieldId === v.fieldId);
          await tx.insert(fieldValues).values({
            fieldId: v.fieldId,
            recipientId: r.id,
            value: v.value,
            imageKey: img?.key ?? null,
            wrappedKey: img?.wrappedKey ?? null,
            signatureMethod: v.method ?? null,
            filledAt: now,
          });
        }
        // The link stays recognisable so a second click says "already signed"; it can no longer open a session.
        await tx.update(recipients).set({ status: 'COMPLETED', completedAt: now }).where(eq(recipients.id, r.id));
        await this.audit.record(
          {
            type: 'recipient.signed',
            meta,
            documentId: r.documentId,
            recipientId: r.id,
            actor: { email: r.email, name: r.fullName },
            docSha256: prepared.sha256,
            details: {
              fields: values.length,
              methods: [...new Set(values.filter((v) => v.method && !v.stamp).map((v) => v.method!))],
              signatureImageSha256: values.filter((v) => v.image && !v.stamp).map((v) => sha256Hex(v.image!)),
              stamps: values.filter((v) => v.stamp).map((v) => v.stamp),
              verifiedVia: c.via,
            },
          },
          tx,
        );
        return this.routing.activateNextStep(tx, r.documentId, meta);
      });
    } catch (e) {
      await Promise.all(stored.map((s) => this.storage.remove(s.key)));
      throw e;
    }
    await this.routing.deliver(outbox);
    let completed = false;
    if (outbox.complete) {
      try {
        completed = await this.finalizer.finalize(r.documentId);
      } catch (e) {
        // The worker retries every few minutes; the signer's part is already safely recorded.
        this.log.error(`Finalising ${r.documentId} failed: ${(e as Error).message}`);
      }
    }
    return { done: true, documentCompleted: completed };
  }

  async decline(c: SignClaims, reason: string, meta: RequestMeta) {
    const r = await this.activeRecipient(c);
    const outbox = await this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ status: string }>(sql`select status from recipients where id = ${r.id} for update`);
      if (!['SENT', 'VIEWED'].includes(lock.rows[0]?.status)) throw new ConflictException('This document can no longer be declined.');
      await tx.update(recipients).set({ status: 'DECLINED', declinedAt: new Date(), declineReason: reason }).where(eq(recipients.id, r.id));
      await tx
        .update(recipients)
        .set({ status: 'CANCELLED' })
        .where(and(eq(recipients.documentId, r.documentId), inArray(recipients.status, ['WAITING', 'SENT', 'VIEWED'])));
      await tx.update(documents).set({ status: 'DECLINED' }).where(eq(documents.id, r.documentId));
      await this.audit.record({ type: 'recipient.declined', meta, documentId: r.documentId, recipientId: r.id, actor: { email: r.email, name: r.fullName }, details: { reason } }, tx);
      return this.routing.declineNotices(tx, r.documentId, r, reason);
    });
    await this.routing.deliver(outbox);
    return { declined: true };
  }
}

async function isPng(buf: Buffer) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  try {
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(buf); // fully parses the image
    return img.width > 0 && img.height > 0 && img.width <= 4000 && img.height <= 4000;
  } catch {
    return false;
  }
}

export function stateMessage(state: LinkState): string {
  return {
    ready: '',
    completed: 'You have already signed this document. Thank you.',
    declined: 'This document was declined, so signing has stopped.',
    voided: 'The sender cancelled this document. There is nothing to sign.',
    expired: 'This signing link has expired. Ask the sender to send it again.',
    activate: 'Activate your Ruliba Clays eSign account first, using the activation link in your email. Then you can sign.',
    waiting: 'It is not your turn to sign yet. You will get an email when it is.',
    invalid: 'This link is not valid. Check that you used the whole link from the email.',
  }[state];
}

