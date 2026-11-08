# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Ruliba Clays eSign**: an internal e-signature platform. Staff upload PDF/Word documents, add signers and fields, route them through approval chains, and collect signatures (staff from the dashboard, external people from an emailed link + one-time code). Output is a sealed PDF plus a certificate of completion; every step goes into a tamper-evident (hash-chained, append-only) audit log. Phases 0–3 are done; see `README.md` and `docs/handover.md` for status and open items.

## Repository layout (npm workspaces, Node 22)

```
packages/shared   zod schemas, roles, password rule, reference format — used by API and web. Build it first.
apps/api          NestJS 11 API + BullMQ worker (same code, entry points main.ts / worker.ts)
  src/auth        sign-in, MFA (own TOTP), sessions, refresh-token rotation, account activation, guards/decorators
  src/users       staff accounts (admin), activation-link issuing, admin password reset
  src/sms         SMS queue (SmsService) + providers (console | africastalking | twilio), sent by the worker
  src/db          Drizzle schema (schema.ts = data model) and connection
  src/email       email adapter (graph | smtp | console) + templates.ts (HTML + text)
  src/audit       hash-chained audit log (AuditService.record, pass `tx` inside transactions)
  src/documents, src/signing, src/pdf, src/files, src/reference, src/setup, src/reports, ...
  drizzle/        SQL migrations + meta snapshots (committed, reviewed)
  test/           e2e tests against real PostgreSQL + Redis (helpers.ts)
apps/web          React 18 PWA (Vite, react-router 7, TanStack Query). Pages in src/pages, API client src/api.ts
docs/             architecture.md (layout + decision log), openapi.yaml, admin/user guides, deployment, ERD
infra/            Caddy, Postgres roles/init, backup script
```

## Commands

```bash
npm install
npm run build -w packages/shared          # required before API/web type-check or run
npm run lint                              # tsc type-check for api + web (there is no eslint)
npm run dev:api | dev:worker | dev:web    # API :3000/api, web :5173 (proxies /api)
npm run db:migrate && npm run db:seed     # run from built dist (npm run build -w apps/api first)
npm run db:generate -w apps/api           # drizzle-kit: schema.ts -> new SQL migration (use --name)
npm test                                  # shared + API unit/e2e + web
```

Local services: `docker compose -f compose.dev.yml up -d` (Postgres on **5433**, Redis 6379, Mailpit UI :8025).
E2E tests need a separate DB (they drop its schema): `createdb esign_test`, then e.g.
`TEST_DATABASE_URL=postgresql://postgres@localhost:5433/esign_test npx jest --runInBand` in `apps/api`.
A few tests skip without LibreOffice (`soffice`) / `pdfsig`.

## Conventions

- **Schema changes**: edit `apps/api/src/db/schema.ts`, then generate a migration with drizzle-kit. CI fails if the schema and `drizzle/` disagree. Hand-written data fixes may be appended to the generated SQL (after a `--> statement-breakpoint`).
- **Validation**: request bodies use zod schemas from `@ruliba/shared` with `ZodPipe`; the web reuses the same rules (e.g. `passwordProblems`).
- **Auth**: a global guard requires a bearer access token; mark open endpoints `@Public()`, restrict with `@Roles(...)`. Throttle auth endpoints with `@Throttle(AUTH_LIMIT)`. Access token is in memory on the web; refresh token is an HttpOnly cookie on `/api/auth`, rotated with reuse detection.
- **Secrets/tokens**: store only SHA-256 hashes of link tokens (`sha256Hex`, `randomToken`); passwords are Argon2id. Never email passwords.
- **Audit**: every security- or document-relevant action calls `audit.record({ type, meta, actor, details }, tx)` inside the same transaction.
- **Email**: add a `TemplateName` + case in `email/templates.ts` (HTML-escape values with `e(...)`, links only under `APP_URL`), send with `EmailService.enqueue`. In tests, emails land in `app.get(EmailService).testOutbox`.
- **UI copy** is plain British English, written for non-technical staff. Dates shown in `Africa/Kigali`.
- Record notable design decisions in the decision log in `docs/architecture.md`; keep `docs/openapi.yaml` and `docs/admin-guide.md` in step with API/admin changes.

## User accounts, password reset and two-step sign-in

- User status: `PENDING` → `ACTIVE` ↔ `DISABLED`.
- An admin adds a user (`POST /api/users`): the account is **PENDING** with an unusable random password; an `activation_tokens` row (hash only, expires after `ACTIVATION_TOKEN_TTL_HOURS`, default 72) is created and an `account-activation` email links to `${APP_URL}/activate/<token>`.
- The web page `/activate/:token` (`apps/web/src/pages/Activate.tsx`) calls `GET /api/auth/activation/:token`, then `POST /api/auth/activate { token, newPassword }`, which sets the password, marks the token used and the user ACTIVE (`activatedAt`). The user is then sent to `/login`; roles that require MFA (Admin, Auditor) enrol at that first sign-in.
- `POST /api/users/:id/resend-activation` issues a new link and invalidates older ones. Admins cannot PATCH a PENDING user to ACTIVE; re-enabling a never-activated user returns it to PENDING.
- One-use emailed links (activation and password reset) live in `activation_tokens` with a `purpose` column; use the helpers in `apps/api/src/auth/account-tokens.ts` (`issueAccountToken` / `findAccountToken` / `consumeAccountToken`). Issuing a link ends older links of the same purpose.
- **Password reset:** `POST /api/auth/password/forgot { email }` always answers `{ ok: true }` (no account enumeration; at most one email a minute; a PENDING account gets a new activation link instead). The `password-reset` email links to `${APP_URL}/reset-password/<token>` (valid `PASSWORD_RESET_TTL_MINUTES`, default 60). `GET /api/auth/password/reset/:token`, then `POST /api/auth/password/reset { token, newPassword }` sets the password and revokes every session; MFA still applies at the next sign-in. The admin `POST /api/users/:id/reset-password` invalidates the current password, ends sessions and emails the same link (no temporary passwords any more). Web pages: `/forgot-password`, `/reset-password/:token` (both in `pages/Activate.tsx`).
- **Two-step sign-in (MFA):** one `mfa_factors` row per user with `method` `TOTP` (encrypted `secretEnc`) or `SMS` (`phone`, E.164). Required when the role needs it (`mfaRequiredFor`: Admin, Auditor) **or** `users.mfaRequired` (set by an admin; turning it on ends the user's sessions). Login returns `mfaSetupRequired` (choose app via `/auth/mfa/setup` or SMS via `/auth/mfa/sms/setup { phone }`, then `/auth/mfa/confirm`) or `mfaRequired` with `method` / `phoneHint`. SMS codes (`mfa_sms_codes`, hash only): 6 digits, 10 min, 5 tries, newest only, max 5 an hour; "send a new code" (`/auth/mfa/sms/resend`) is limited to one a minute. Recovery codes work for both methods. Changing method/phone = admin "Reset two-step sign-in", then enrol again. Web: `components/MfaEnrol.tsx` (used on Login and Account).
- **Internal vs external signers** (Prepare → Signers): *Internal* lists staff with the Signer role (`GET /api/users/directory?signers=1`, includes PENDING with `pending: true`) or adds a colleague (`POST /api/users/signers`, ADMIN/SENDER): a PENDING account with the Signer role only, plus the activation email; optional `INTERNAL_EMAIL_DOMAINS` limits the domains senders may use. *External* is name + email (link + emailed code). A recipient is internal when their email matches an ACTIVE or PENDING account. **Staff never use emailed codes:** a recipient with an account (`userId`) is invited with a link to `${APP_URL}/documents/:id/sign` (no link token is issued; `data.internal = '1'`), which goes through `/login` when signed out (`RequireAuth` keeps `from`) and then opens the document. `/api/sign/:token/code` and `/verify` refuse staff; an older staff link token makes `GET /api/sign/:token` return `staffSignPath` and the web page redirects there. A PENDING internal signer's invitation also carries `activationLink` = `/activate/<token>?next=/documents/:id/sign`; after activation, sign-in continues to the document.
- **Password history:** `password_history` keeps the hashes of each person's last 5 chosen passwords (`auth/password-history.ts`: `isRecentPassword`, `rememberPassword`, which prunes older ones). Password reset and change refuse any of them; activation, reset, change and the seed record the new one. Random unusable hashes (pending accounts, admin reset) are never recorded.
- **Web role guards:** restricted pages are wrapped in `RequireRole` in `apps/web/src/App.tsx` (keep it in step with the nav and `SettingsLayout`); anyone without the role is sent to `/`. `AuthProvider` clears the TanStack Query cache whenever the signed-in user changes, so one person's data never shows for the next; sign-out navigates to `/login` before ending the session.
- SMS is offered unless `NODE_ENV=production` with `SMS_TRANSPORT=console` (`smsAvailable()` in `config.ts`; `GET /api/auth/mfa/options`). In tests, texts land in `app.get(SmsService).testOutbox`.
- The seeded first admin (`SEED_ADMIN_*`) is created ACTIVE and must change password + set up MFA at first sign-in.
- Accounts that existed before activation links (migrations 0005/0006) are ACTIVE, marked activated, and are **not** forced to change their password. Only accounts added afterwards go through activation.
- Drizzle runs all pending migrations in one transaction: a migration must not use an enum value added by an earlier migration in the same batch (PostgreSQL: "unsafe use of new value").
- E2E helper: `activateAndSignIn(app, email)` in `apps/api/test/helpers.ts`.
