CREATE TYPE "public"."auth_method" AS ENUM('EMAIL_OTP', 'ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."certificate_kind" AS ENUM('AUTHORITY', 'ORGANIZATION_SEAL', 'PERSONAL');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."field_type" AS ENUM('SIGNATURE', 'INITIALS', 'DATE_SIGNED', 'NAME', 'TEXT', 'CHECKBOX', 'DROPDOWN');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('ORIGINAL', 'CONVERTED', 'PREPARED', 'SEALED', 'CERTIFICATE');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL', 'IN_APP');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('QUEUED', 'SENT', 'FAILED', 'READ');--> statement-breakpoint
CREATE TYPE "public"."recipient_role" AS ENUM('APPROVER', 'SIGNER', 'CC');--> statement-breakpoint
CREATE TYPE "public"."recipient_status" AS ENUM('WAITING', 'SENT', 'VIEWED', 'COMPLETED', 'DECLINED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'SENDER', 'APPROVER', 'SIGNER', 'AUDITOR');--> statement-breakpoint
CREATE TYPE "public"."routing_mode" AS ENUM('SEQUENTIAL', 'PARALLEL', 'MIXED');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');--> statement-breakpoint
CREATE TYPE "public"."signature_kind" AS ENUM('SIGNATURE', 'INITIALS');--> statement-breakpoint
CREATE TYPE "public"."signature_level" AS ENUM('PLATFORM', 'GOVCA');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('DRAWN', 'TYPED', 'UPLOADED');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"document_type_id" uuid,
	"department_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_policy_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"approver_user_id" uuid,
	"min_amount" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"type" varchar(60) NOT NULL,
	"document_id" uuid,
	"recipient_id" uuid,
	"actor_user_id" uuid,
	"actor_email" varchar(254),
	"actor_name" varchar(160),
	"ip" varchar(64),
	"user_agent" varchar(400),
	"doc_sha256" char(64),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"hash" char(64) NOT NULL,
	CONSTRAINT "audit_events_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"company" varchar(160),
	"phone" varchar(40),
	"document_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(5) NOT NULL,
	"name" varchar(120) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_code_unique" UNIQUE("code"),
	CONSTRAINT "departments_code_format" CHECK ("departments"."code" ~ '^[A-Z]{2,5}$')
);
--> statement-breakpoint
CREATE TABLE "document_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "file_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"page_count" integer,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(5) NOT NULL,
	"name" varchar(120) NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"esign_allowed" boolean DEFAULT true NOT NULL,
	"min_signature_level" "signature_level" DEFAULT 'PLATFORM' NOT NULL,
	"retention_years" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_types_code_unique" UNIQUE("code"),
	CONSTRAINT "document_types_code_format" CHECK ("document_types"."code" ~ '^[A-Z]{2,5}$')
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"document_type_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"template_id" uuid,
	"status" "document_status" DEFAULT 'DRAFT' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'INTERNAL' NOT NULL,
	"signature_level" "signature_level" DEFAULT 'PLATFORM' NOT NULL,
	"routing_mode" "routing_mode" DEFAULT 'SEQUENTIAL' NOT NULL,
	"reference_no" varchar(40),
	"counterparty" varchar(200),
	"contract_value" numeric(18, 2),
	"currency" char(3),
	"locale" varchar(10) DEFAULT 'en-RW' NOT NULL,
	"email_subject" varchar(200),
	"email_message" text,
	"reminder_every_days" integer,
	"expires_at" timestamp (3) with time zone,
	"sent_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"voided_at" timestamp (3) with time zone,
	"void_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_reference_no_unique" UNIQUE("reference_no")
);
--> statement-breakpoint
CREATE TABLE "field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"value" text,
	"image_key" text,
	"wrapped_key" text,
	"signature_method" "signature_method",
	"filled_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_values_field_id_unique" UNIQUE("field_id")
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" "field_type" NOT NULL,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" varchar(120),
	"options" jsonb,
	"default_value" text
);
--> statement-breakpoint
CREATE TABLE "mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_enc" text NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	"last_used_step" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_factors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" varchar(254),
	"document_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"template" varchar(60) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"status" "notification_status" DEFAULT 'QUEUED' NOT NULL,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"read_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"attempts_left" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	"ip" varchar(64),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"role" "recipient_role" NOT NULL,
	"step_order" integer NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"email" varchar(254) NOT NULL,
	"user_id" uuid,
	"is_external" boolean DEFAULT true NOT NULL,
	"auth_method" "auth_method" DEFAULT 'EMAIL_OTP' NOT NULL,
	"status" "recipient_status" DEFAULT 'WAITING' NOT NULL,
	"access_token_hash" char(64),
	"token_expires_at" timestamp (3) with time zone,
	"consent_at" timestamp (3) with time zone,
	"consent_text_version" varchar(20),
	"sent_at" timestamp (3) with time zone,
	"viewed_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"declined_at" timestamp (3) with time zone,
	"decline_reason" text,
	"last_reminder_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipients_access_token_hash_unique" UNIQUE("access_token_hash")
);
--> statement-breakpoint
CREATE TABLE "reference_sequences" (
	"department_code" varchar(5) NOT NULL,
	"type_code" varchar(5) NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reference_sequences_department_code_type_code_year_pk" PRIMARY KEY("department_code","type_code","year")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_id" uuid,
	"ip" varchar(64),
	"user_agent" varchar(400),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "saved_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "signature_kind" NOT NULL,
	"method" "signature_method" NOT NULL,
	"image_key" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "certificate_kind" NOT NULL,
	"level" "signature_level" DEFAULT 'PLATFORM' NOT NULL,
	"holder_name" varchar(160) NOT NULL,
	"holder_email" varchar(254),
	"user_id" uuid,
	"serial_number" text NOT NULL,
	"fingerprint_sha256" char(64) NOT NULL,
	"cert_pem" text NOT NULL,
	"not_before" timestamp (3) with time zone NOT NULL,
	"not_after" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"revoke_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_certificates_serial_number_unique" UNIQUE("serial_number"),
	CONSTRAINT "signing_certificates_fingerprint_sha256_unique" UNIQUE("fingerprint_sha256")
);
--> statement-breakpoint
CREATE TABLE "template_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"template_role_id" uuid NOT NULL,
	"type" "field_type" NOT NULL,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" varchar(120),
	"options" jsonb
);
--> statement-breakpoint
CREATE TABLE "template_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"role_name" varchar(80) NOT NULL,
	"role" "recipient_role" NOT NULL,
	"step_order" integer NOT NULL,
	"default_name" varchar(160),
	"default_email" varchar(254)
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"document_type_id" uuid NOT NULL,
	"department_id" uuid,
	"owner_id" uuid NOT NULL,
	"routing_mode" "routing_mode" DEFAULT 'SEQUENTIAL' NOT NULL,
	"storage_key" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"page_count" integer NOT NULL,
	"email_subject" varchar(200),
	"email_message" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"job_title" varchar(120),
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"department_id" uuid,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"last_login_at" timestamp (3) with time zone,
	"password_changed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_signatures" ADD CONSTRAINT "saved_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_certificates" ADD CONSTRAINT "signing_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_template_role_id_template_roles_id_fk" FOREIGN KEY ("template_role_id") REFERENCES "public"."template_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_roles" ADD CONSTRAINT "template_roles_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policy_steps_order_uq" ON "approval_policy_steps" USING btree ("policy_id","step_order");--> statement-breakpoint
CREATE INDEX "audit_events_document_idx" ON "audit_events" USING btree ("document_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "document_files_doc_kind_idx" ON "document_files" USING btree ("document_id","kind");--> statement-breakpoint
CREATE INDEX "document_files_sha_idx" ON "document_files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_sender_idx" ON "documents" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "documents_department_status_idx" ON "documents" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "documents_created_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "documents_search_idx" ON "documents" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("counterparty", '') || ' ' || coalesce("reference_no", '')));--> statement-breakpoint
CREATE INDEX "fields_document_idx" ON "fields" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_recipient_idx" ON "otp_challenges" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "recipients_doc_step_idx" ON "recipients" USING btree ("document_id","step_order");--> statement-breakpoint
CREATE INDEX "recipients_email_idx" ON "recipients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "recipients_user_status_idx" ON "recipients" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_signatures_user_kind_uq" ON "saved_signatures" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "users_department_idx" ON "users" USING btree ("department_id");