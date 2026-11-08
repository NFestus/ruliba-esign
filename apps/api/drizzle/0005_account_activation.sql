ALTER TYPE "public"."user_status" ADD VALUE 'PENDING' BEFORE 'ACTIVE';--> statement-breakpoint
CREATE TABLE "activation_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activated_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "activation_tokens" ADD CONSTRAINT "activation_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activation_tokens_user_idx" ON "activation_tokens" USING btree ("user_id");--> statement-breakpoint
-- Accounts created before activation links existed are already in use: treat them as activated.
UPDATE "users" SET "activated_at" = "created_at" WHERE "activated_at" IS NULL;
