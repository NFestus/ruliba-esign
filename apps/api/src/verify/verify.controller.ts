import { BadRequestException, Controller, Get, HttpCode, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { Public, Roles } from '../auth/decorators';
import { sha256Hex } from '../common/crypto.service';
import { Meta, RequestMeta } from '../common/request-meta';
import { Database, DbService } from '../db/db';
import { documentFiles, documents, recipients, signingCertificates } from '../db/schema';
import { SealService } from '../pdf/seal.service';

const VERIFY_LIMIT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

/**
 * "Check a document": anyone (a supplier, a bank, a court) uploads a PDF and learns whether it is
 * exactly a copy that Ruliba Clays eSign sealed. The file is hashed in memory and never stored.
 * Only what the holder of the file can already read is returned: title, reference, dates, signer names.
 */
@Controller()
export class VerifyController {
  private readonly db: Database;
  constructor(
    dbs: DbService,
    private readonly audit: AuditService,
    private readonly sealer: SealService,
  ) {
    this.db = dbs.db;
  }

  @Public()
  @Throttle(VERIFY_LIMIT)
  @Post('verify')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024, files: 1 } }))
  async verify(@UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @Meta() meta: RequestMeta) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose the PDF to check.');
    const sha = sha256Hex(file.buffer);
    const [match] = await this.db
      .select({ f: documentFiles, d: documents })
      .from(documentFiles)
      .innerJoin(documents, eq(documents.id, documentFiles.documentId))
      .where(and(eq(documentFiles.sha256, sha), inArray(documentFiles.kind, ['SEALED', 'SIGNED', 'CERTIFICATE'])))
      .limit(1);
    await this.audit.record({ type: 'verify.checked', meta, documentId: match?.d.id ?? null, details: { sha256: sha, match: !!match } });
    if (!match) return { match: false, sha256: sha };
    const signers = await this.db
      .select({ fullName: recipients.fullName, completedAt: recipients.completedAt })
      .from(recipients)
      .where(and(eq(recipients.documentId, match.d.id), eq(recipients.role, 'SIGNER')))
      .orderBy(asc(recipients.stepOrder));
    return {
      match: true,
      sha256: sha,
      kind: match.f.kind === 'CERTIFICATE' ? 'certificate' : 'signed copy',
      sealed: match.f.kind !== 'SIGNED',
      title: match.d.title,
      referenceNo: match.d.referenceNo,
      completedAt: match.d.completedAt,
      signers,
    };
  }

  /** The authority certificate, so anyone can add it to Adobe Reader's trusted list. */
  @Public()
  @Get('verify/authority-certificate')
  async authorityCertificate() {
    const ca = await this.sealer.authority();
    return new StreamableFile(Buffer.from(ca.certPem), { type: 'application/x-pem-file', disposition: 'attachment; filename="Ruliba-Clays-eSign-Authority.pem"' });
  }

  @Roles('ADMIN', 'AUDITOR')
  @Get('signing/certificates')
  async certificates() {
    await this.sealer.authority(); // creates the authority and seal on first visit
    const rows = await this.db.select().from(signingCertificates).orderBy(asc(signingCertificates.createdAt));
    return rows.map(({ privateKeyEnc: _k, certPem: _p, ...r }) => r);
  }
}
