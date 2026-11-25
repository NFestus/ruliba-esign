ALTER TABLE "refresh_tokens" ADD COLUMN "session_expires_at" timestamp (3) with time zone;--> statement-breakpoint
-- Sign-ins that are open when this runs move to the new limits: at most 12 more hours in all,
-- and they end after 30 minutes unless used.
UPDATE "refresh_tokens" SET "session_expires_at" = LEAST("expires_at", now() + interval '12 hours');--> statement-breakpoint
UPDATE "refresh_tokens" SET "expires_at" = LEAST("expires_at", now() + interval '30 minutes') WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_expires_at" SET NOT NULL;
