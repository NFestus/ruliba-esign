# Handover document

For the maintainers of Ruliba Clays eSign. Owner: **[NAME]**. Backup: **[NAME]**. Code: Ruliba-owned Git repository **[REPOSITORY URL]**.

Read this first, then [architecture.md](architecture.md) (how it is built and why) and [deployment.md](deployment.md) (how it runs).

## 1. What the system is

A web app (installable on phones) where Ruliba staff send documents for internal approval and for signature by staff and outside parties, and where everyone gets a sealed, signed PDF with a full record. Business process and screens: [user-guide.md](user-guide.md), [admin-guide.md](admin-guide.md).

| Phase | Delivered |
|---|---|
| 0 | Sign-in with password and authenticator app, roles, departments, document types, reference numbers, hash-chained activity log, email (SMTP now, Microsoft Graph later) |
| 1 | Upload (PDF, Word converted), malware scan, fields, signers in order or at once, emailed link and one-time code, consent, signing, decline, cancel, signed copy with signing record |
| 2 | Approval chains with value threshold, reference number at final approval, templates, reminders, expiry, in-app notifications, department visibility for approvers, filters |
| 3 | Digital seal (Ruliba authority and seal certificate), certificate of completion, public check page, reports and CSV export, retention review and file deletion, nightly audit anchor email |

## 2. Where things are

| Thing | Where |
|---|---|
| API (NestJS, TypeScript) | `apps/api/src` (one folder per area: auth, documents, signing, pdf, email, files, audit, reports, verify, setup, users) |
| Background worker | `apps/api/src/worker.ts`: email sending, finishing documents, reminders, expiry, nightly audit check |
| Web app (React) | `apps/web/src` (pages, components, labels.ts holds every status and event wording) |
| Shared rules and validation | `packages/shared/src` (used by both API and web) |
| Database schema | `apps/api/src/db/schema.ts`; SQL migrations in `apps/api/drizzle/` |
| Tests | `apps/api/test/*.e2e-spec.ts`, `apps/api/src/**/*.spec.ts`, `packages/shared`, `apps/web` |
| Infrastructure | `compose.yml`, `Dockerfile`, `infra/` (Caddy, Postgres roles, backup script) |
| API specification | `docs/openapi.yaml` |

## 3. Daily commands

```bash
npm install
npm run build -w packages/shared && npm run build -w apps/api
npm test                                    # everything; needs PostgreSQL and Redis
npm run lint -w apps/api                    # type-check
npm run db:generate -w apps/api             # after changing schema.ts: makes a new migration; review the SQL
docker compose build && docker compose run --rm migrate && docker compose up -d   # release
```

Every change goes through a pull request; CI runs the tests, type-checks, `npm audit` and an image scan. Do not merge with red CI.

## 4. Things you must not break

1. **The activity log is append-only.** Never `UPDATE` or `DELETE` `audit_events`, never switch the trigger off, never "fix" a row. The app's database user cannot; keep it that way (`infra/postgres/init/10-roles.sh`).
2. **A sent document never changes.** Files are fingerprinted at upload and checked before sending, signing and finishing. Any feature that edits a sent document is wrong; cancel and resend instead.
3. **Keys.** `MASTER_KEY` decrypts every file, signature image, two-step secret and the seal's private key. Losing it loses everything, backups included. Custody: deployment guide section 5.
4. **Evidence wording.** The signing record states how each person was identified. It must only claim what actually happened (e.g. "with password" vs "with two-step code"). Keep that honesty when changing it.
5. **Excluded documents.** Document types with "May be signed electronically" off must stay refused at upload and at sending.
6. **Signing links** are secrets: only their hash is stored; they are blanked out of logs. Do not log request URLs under `/sign/`.

## 5. How a document moves

```
DRAFT --send--> PENDING_APPROVAL --last approval--> IN_PROGRESS --all signed--> COMPLETED
   ^                 | return for changes               | decline -> DECLINED
   +-----------------+                                  | cancel  -> VOIDED
                                                        | expiry  -> EXPIRED
```

- `routing.service.ts` decides who is next (approvers first, then signer steps) and queues emails after the database commit.
- `finalizer.service.ts` stamps fields, adds the signing record, seals the PDF, makes the certificate, and emails everyone. If it fails, the worker retries every 5 minutes.
- `seal.service.ts` creates the authority and seal certificates on first use and signs PDFs (PKCS#7, SHA-256).

## 6. Operations calendar

| When | What | Who |
|---|---|---|
| Daily | Health check alert (`/api/health`), disk space | Monitoring |
| Nightly 02:15 | Audit chain check + fingerprint email to `AUDIT_ANCHOR_EMAIL` | Automatic; read the email |
| Monthly | Apply security updates (`npm audit`, base images), release via PR | Owner |
| Quarterly | Restore test from the server-room backup; record it | Owner or backup |
| Yearly | Microsoft Graph client secret renewal; penetration/security review; lawyer review of consent text and excluded documents | Owner, IT, Legal |
| 2029 (3 years after first seal) | Seal certificate renews itself; tell Legal | Automatic |
| 2036 (10 years) | New authority: re-install its certificate on all PCs | Owner |

## 7. Open items and limits (what was not done)

These need a person, a contract or production access, and were not possible while building:

| Item | Why it matters | Owner |
|---|---|---|
| Lawyer review of the consent text (`CONSENT_VERSION 2026-11-v1-draft` in `packages/shared/src/documents.ts`), signing record wording, and the excluded-document list | Evidence must hold up in a Rwandan court; Law 18/2010 and Law 058/2021 | Legal |
| Penetration test by an outside firm | Required before going live | IT |
| Production server in a Rwandan data centre, DNS `esign.ruliba.com`, TLS | Not set up yet | IT |
| Build and scan the Docker images on the real server (Docker Hub was not reachable while building) | Images were validated but not built | Owner |
| SPF, DKIM, DMARC for ruliba.com; Graph app registration after the tenant migration | Invitations must not land in spam | IT |
| Managing Director threshold amount; document types that skip approval | Business decision, left as placeholders | Management |
| Data protection: register processing with NCSA if required; privacy notice for signers | Law 058/2021 | Legal / DPO |
| Retention years for each document type | Drives the retention review | Legal / Records |
| Install the authority certificate on Ruliba PCs (group policy) | So Adobe Reader shows the seal as trusted | IT |
| Two-step sign-in for Senders and Approvers | Optional today; recommended | Management decision |

**Later improvements** (not built, in suggested order):

1. **Trusted time-stamps** (RFC 3161) on each seal, so PDF readers keep showing old seals as valid after the seal certificate expires.
2. **GovCA / national PKI certificates** as a higher signature level, once RISA issues them to companies.
3. **Point-in-time database recovery** (pgBackRest with WAL archiving), on top of nightly backups.
4. **SMS one-time codes** for outside signers without reliable email.
5. **Archive search** across completed documents by supplier, value range and reference (the list search covers title, supplier and reference today).
6. Kinyarwanda and French interface text (`labels.ts` and the page texts).
7. **Android and iOS store apps.** The web app is already installable (account menu → Install eSign app) and works on phones. For store apps, wrap the same web app with Capacitor (`apps/mobile`), add push notifications and biometric unlock; the API needs no change.

## 8. People to call

| Need | Contact |
|---|---|
| Business owner of the process | [NAME], Procurement |
| Approval chain changes | [NAME], Finance |
| Server, network, backups | [NAME], IT office |
| Microsoft 365 / Graph | [NAME] |
| Data-centre provider | [PROVIDER, CONTACT] |
| Lawyer | [NAME, FIRM] |
