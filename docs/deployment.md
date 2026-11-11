# Deployment guide

For the person installing and running eSign at Ruliba Clays. Commands are run on the server as root
unless stated. Phase 0 version: draft, to be completed with Phase 1 (file storage) and Phase 3 (sealing keys).

## 1. Environments

| | Development | Test | Production |
|---|---|---|---|
| Where | Developer laptop | Small VM in Rwanda | VM in a Rwandan data centre |
| Data | Fake | Fake, test mailbox | Real |
| Email | Console or Mailpit | SMTP/Graph to a test mailbox | Graph from sign@ruliba.com |
| Domain | localhost | esign-test.ruliba.com | esign.ruliba.com |

## 2. Server

- Ubuntu 24.04 LTS, 4 vCPU, 8 GB RAM, 200 GB **encrypted** disk (ask the provider for encrypted volumes, or use LUKS).
- Open ports 80 and 443 only. SSH only from Ruliba's office IP or VPN, with keys, no passwords.
- Install Docker Engine and the Compose plugin from Docker's own apt repository.
- Install `age` for backups: `apt install age`.
- Time sync: `timedatectl set-ntp true`. Signing times depend on a correct clock.
- Automatic security updates: `apt install unattended-upgrades`.

## 3. DNS and TLS

Point `esign.ruliba.com` (A record) at the server. Caddy obtains and renews the certificate itself.
For an intranet-only name, set `TLS_MODE=internal` and install Caddy's root certificate on staff PCs
(not suitable for external signers, who must reach the site from the internet).

## 4. First installation

```bash
git clone <ruliba-repository> /opt/ruliba-esign && cd /opt/ruliba-esign
cp .env.example .env && chmod 600 .env
# Fill every value. Generate secrets:
openssl rand -hex 24      # each of DB_OWNER_PASSWORD, DB_APP_PASSWORD, REDIS_PASSWORD (hex: they go inside connection URLs)
openssl rand -base64 48   # each of JWT_ACCESS_SECRET, JWT_MFA_SECRET, JWT_SIGN_SECRET
openssl rand -base64 32   # MASTER_KEY
docker compose build
docker compose up -d postgres redis clamav gotenberg   # creates the two database roles on first start
# ClamAV downloads its virus signatures on first start (a few minutes). Uploads are refused until it is ready.
docker compose run --rm migrate               # creates the tables (later, `up` runs this by itself)
docker compose run --rm seed                  # departments, document types, approval chain, first admin
docker compose up -d                          # runs the migrations again (nothing to do), then starts everything
```

Use `openssl rand -hex` for the database and Redis passwords: base64 output can contain `/`, `+` and `=`,
which break the `postgresql://…` and `redis://…` addresses built from them. Set them **before the first
start**: PostgreSQL fixes the passwords when its volume is first created.

Then remove `SEED_ADMIN_PASSWORD` from `.env`. The first administrator signs in, sets up the
authenticator app, and replaces the seed password.

## 4a. Installing with Dokploy

Use `compose.dokploy.yml` instead of `compose.yml`. Dokploy's own Traefik owns ports 80 and 443 and handles
the domain and the HTTPS certificate; Caddy runs behind it on plain HTTP (`infra/caddy/Caddyfile.dokploy`)
and still adds the security headers, serves the web app and passes `/api` to the API.

1. **Server:** as in section 2 (Ubuntu, 4 vCPU, 8 GB RAM at least: ClamAV alone uses about 1.5–3 GB). Install Dokploy.
   Open ports 80 and 443 (and Dokploy's admin port only from Ruliba's office or VPN).
2. **DNS:** an A record for `esign.ruliba.com` pointing at the server.
3. **Dokploy → Create service → Compose:** repository `NFestus/ruliba-esign` (connect GitHub or add a deploy key),
   branch `main`, compose path **`./compose.dokploy.yml`**.
4. **Environment tab:** paste the variables from `.env.example` and fill every value (secrets as in section 4,
   `openssl rand -hex 24` for the three passwords). Include `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME` and
   `SEED_ADMIN_PASSWORD` for the first deploy. `TLS_MODE` and `ACME_EMAIL` are not used under Dokploy.
5. **Domains tab:** add `esign.ruliba.com` on service **`caddy`**, container port **80**, HTTPS on, certificate Let's Encrypt.
   `DOMAIN` in the environment must be the same name (it builds the links in emails).
6. **Deploy.** Every deploy builds the images, runs the migrations and the seed (both safe to repeat), then starts
   the API, worker and Caddy. ClamAV needs a few minutes on its first start before uploads work.
7. After the first administrator has signed in, remove `SEED_ADMIN_PASSWORD` from the environment and redeploy.
8. **Traefik access logs:** links for outside signers carry a secret token in the path (`/sign/<token>`). Caddy hides
   it in its own log, but if Traefik's access log is switched on in Dokploy, it is written there. Switch the access
   log off, or filter `/sign/` paths, in Dokploy's Traefik settings.
9. **Backups:** Dokploy names the project after the app (containers `<app-name>-postgres-1`, volumes
   `<app-name>_pg_data` and `<app-name>_files_data`). Copy `infra/backup/backup.sh` to e.g. `/opt/esign-backup/` and
   run it from cron with `COMPOSE_PROJECT=<app-name>` (section 7). Dokploy's own volume backups can be used as well.

The client IP chain is Traefik → Caddy → API, so `compose.dokploy.yml` sets `TRUST_PROXY: 2`. Do not change it:
with the wrong value every request looks as if it came from Traefik, which breaks the IP addresses in the
activity log and makes all staff share one sign-in rate limit.

## 5. Keys (the most important section)

`MASTER_KEY` encrypts every stored document, signature image and MFA secret (files live in the `files_data` volume, each encrypted with its own key). **If it is lost, the data cannot be read**, and backups cannot be restored either.

- Write it to two encrypted USB keys. One goes in the IT office safe. The other is sealed in an envelope held by management.
- Never put it in Git, email or chat.
- The digital seal's private keys are stored in the database, encrypted with `MASTER_KEY`. They are protected by the same custody; there is no separate key file.

## 6. Email

**Until the ruliba.com tenant migration finishes:** `EMAIL_TRANSPORT=smtp` with any SMTP relay that uses TLS on port 587.

**After the migration** (Microsoft Graph, mailbox sign@ruliba.com):

1. Create the shared mailbox `sign@ruliba.com` in the new tenant.
2. Entra admin centre → App registrations → New: "Ruliba eSign mail". Single tenant.
3. API permissions → Microsoft Graph → **Application** permission `Mail.Send` → Grant admin consent.
4. Certificates & secrets → New client secret (12-month expiry; put a renewal reminder in the IT calendar).
5. **Restrict the app to that one mailbox.** Without this, it could send as anyone in the tenant.
   Use Exchange Online RBAC for Applications (current Microsoft method) or an application access policy:
   ```powershell
   New-DistributionGroup -Name "eSign senders" -Type Security -Members sign@ruliba.com
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId "eSign senders" -AccessRight RestrictAccess -Description "eSign may send only as sign@ruliba.com"
   ```
   Check Microsoft's current documentation before running these commands, because Microsoft is replacing application access policies with RBAC for Applications.
6. In `.env`: `EMAIL_TRANSPORT=graph`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SENDER=sign@ruliba.com`. Then `docker compose up -d worker`.

**Sender name.** Every email is sent from the one address in `EMAIL_FROM` / `GRAPH_SENDER` (sign@ruliba.com). Emails about a document (invitations, approval requests, completed, cancelled, expired) show the staff sender's name, e.g. "Grace Uwase via Ruliba eSign <sign@ruliba.com>", with **Reply-To set to Grace's own address**, so a supplier who replies reaches her. One-time codes and account emails show "Ruliba Clays eSign". If emails arrive from another address, the mail server is rewriting it: use `SMTP_USER=sign@ruliba.com` (or give the SMTP account "Send As" on sign@ruliba.com); Gmail and personal accounts always replace the From. With Graph, Exchange may show the mailbox's own display name instead of "… via Ruliba eSign"; Reply-To still works.

**Keeping eSign mail out of spam (do all of these before the pilot):**

1. **SPF:** TXT on `ruliba.com`: `v=spf1 include:spf.protection.outlook.com -all`. Only one SPF record may exist; merge into it. While still sending through another SMTP service, add that service's include as well.
2. **DKIM:** Microsoft Defender → Email & collaboration → Policies → Email authentication settings → DKIM → ruliba.com: create the two `selector1/selector2._domainkey` CNAMEs it shows, then Enable.
3. **DMARC:** TXT on `_dmarc.ruliba.com`: `v=DMARC1; p=none; rua=mailto:dmarc-reports@ruliba.com`. After 2–4 weeks of clean reports, change to `p=quarantine`.
4. Run `check-email-dns.bat` (repository root) on any Windows PC: it saves the current records to `email-dns-check.txt`.
5. **Settings → Email → Send test email** to a Gmail and an Outlook.com address. In Gmail "Show original", SPF, DKIM and DMARC must all say PASS. A free score is also available by sending the test to the address given on mail-tester.com.
6. The app already: sends from one address (sign@ruliba.com) with a plain-text version of every email, greets the mail server as `esign.ruliba.com`, links only to its own address, marks mail as automatic (no out-of-office replies) and puts the staff sender in Reply-To.

No setting can promise every inbox, but with SPF, DKIM and DMARC passing from the real ruliba.com mailbox, transactional mail like this normally lands in the inbox. Watch the DMARC reports during the pilot. Invitations that land in spam break signing.

## 6a. Text messages (SMS) for two-step sign-in

Optional. With `SMS_TRANSPORT=console` (the default) production offers only authenticator apps. To offer codes by text message, set in `.env`, then `docker compose up -d api worker`:

- **Africa's Talking** (common in Rwanda): `SMS_TRANSPORT=africastalking`, `AT_USERNAME`, `AT_API_KEY`, and `AT_SENDER_ID` if you registered a sender name (e.g. RULIBA). Username `sandbox` uses their test environment.
- **Twilio:** `SMS_TRANSPORT=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (a Twilio number or an approved sender name).

Texts are sent by the worker (the only container with internet access), with up to 3 quick retries. Failures appear in `docker compose logs worker`. Codes work for 10 minutes and 5 tries; a person gets at most 5 codes an hour. An authenticator app remains the safer choice (SMS can be redirected by SIM swap), so present SMS as the fallback for people without a smartphone.

## 7. Backups

- Generate a backup key pair **on an office PC, not the server**: `age-keygen -o esign-backup.key`.
  Store the private key with the master key (section 5). Copy only the public key line to the server at `/etc/esign/backup-recipient.txt`.
- On the server-room machine, create a user `esign-backup` that can receive files over SSH (rsync) and nothing else.
- Set `REMOTE` in `infra/backup/backup.sh`, then add the cron line shown at the top of that script.
  The script finds the containers by Docker Compose project name: `ruliba-esign` with `compose.yml`,
  or the app name under Dokploy (`COMPOSE_PROJECT=<app-name>`).
- **Restore test, every quarter** (record each one in the IT log):
  ```bash
  age -d -i esign-backup.key db_<date>.dump.age > db.dump
  docker compose -f compose.yml -p esign-restore up -d postgres
  docker compose -p esign-restore exec -T postgres pg_restore -U esign_owner -d esign --clean < db.dump
  ```
  Then sign in to the restored copy on the Test server, and run Settings → Activity log → "Check the log now".

## 7a. Services added in Phase 1

| Service | Purpose | Notes |
|---|---|---|
| `clamav` | Scans every upload | Needs internet access for signature updates (the `egress` network). Uses about 1.5 GB of RAM. The API refuses to start in production without it. |
| `gotenberg` | Word to PDF | No internet access. JavaScript in documents is switched off. |
| `files_data` volume | Encrypted document files | Backed up nightly by `infra/backup/backup.sh`. |

Add `JWT_SIGN_SECRET` to `.env` (`openssl rand -base64 48`). It signs the 60-minute signing sessions.

## 7b. Added in Phases 2 and 3

| Setting or task | Notes |
|---|---|
| `AUDIT_ANCHOR_EMAIL` | Mailbox outside IT's control (e.g. the Finance Director) that receives the activity-log fingerprint every night. Keep those emails. |
| Worker schedules | Reminders hourly at :00, expiry at :05, finishing stuck documents every 5 minutes, audit check 02:15 Kigali time. Nothing to configure; the worker must be running. |
| Public check page | `https://esign.ruliba.com/check` and `POST /api/verify` work without sign-in. They are rate limited (10 checks a minute per IP address) and accept PDFs up to 30 MB. |
| Digital seal | Created automatically when the first document completes. Then download the authority certificate (Settings → Digital seal) and push it to Ruliba PCs as a trusted root in Adobe Reader (admin guide section 6). Record its fingerprint. |
| Migration `0003_phase2_3.sql` | Applied automatically by the `migrate` service at `docker compose up`, like the others. |

## 8. Updating

```bash
cd /opt/ruliba-esign && git pull
export VERSION=<new version>
docker compose build && docker compose up -d   # the migrate service runs first
```

Under Dokploy: push to `main` and press **Deploy** (or turn on auto-deploy); migrations run on every deploy.

To roll back, set `VERSION` to the previous version and run `docker compose up -d`. Migrations only add things, so the previous version keeps working on the newer database. A release that needs a breaking change will say so in its notes.

## 9. Image pinning

For production, pin `node`, `caddy`, `postgres` and `redis` images to a digest (`image@sha256:…`) after each tested update. Then a re-build cannot silently pull a different image.

## 10. Monitoring

- `https://esign.ruliba.com/api/health` returns `{"status":"up"}`. Add it to the uptime monitor already used for Ruliba's other services.
- The worker checks the audit chain nightly at 02:15 and emails the fingerprint to `AUDIT_ANCHOR_EMAIL`. A `system.audit_chain_broken` entry in the activity log, or an email saying CHECK FAILED, means stop and investigate.
- Disk space: alert at 80%.
