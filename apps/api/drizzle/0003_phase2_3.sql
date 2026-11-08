ALTER TABLE "documents" ADD COLUMN "purged_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "purge_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "link" varchar(300);--> statement-breakpoint
ALTER TABLE "signing_certificates" ADD COLUMN "private_key_enc" text;