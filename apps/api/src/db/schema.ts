/**
 * Ruliba Clays eSign — data model (Drizzle ORM, PostgreSQL 16).
 * Full model for all phases. Phase 0 code uses: departments, users, roles, MFA, refresh tokens,
 * settings, document types, approval policies, audit events, notifications.
 * The other tables exist now so later phases add code, not redesign.
 * `npm run db:generate` turns changes here into a reviewed SQL file in ./drizzle.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => ts('created_at').notNull().defaultNow();

// ───────────────────────────── Enums ─────────────────────────────

export const roleEnum = pgEnum('role', ['ADMIN', 'SENDER', 'APPROVER', 'SIGNER', 'AUDITOR']);
export const userStatusEnum = pgEnum('user_status', ['PENDING', 'ACTIVE', 'DISABLED']);
export const accountTokenPurposeEnum = pgEnum('account_token_purpose', ['ACTIVATION', 'PASSWORD_RESET']);
export const mfaMethodEnum = pgEnum('mfa_method', ['TOTP', 'SMS']);
export const sensitivityEnum = pgEnum('sensitivity', ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
export const signatureLevelEnum = pgEnum('signature_level', ['PLATFORM', 'GOVCA']);
export const documentStatusEnum = pgEnum('document_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'VOIDED',
  'EXPIRED',
]);
export const routingModeEnum = pgEnum('routing_mode', ['SEQUENTIAL', 'PARALLEL', 'MIXED']);
// SIGNED = fields stamped + signing record (Phase 1). SEALED = SIGNED + Ruliba's digital seal (Phase 3).
export const fileKindEnum = pgEnum('file_kind', ['ORIGINAL', 'CONVERTED', 'PREPARED', 'SIGNED', 'SEALED', 'CERTIFICATE']);
export const recipientRoleEnum = pgEnum('recipient_role', ['APPROVER', 'SIGNER', 'CC']);
export const recipientStatusEnum = pgEnum('recipient_status', ['WAITING', 'SENT', 'VIEWED', 'COMPLETED', 'DECLINED', 'CANCELLED']);
export const authMethodEnum = pgEnum('auth_method', ['EMAIL_OTP', 'ACCOUNT']);
export const fieldTypeEnum = pgEnum('field_type', ['SIGNATURE', 'INITIALS', 'DATE_SIGNED', 'NAME', 'TEXT', 'CHECKBOX', 'DROPDOWN', 'STAMP']);
export const signatureMethodEnum = pgEnum('signature_method', ['DRAWN', 'TYPED', 'UPLOADED']);
export const signatureKindEnum = pgEnum('signature_kind', ['SIGNATURE', 'INITIALS']);
export const notificationChannelEnum = pgEnum('notification_channel', ['EMAIL', 'IN_APP']);
export const notificationStatusEnum = pgEnum('notification_status', ['QUEUED', 'SENT', 'FAILED', 'READ']);
export const certificateKindEnum = pgEnum('certificate_kind', ['AUTHORITY', 'ORGANIZATION_SEAL', 'PERSONAL']);

// ───────────────────────────── People ─────────────────────────────

export const departments = pgTable(
  'departments',
  {
    id: id(),
    code: varchar('code', { length: 5 }).notNull().unique(), // used in reference numbers, e.g. PRO
    name: varchar('name', { length: 120 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('departments_code_format', sql`${t.code} ~ '^[A-Z]{2,5}$'`)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 254 }).notNull().unique(),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    jobTitle: varchar('job_title', { length: 120 }),
    passwordHash: text('password_hash').notNull(), // Argon2id
    // PENDING: created by an administrator, waiting for the person to open the emailed activation link.
    status: userStatusEnum('status').notNull().default('ACTIVE'),
    departmentId: uuid('department_id').references(() => departments.id),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    passwordChangedAt: ts('password_changed_at'),
    activatedAt: ts('activated_at'), // null until the person chose a password from the activation link
    mfaRequired: boolean('mfa_required').notNull().default(false), // set by an administrator, on top of the roles that always need it
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index('users_department_idx').on(t.departmentId), check('users_email_lower', sql`${t.email} = lower(${t.email})`)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/**
 * The person's recent passwords (Argon2id hashes, newest first; at most PASSWORD_HISTORY_SIZE kept),
 * so a reset or change cannot go back to one of the last five.
 */
export const passwordHistory = pgTable(
  'password_history',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('password_history_user_idx').on(t.userId, t.createdAt)],
);

/** One-use links emailed to people: account activation and password reset. Only the SHA-256 of the token is stored. */
export const activationTokens = pgTable(
  'activation_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: accountTokenPurposeEnum('purpose').notNull().default('ACTIVATION'),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('activation_tokens_user_idx').on(t.userId)],
);

export const mfaFactors = pgTable('mfa_factors', {
  id: id(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  method: mfaMethodEnum('method').notNull().default('TOTP'),
  secretEnc: text('secret_enc'), // TOTP only: secret, AES-256-GCM encrypted with the master key
  phone: varchar('phone', { length: 20 }), // SMS only: E.164 number the codes go to
  confirmedAt: ts('confirmed_at'),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }), // blocks replay of the same 30-second code
  createdAt: createdAt(),
});

/** Sign-in codes sent by SMS. Only the newest works; 10 minutes, 5 tries. */
export const mfaSmsCodes = pgTable(
  'mfa_sms_codes',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    expiresAt: ts('expires_at').notNull(),
    attemptsLeft: integer('attempts_left').notNull().default(5),
    consumedAt: ts('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('mfa_sms_codes_user_idx').on(t.userId)],
);

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeHash: char('code_hash', { length: 64 }).notNull(), // SHA-256
    usedAt: ts('used_at'),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(), // every rotation of one sign-in
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(), // SHA-256; raw token never stored
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedById: uuid('replaced_by_id'),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 400 }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.familyId)],
);

export const contacts = pgTable('contacts', {
  id: id(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  fullName: varchar('full_name', { length: 160 }).notNull(),
  company: varchar('company', { length: 160 }),
  phone: varchar('phone', { length: 40 }),
  documentCount: integer('document_count').notNull().default(0),
  lastSentAt: ts('last_sent_at'),
  createdAt: createdAt(),
});

export const savedSignatures = pgTable(
  'saved_signatures',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: signatureKindEnum('kind').notNull(),
    method: signatureMethodEnum('method').notNull(),
    imageKey: text('image_key').notNull(), // object-storage key of the encrypted image
    wrappedKey: text('wrapped_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('saved_signatures_user_kind_uq').on(t.userId, t.kind)],
);

/** Company stamps (rubber-stamp images) uploaded by an administrator. */
export const stamps = pgTable('stamps', {
  id: id(),
  name: varchar('name', { length: 120 }).notNull(),
  imageKey: text('image_key').notNull(),
  wrappedKey: text('wrapped_key').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  active: boolean('active').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: createdAt(),
});

/** Who may apply each stamp. */
export const stampUsers = pgTable(
  'stamp_users',
  {
    stampId: uuid('stamp_id').notNull().references(() => stamps.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.stampId, t.userId] })],
);

/** Personal folders. A folder only organises its owner's view; it never changes who can see a document. */
export const folders = pgTable(
  'folders',
  {
    id: id(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('folders_owner_name_uq').on(t.ownerId, sql`lower(${t.name})`)],
);

/** Which of my folders a document is in (at most one per person). */
export const folderDocuments = pgTable(
  'folder_documents',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').notNull().references(() => folders.id, { onDelete: 'cascade' }),
    filedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.documentId] }), index('folder_documents_folder_idx').on(t.folderId)],
);

// ───────────────────────────── Set-up ─────────────────────────────

export const settings = pgTable('settings', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const documentTypes = pgTable(
  'document_types',
  {
    id: id(),
    code: varchar('code', { length: 5 }).notNull().unique(), // used in reference numbers, e.g. CON
    name: varchar('name', { length: 120 }).notNull(),
    requiresApproval: boolean('requires_approval').notNull().default(true),
    eSignAllowed: boolean('esign_allowed').notNull().default(true), // false = must not be signed electronically
    minSignatureLevel: signatureLevelEnum('min_signature_level').notNull().default('PLATFORM'),
    retentionYears: integer('retention_years'), // null = keep until a period is decided
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('document_types_code_format', sql`${t.code} ~ '^[A-Z]{2,5}$'`)],
);

export const approvalPolicies = pgTable('approval_policies', {
  id: id(),
  name: varchar('name', { length: 120 }).notNull(),
  documentTypeId: uuid('document_type_id').references(() => documentTypes.id), // null = any type
  departmentId: uuid('department_id').references(() => departments.id), // null = any department
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const approvalPolicySteps = pgTable(
  'approval_policy_steps',
  {
    id: id(),
    policyId: uuid('policy_id').notNull().references(() => approvalPolicies.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    label: varchar('label', { length: 120 }).notNull(), // e.g. "Finance Director"
    approverUserId: uuid('approver_user_id').references(() => users.id), // person holding the post
    // Step applies only when the document value is ABOVE this amount (null = always applies).
    // Amounts are in the currency of the organisation-wide 'approval' setting.
    minAmount: numeric('min_amount', { precision: 18, scale: 2 }),
  },
  (t) => [uniqueIndex('approval_policy_steps_order_uq').on(t.policyId, t.stepOrder)],
);

export const referenceSequences = pgTable(
  'reference_sequences',
  {
    departmentCode: varchar('department_code', { length: 5 }).notNull(),
    typeCode: varchar('type_code', { length: 5 }).notNull(),
    year: integer('year').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.departmentCode, t.typeCode, t.year] })],
);

export const signingCertificates = pgTable('signing_certificates', {
  id: id(),
  kind: certificateKindEnum('kind').notNull(),
  level: signatureLevelEnum('level').notNull().default('PLATFORM'),
  holderName: varchar('holder_name', { length: 160 }).notNull(),
  holderEmail: varchar('holder_email', { length: 254 }),
  userId: uuid('user_id').references(() => users.id),
  serialNumber: text('serial_number').notNull().unique(),
  fingerprintSha256: char('fingerprint_sha256', { length: 64 }).notNull().unique(),
  certPem: text('cert_pem').notNull(),
  privateKeyEnc: text('private_key_enc'), // AES-256-GCM with the master key; null for certificates held elsewhere (GovCA)
  notBefore: ts('not_before').notNull(),
  notAfter: ts('not_after').notNull(),
  revokedAt: ts('revoked_at'),
  revokeReason: text('revoke_reason'),
  createdAt: createdAt(),
});

// ───────────────────────────── Templates ─────────────────────────────

export const templates = pgTable('templates', {
  id: id(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  documentTypeId: uuid('document_type_id').notNull().references(() => documentTypes.id),
  departmentId: uuid('department_id').references(() => departments.id), // null = shared with all
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  routingMode: routingModeEnum('routing_mode').notNull().default('SEQUENTIAL'),
  storageKey: text('storage_key').notNull(),
  wrappedKey: text('wrapped_key').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  pageCount: integer('page_count').notNull(),
  emailSubject: varchar('email_subject', { length: 200 }),
  emailMessage: text('email_message'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const templateRoles = pgTable('template_roles', {
  id: id(),
  templateId: uuid('template_id').notNull().references(() => templates.id, { onDelete: 'cascade' }),
  roleName: varchar('role_name', { length: 80 }).notNull(), // e.g. "Supplier"
  role: recipientRoleEnum('role').notNull(),
  stepOrder: integer('step_order').notNull(),
  defaultName: varchar('default_name', { length: 160 }),
  defaultEmail: varchar('default_email', { length: 254 }),
});

const position = {
  page: integer('page').notNull(), // 1-based
  // Position and size as fractions of the page (0..1), so they do not depend on screen size.
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
  width: doublePrecision('width').notNull(),
  height: doublePrecision('height').notNull(),
};

export const templateFields = pgTable('template_fields', {
  id: id(),
  templateId: uuid('template_id').notNull().references(() => templates.id, { onDelete: 'cascade' }),
  templateRoleId: uuid('template_role_id').notNull().references(() => templateRoles.id, { onDelete: 'cascade' }),
  type: fieldTypeEnum('type').notNull(),
  ...position,
  required: boolean('required').notNull().default(true),
  label: varchar('label', { length: 120 }),
  options: jsonb('options'),
});

// ───────────────────────────── Documents ─────────────────────────────

export const documents = pgTable(
  'documents',
  {
    id: id(),
    title: varchar('title', { length: 200 }).notNull(),
    documentTypeId: uuid('document_type_id').notNull().references(() => documentTypes.id),
    departmentId: uuid('department_id').notNull().references(() => departments.id),
    senderId: uuid('sender_id').notNull().references(() => users.id),
    templateId: uuid('template_id').references(() => templates.id),
    status: documentStatusEnum('status').notNull().default('DRAFT'),
    sensitivity: sensitivityEnum('sensitivity').notNull().default('INTERNAL'),
    signatureLevel: signatureLevelEnum('signature_level').notNull().default('PLATFORM'),
    routingMode: routingModeEnum('routing_mode').notNull().default('SEQUENTIAL'),
    referenceNo: varchar('reference_no', { length: 40 }).unique(), // RCL/PRO/CON/2026/0001, set at final approval
    counterparty: varchar('counterparty', { length: 200 }), // supplier / contractor, for search
    contractValue: numeric('contract_value', { precision: 18, scale: 2 }),
    currency: char('currency', { length: 3 }),
    locale: varchar('locale', { length: 10 }).notNull().default('en-RW'), // how dates are written
    emailSubject: varchar('email_subject', { length: 200 }),
    emailMessage: text('email_message'),
    reminderEveryDays: integer('reminder_every_days'),
    expiresAt: ts('expires_at'),
    sentAt: ts('sent_at'),
    completedAt: ts('completed_at'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
    // Retention: files removed after the retention period; the record, fingerprints and audit trail stay.
    purgedAt: ts('purged_at'),
    purgeReason: text('purge_reason'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index('documents_status_idx').on(t.status),
    index('documents_sender_idx').on(t.senderId),
    index('documents_department_status_idx').on(t.departmentId, t.status),
    index('documents_created_idx').on(t.createdAt),
    // Full-text search over title, counterparty and reference (archive search, Phase 3)
    index('documents_search_idx').using(
      'gin',
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.counterparty}, '') || ' ' || coalesce(${t.referenceNo}, ''))`,
    ),
  ],
);

export const documentFiles = pgTable(
  'document_files',
  {
    id: id(),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'restrict' }),
    kind: fileKindEnum('kind').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(), // of the plaintext file
    pageCount: integer('page_count'),
    wrappedKey: text('wrapped_key').notNull(), // per-file AES key, wrapped by the master key
    createdAt: createdAt(),
  },
  (t) => [index('document_files_doc_kind_idx').on(t.documentId, t.kind), index('document_files_sha_idx').on(t.sha256)],
);

export const recipients = pgTable(
  'recipients',
  {
    id: id(),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    role: recipientRoleEnum('role').notNull(),
    stepOrder: integer('step_order').notNull(), // same number = act in parallel
    fullName: varchar('full_name', { length: 160 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    userId: uuid('user_id').references(() => users.id), // set for internal staff
    isExternal: boolean('is_external').notNull().default(true),
    authMethod: authMethodEnum('auth_method').notNull().default('EMAIL_OTP'),
    status: recipientStatusEnum('status').notNull().default('WAITING'),
    accessTokenHash: char('access_token_hash', { length: 64 }).unique(), // SHA-256 of the link token
    tokenExpiresAt: ts('token_expires_at'),
    consentAt: ts('consent_at'),
    consentTextVersion: varchar('consent_text_version', { length: 20 }),
    sentAt: ts('sent_at'),
    viewedAt: ts('viewed_at'),
    completedAt: ts('completed_at'),
    declinedAt: ts('declined_at'),
    declineReason: text('decline_reason'),
    lastReminderAt: ts('last_reminder_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('recipients_doc_step_idx').on(t.documentId, t.stepOrder),
    index('recipients_email_idx').on(t.email),
    index('recipients_user_status_idx').on(t.userId, t.status),
  ],
);

export const fields = pgTable(
  'fields',
  {
    id: id(),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id').notNull().references(() => recipients.id, { onDelete: 'cascade' }),
    type: fieldTypeEnum('type').notNull(),
    ...position,
    required: boolean('required').notNull().default(true),
    label: varchar('label', { length: 120 }),
    options: jsonb('options'), // dropdown choices
    defaultValue: text('default_value'),
  },
  (t) => [index('fields_document_idx').on(t.documentId)],
);

export const fieldValues = pgTable('field_values', {
  id: id(),
  fieldId: uuid('field_id').notNull().unique().references(() => fields.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').notNull().references(() => recipients.id, { onDelete: 'cascade' }),
  value: text('value'), // text, date, checkbox ("true"), dropdown choice
  imageKey: text('image_key'), // signature / initials image
  wrappedKey: text('wrapped_key'),
  signatureMethod: signatureMethodEnum('signature_method'),
  filledAt: ts('filled_at').notNull().defaultNow(),
});

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    recipientId: uuid('recipient_id').notNull().references(() => recipients.id, { onDelete: 'cascade' }),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    expiresAt: ts('expires_at').notNull(),
    attemptsLeft: integer('attempts_left').notNull().default(5),
    consumedAt: ts('consumed_at'),
    ip: varchar('ip', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [index('otp_challenges_recipient_idx').on(t.recipientId)],
);

// ───────────────────────────── Evidence ─────────────────────────────

/**
 * Append-only. Triggers in drizzle/0001_audit_append_only.sql reject UPDATE, DELETE and TRUNCATE.
 * Each row stores the previous row's hash, forming a chain (see src/audit/hash.ts).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: ts('occurred_at').notNull(),
    type: varchar('type', { length: 60 }).notNull(), // e.g. auth.login, document.signed
    documentId: uuid('document_id'),
    recipientId: uuid('recipient_id'),
    actorUserId: uuid('actor_user_id'),
    actorEmail: varchar('actor_email', { length: 254 }),
    actorName: varchar('actor_name', { length: 160 }),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 400 }),
    docSha256: char('doc_sha256', { length: 64 }),
    details: jsonb('details').notNull().default({}),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull().unique(),
  },
  (t) => [
    index('audit_events_document_idx').on(t.documentId, t.id),
    index('audit_events_actor_idx').on(t.actorUserId),
    index('audit_events_type_idx').on(t.type),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 254 }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    template: varchar('template', { length: 60 }).notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    body: text('body'),
    link: varchar('link', { length: 300 }),
    status: notificationStatusEnum('status').notNull().default('QUEUED'),
    error: text('error'),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
    readAt: ts('read_at'),
  },
  (t) => [index('notifications_user_read_idx').on(t.userId, t.readAt)],
);

// ───────────────────────────── Relations (for typed nested queries) ─────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
  department: one(departments, { fields: [users.departmentId], references: [departments.id] }),
  roles: many(userRoles),
  mfa: one(mfaFactors, { fields: [users.id], references: [mfaFactors.userId] }),
}));
export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
}));
export const departmentsRelations = relations(departments, ({ many }) => ({ users: many(users) }));
export const approvalPoliciesRelations = relations(approvalPolicies, ({ one, many }) => ({
  steps: many(approvalPolicySteps),
  documentType: one(documentTypes, { fields: [approvalPolicies.documentTypeId], references: [documentTypes.id] }),
  department: one(departments, { fields: [approvalPolicies.departmentId], references: [departments.id] }),
}));
export const approvalPolicyStepsRelations = relations(approvalPolicySteps, ({ one }) => ({
  policy: one(approvalPolicies, { fields: [approvalPolicySteps.policyId], references: [approvalPolicies.id] }),
  approver: one(users, { fields: [approvalPolicySteps.approverUserId], references: [users.id] }),
}));
export const documentsRelations = relations(documents, ({ one, many }) => ({
  recipients: many(recipients),
  fields: many(fields),
  files: many(documentFiles),
  documentType: one(documentTypes, { fields: [documents.documentTypeId], references: [documentTypes.id] }),
  department: one(departments, { fields: [documents.departmentId], references: [departments.id] }),
  sender: one(users, { fields: [documents.senderId], references: [users.id] }),
}));
export const documentFilesRelations = relations(documentFiles, ({ one }) => ({
  document: one(documents, { fields: [documentFiles.documentId], references: [documents.id] }),
}));
export const recipientsRelations = relations(recipients, ({ one, many }) => ({
  document: one(documents, { fields: [recipients.documentId], references: [documents.id] }),
  user: one(users, { fields: [recipients.userId], references: [users.id] }),
  fields: many(fields),
}));
export const fieldsRelations = relations(fields, ({ one }) => ({
  document: one(documents, { fields: [fields.documentId], references: [documents.id] }),
  recipient: one(recipients, { fields: [fields.recipientId], references: [recipients.id] }),
  value: one(fieldValues, { fields: [fields.id], references: [fieldValues.fieldId] }),
}));
export const fieldValuesRelations = relations(fieldValues, ({ one }) => ({
  field: one(fields, { fields: [fieldValues.fieldId], references: [fields.id] }),
}));
export const templatesRelations = relations(templates, ({ one, many }) => ({
  roles: many(templateRoles),
  fields: many(templateFields),
  documentType: one(documentTypes, { fields: [templates.documentTypeId], references: [documentTypes.id] }),
  owner: one(users, { fields: [templates.ownerId], references: [users.id] }),
}));
export const templateRolesRelations = relations(templateRoles, ({ one, many }) => ({
  template: one(templates, { fields: [templateRoles.templateId], references: [templates.id] }),
  fields: many(templateFields),
}));
export const templateFieldsRelations = relations(templateFields, ({ one }) => ({
  template: one(templates, { fields: [templateFields.templateId], references: [templates.id] }),
  role: one(templateRoles, { fields: [templateFields.templateRoleId], references: [templateRoles.id] }),
}));
