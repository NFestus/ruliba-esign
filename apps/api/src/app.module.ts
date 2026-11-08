import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { CryptoService } from './common/crypto.service';
import { CONFIG, loadConfig } from './config';
import { DbService } from './db/db';
import { EmailService } from './email/email.service';
import { SmsService } from './sms/sms.service';
import { HealthController } from './health.controller';
import { ReferenceService } from './reference/reference.service';
import { SetupController } from './setup/setup.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { ContactsController, DocumentsController, MySignatureController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { FinalizerService } from './documents/finalizer.service';
import { RoutingService } from './documents/routing.service';
import { ApprovalsService } from './documents/approvals.service';
import { JobsService } from './documents/jobs.service';
import { TemplatesController } from './documents/templates.controller';
import { TemplatesService } from './documents/templates.service';
import { NotificationsController } from './notifications.controller';
import { ConverterService } from './files/converter.service';
import { ScannerService } from './files/scanner.service';
import { StorageService } from './files/storage.service';
import { SealService } from './pdf/seal.service';
import { ReportsController } from './reports/reports.controller';
import { VerifyController } from './verify/verify.controller';
import { StampsController } from './stamps/stamps.controller';
import { FoldersController } from './folders/folders.controller';
import { TestEmailController } from './email/test-email.controller';
import { SigningController } from './signing/signing.controller';
import { SigningService } from './signing/signing.service';

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }, DbService, CryptoService, AuditService, EmailService,
    SmsService, ReferenceService, StorageService, SealService],
  exports: [CONFIG, DbService, CryptoService, AuditService, EmailService, SmsService, ReferenceService, StorageService, SealService],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    JwtModule.register({}),
    // General limit per client IP; sign-in routes have their own stricter limit.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.API_RATE_LIMIT ?? 300) }]),
  ],
  controllers: [HealthController, AuthController, UsersController, SetupController, AuditController, DocumentsController, ContactsController, MySignatureController, SigningController, TemplatesController, NotificationsController, VerifyController, ReportsController, StampsController, FoldersController, TestEmailController],
  providers: [
    AuthService,
    UsersService,
    DocumentsService,
    RoutingService,
    ApprovalsService,
    TemplatesService,
    JobsService,
    FinalizerService,
    SigningService,
    ScannerService,
    ConverterService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
