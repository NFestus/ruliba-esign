-- Make audit_events append-only.
-- Any UPDATE, DELETE or TRUNCATE is refused by the database itself, whatever the application does.
-- A database owner could still drop these triggers, which is why:
--   (1) the application connects as a separate role that does not own the tables (infra/postgres/roles.sql),
--   (2) every row is hash-chained, so tampering is detectable even by someone who bypasses this, and
--   (3) the latest chain hash is exported off-box daily (Phase 3).

CREATE OR REPLACE FUNCTION audit_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change();
--> statement-breakpoint
-- The sealed record of a document must never silently disappear: files can only be removed
-- together with their document by an explicit retention job (Phase 3), never by cascade.
COMMENT ON TABLE audit_events IS 'Append-only, hash-chained evidence log. See src/audit/hash.ts.';
--> statement-breakpoint
-- Second lock on the same door: the application's database role may only read and add evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esign_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM esign_app;
  END IF;
END
$$;
