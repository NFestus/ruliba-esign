-- Accounts that existed before activation links were introduced are treated as fully active:
-- they are not forced to replace the temporary password they were given.
-- 0005 marked every existing account as activated; accounts added later (status PENDING) have no activated_at yet.
-- (Comparing with the new 'PENDING' enum value here would fail when 0005 and 0006 run in the same transaction.)
UPDATE "users" SET "must_change_password" = false WHERE "activated_at" IS NOT NULL;
