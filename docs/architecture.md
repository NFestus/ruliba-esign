# Architecture and decisions

The approved proposal (Claude Doc "Ruliba Clays eSign — Architecture Proposal", 2 Nov 2026) is the source
for the overall design. This file records how it was built and every decision taken while building.

## Layout of the code

```
apps/api          NestJS API + background worker (same code, two entry points)
  src/auth        sign-in, MFA (TOTP), sessions, guards
  src/audit       hash-chained audit log
  src/db          Drizzle schema (the data model) and connection
  src/email       email adapter: Graph, SMTP, console
  src/setup       departments, document types, approval chains, settings
  src/users       staff accounts
  src/documents   upload, signers, fields, sending, routing order, finishing (signed copy)
  src/signing     the public signing flow: link, emailed code, consent, sign, decline
  src/files       encrypted storage, virus scan (ClamAV), Word to PDF (Gotenberg / LibreOffice)
  src/pdf         PDF safety check and stamping
  src/reference   RCL/<DEPT>/<TYPE>/<YEAR>/<NNNN> numbers
  drizzle/        SQL migrations, applied in order (reviewed SQL, committed)
  test/           end-to-end tests against a real PostgreSQL
apps/web          React PWA (Vite)
packages/shared   validation rules, roles, password rule, reference format (used by both)
infra/            Caddy, PostgreSQL roles, backup script
docs/             this file, ERD, OpenAPI, deployment guide
```

## Request path

Browser → Caddy (HTTPS, security headers, static files) → API (`/api/*`) → PostgreSQL / Redis.
Slow work (email now; conversion, scanning and sealing later) goes through a Redis queue to the worker.
Only the API and worker hold database credentials, the master key and (later) signing keys.

## Decision log

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2 Nov 2026 | NestJS + TypeScript, React PWA, PostgreSQL 16 | Approved stack. One language end to end for a single maintainer; matches the ERP's Node.js. |
| 2 | 2 Nov 2026 | **Drizzle ORM instead of Prisma** (proposal said Prisma) | Prisma downloads engine binaries from its own servers at install and build time. A Rwandan data centre with restricted outbound internet would break builds. Drizzle is pure TypeScript, writes plain SQL migrations you can read and review, and its queries read like SQL. |
| 3 | 2 Nov 2026 | **Own TOTP code (RFC 6238) instead of the otplib library** | otplib v12 is deprecated. TOTP is ~40 lines using Node's built-in crypto, and is tested against the official RFC 4226/6238 test vectors. One less third-party package in the sign-in path. |
| 4 | 2 Nov 2026 | Approval threshold lives on the chain step ("only when the value is above"), currency is one setting | Storing the Managing Director threshold in two places (a setting and the chain) would let them disagree. |
| 5 | 2 Nov 2026 | Managing Director step seeded with threshold 0 | The amount is not decided. 0 sends every supply contract to the MD (safe failure) and the Approvals page shows a warning until it is set. |
| 6 | 2 Nov 2026 | Temporary passwords shown once to the admin, never emailed; user must change at first sign-in | Email is not a safe channel for passwords. |
| 7 | 2 Nov 2026 | MFA required for Administrator and Auditor, optional for others in the pilot | Those roles can change who has access or read everything. Turning it on for all is one line in `packages/shared/src/roles.ts`. |
| 8 | 2 Nov 2026 | Access token in memory, refresh token in an HttpOnly SameSite=Strict cookie, rotated on every use, with re-use detection | A stolen refresh token is detected the first time either party uses an old one, and the whole sign-in is ended. |
| 9 | 2 Nov 2026 | Audit log: append-only by trigger, by database role, and by hash chain | Three independent locks: the trigger stops accidental edits, the app role cannot alter tables, and the chain exposes anyone who bypasses both (tested). |
| 10 | 2 Nov 2026 | Two database roles: `esign_owner` (migrations) and `esign_app` (running service) | The running app cannot drop triggers, alter tables, or edit audit rows even if it is compromised (tested). |
| 11 | 2 Nov 2026 | Reference numbers from one `INSERT … ON CONFLICT DO UPDATE` inside the approval transaction | No duplicates under concurrency (tested with 25 at once), no gaps when an approval fails. |
| 12 | 2 Nov 2026 | Per-file data keys wrapped by a master key (AES-256-GCM), bound to the storage key | Master-key rotation re-wraps small keys only; a file cannot be swapped for another one without detection. |
| 13 | 2 Nov 2026 | Caddy instead of Nginx | Automatic TLS certificates and renewals, simpler config for a single maintainer. |
| 14 | 2 Nov 2026 | Docker networks: database, Redis and converters have no internet route | Limits what a compromised container can reach. Only the worker (email) and ClamAV (updates) can go out. |
| 15 | 2 Nov 2026 | Jest for API tests (proposal said Vitest) | NestJS decorators need TypeScript metadata that Vitest's default compiler does not emit; Jest is Nest's standard. Web and shared use Vitest. |
| 16 | 2 Nov 2026 | Official Ruliba logo (supplied 2 Nov) used for the app, the installed-app icon and emails | Replaced the placeholder. |
| 17 | 2 Nov 2026 | **Encrypted files on a local volume instead of MinIO** | One server, one less service to run, secure and back up. The brief allows "S3-compatible or local encrypted storage". Each file is encrypted with its own key before it touches the disk. `StorageService` is the only place that knows where files live, so an S3 adapter can replace it later. |
| 18 | 2 Nov 2026 | Preparation steps are Signers → Fields → Send (the reference screens put Fields first) | A field must belong to someone, so people are added first. This avoids the "add a signer" form hidden inside the field editor. |
| 19 | 2 Nov 2026 | Field positions stored as fractions of the page as shown, mapped back for all four page rotations | Works on any screen size. Verified by stamping and rendering rotated test pages. |
| 20 | 2 Nov 2026 | Staff who are signed in sign from the dashboard without an emailed code | Their sign-in (with two-step for admins and auditors) already proves who they are. The signing record says which method was used for each person. |
| 21 | 2 Nov 2026 | Emails are queued only after the database change is committed (outbox) | Nobody is invited to a change that was rolled back. |
| 22 | 2 Nov 2026 | Email attachments refer to the stored file; the worker decrypts it when sending | No copy of a signed contract sits in Redis. Sent jobs are removed from Redis at once because they contain signing links. |
| 23 | 2 Nov 2026 | Reference number issued when a document is sent (Phase 1) | Approvals arrive in Phase 2; the number then moves to final approval, as agreed. |
| 24 | 2 Nov 2026 | Signed copy (stamped fields + signing record) in Phase 1; digital seal in Phase 3 | Makes signing usable now. The signed file's fingerprint is in the audit log from day one, so Phase 3 sealing adds to the evidence rather than replacing it. |
| 25 | 2 Nov 2026 | PDFs with scripts, launch actions, attachments or XFA forms are refused; every object is inspected | A signer must see exactly what is signed, and a PDF must not run code on anyone's computer. |
| 26 | 2 Nov 2026 | Signing tokens are blanked out of the Caddy access log | The link is the key to a signing session; logs are kept longer and read by more people. |
| 27 | 2 Nov 2026 | Approvers are recipients with role APPROVER, run before the signers; reference number given at the last approval | One routing engine for approvals and signing; numbers are used only by documents that really go out, as agreed |
| 28 | 2 Nov 2026 | The most specific approval chain wins (type + department, then type, then all types); a step can apply only above an amount | Matches "Procurement Manager → Finance Director, plus Managing Director above a threshold" without code changes when amounts or people change |
| 29 | 2 Nov 2026 | "Return for changes" sends the document back to draft and removes the approvers | The sender corrects and resends; approval starts again on the corrected version, so nobody approves a document that changed after they saw it |
| 30 | 2 Nov 2026 | Templates store their own encrypted copy of the PDF and role names, not people | Changing or deleting the original document never changes a template; a template creates an ordinary draft that is checked before sending |
| 31 | 2 Nov 2026 | Reminders and expiry run hourly in the worker; nightly the audit chain is checked and its fingerprint emailed to an independent mailbox | Someone who could rewrite the database still cannot rewrite emails already in another mailbox |
| 32 | 2 Nov 2026 | Ruliba's own certificate authority and organisation seal (RSA-3072, PKCS#7 detached, SHA-256), keys encrypted with the master key | Every completed file shows any later change in a PDF reader. No licensed Rwandan CA issues certificates to companies yet; a GovCA level can be added beside it |
| 33 | 2 Nov 2026 | Separate certificate of completion, also sealed | Can be filed or sent on its own, without the contract |
| 34 | 2 Nov 2026 | Public "Check a document" compares the file's SHA-256 with stored fingerprints; the file is not stored | Third parties can confirm a copy without an account or trusting Ruliba's certificate; returns only what the holder of the file can already read |
| 35 | 2 Nov 2026 | Retention: a review list and a manual "delete files" with a reason; never automatic | Deletion is irreversible and may conflict with a dispute or legal hold; the record and fingerprints stay as proof that signing happened |
| 36 | 2 Nov 2026 | The signing record says whether a staff signer's sign-in used two-step verification or only a password | The evidence must claim only what actually happened |
| 39 | 3 Nov 2026 | Stamp field: staff choose only from stamps the administrator assigned them; outside signers upload their own; each document keeps its own copy of the stamp image | Mirrors control of the physical stamp; a later change to the stamp library cannot alter a signed document; the record names the stamp and its fingerprint |
| 40 | 3 Nov 2026 | Folders are personal (one folder per document per person) and never affect access | Each person organises their own view without exposing documents to anyone, and without the risk of shared folders becoming a back door to contracts |
| 38 | 3 Nov 2026 | Document emails show "<sender> via Ruliba eSign" with Reply-To the sender; the address is always sign@ruliba.com | Recipients recognise who is asking and can reply to them, while SPF/DKIM/DMARC still pass for one sending address. The name is stripped of quotes, brackets and line breaks so it cannot alter headers |
| 37 | 2 Nov 2026 | CSV export neutralises cells starting with = + - @ | Prevents formula injection when the export is opened in Excel |
| 38 | 8 Nov 2026 | New users are created PENDING and activate from a one-use emailed link where they choose their password (replaces decision 6 for new users; admin password reset still uses a temporary password) | No password travels by email or through the admin; only a SHA-256 of the link token is stored, it expires (`ACTIVATION_TOKEN_TTL_HOURS`) and a resend invalidates older links. |
| 39 | 8 Nov 2026 | Password reset by emailed one-use link (self-service "Forgot your password?" and the admin reset); temporary passwords removed | Same reasoning as activation: no password passes through email or an administrator. The forgot form answers the same for every email so it cannot list staff. Reset links share the `activation_tokens` table (`purpose` column). |
| 40 | 8 Nov 2026 | Two-step sign-in by authenticator app **or SMS**; administrators can require it per user (`users.mfa_required`) | Not everyone has a smartphone. SMS is weaker (SIM swap), so the app stays the recommended choice and SMS is offered in production only when a provider (Africa's Talking or Twilio) is configured. Texts go through the worker queue, like email, because only the worker can reach the internet. |
| 41 | 8 Nov 2026 | Last 5 passwords cannot be reused (reset and change); restricted web pages are guarded by role and the browser's data cache is cleared when the signed-in person changes | Stops cycling back to a password that may have leaked. The server already refused other people's data, but the web app could show a page, and data cached for the previous person, to the next person on a shared computer. |
| 42 | 8 Nov 2026 | Signers are chosen as Internal (staff with the Signer role, or a new colleague added by the sender) or External; a sender may create Signer-only accounts, which must be activated before signing | Staff sign with their own account and its two-step sign-in, which is stronger evidence than an emailed code. Letting senders add colleagues avoids waiting for IT; limiting it to the Signer role and to `INTERNAL_EMAIL_DOMAINS` keeps them from granting any other access. |
| 43 | 8 Nov 2026 | Ruliba staff are invited with a link into eSign (sign in, then the document); emailed one-time codes are for people outside Ruliba only | A staff sign-in (password plus two-step sign-in where set up) is stronger evidence than a code sent to the same mailbox, and staff keep one way of signing. Older staff link tokens redirect into eSign; codes are refused for them. |

## Security controls (OWASP Top 10, 2021)

| Risk | Control | Test |
|---|---|---|
| A01 Broken access control | Global guard: every route needs a token unless `@Public()`; `@Roles()` per route; admins cannot remove the last admin | `admin.e2e-spec.ts` |
| A02 Cryptographic failures | Argon2id passwords; AES-256-GCM at rest; SHA-256 token hashes; TLS via Caddy + HSTS | `crypto.spec.ts` |
| A03 Injection | Parameterised queries only (Drizzle); zod validation of every body; LIKE patterns escaped | e2e input tests |
| A04 Insecure design | Lock-out after 5 tries; MFA; temporary passwords; sessions ended on role change | `auth.e2e-spec.ts` |
| A05 Misconfiguration | App refuses to start with weak/missing secrets or console email in production; strict CSP; no `X-Powered-By` | config validation |
| A06 Vulnerable components | `npm audit` and Trivy image scan in CI; few dependencies (no Prisma engines, no otplib) | CI |
| A07 Authentication failures | Same message for wrong email and wrong password (and same timing); TOTP replay blocked; refresh-token re-use detection | `auth.e2e-spec.ts` |
| A08 Integrity failures | Hash-chained audit log; migrations reviewed in Git; CI checks schema and migrations match | `admin.e2e-spec.ts`, CI |
| A09 Logging failures | Every sign-in, failure, admin change and setting change is in the audit log with IP and device | e2e |
| A10 SSRF | API makes no outbound requests from user input; only the worker calls the fixed Graph/SMTP host | design |

## Limits and later work

Everything in Phases 0 to 3 is built. Not built, in suggested order: trusted time-stamps (RFC 3161) on seals; GovCA / national PKI certificates as a higher signature level; point-in-time database recovery (pgBackRest); SMS codes for outside signers; archive search by value range; Kinyarwanda and French interface. See [handover.md](handover.md) section 7 for these and for the items that need people or production access (lawyer review, penetration test, production server).
