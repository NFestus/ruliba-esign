CREATE TABLE "password_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_history_user_idx" ON "password_history" USING btree ("user_id","created_at");--> statement-breakpoint
-- Each person's current password counts as their most recent one. Accounts waiting for activation have only an unusable random password.
INSERT INTO "password_history" ("user_id", "password_hash", "created_at")
SELECT "id", "password_hash", COALESCE("password_changed_at", "created_at") FROM "users" WHERE "activated_at" IS NOT NULL;
