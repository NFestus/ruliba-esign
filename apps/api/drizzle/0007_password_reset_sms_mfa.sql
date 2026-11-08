CREATE TYPE "public"."account_token_purpose" AS ENUM('ACTIVATION', 'PASSWORD_RESET');--> statement-breakpoint
CREATE TYPE "public"."mfa_method" AS ENUM('TOTP', 'SMS');--> statement-breakpoint
CREATE TABLE "mfa_sms_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"attempts_left" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_factors" ALTER COLUMN "secret_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activation_tokens" ADD COLUMN "purpose" "account_token_purpose" DEFAULT 'ACTIVATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_factors" ADD COLUMN "method" "mfa_method" DEFAULT 'TOTP' NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_factors" ADD COLUMN "phone" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_sms_codes" ADD CONSTRAINT "mfa_sms_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_sms_codes_user_idx" ON "mfa_sms_codes" USING btree ("user_id");