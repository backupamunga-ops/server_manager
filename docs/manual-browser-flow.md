# Manual Browser Walkthrough — Mobile-App Backend on the Platform, Start to Finish

Everything below was performed through the panel UI in a real browser
(headless Chromium), from a fresh start (previous API-built demo fully torn
down). Screenshots referenced here live in `download/walkthrough/`.

Login used a dedicated walkthrough account (`walkthrough@billucsolutions.co.ke`,
role OWNER, TOTP enrolled) so the real login → MFA flow could be exercised
without touching the owner account.

## The flow, exactly as a user experiences it

1. **Sign in** — `server.billucsolutions.co.ke/login` → email + password →
   `Continue`. (`01-login-page.png`, `02-login-filled.png`)
2. **Two-factor** — the platform mandates TOTP for every sign-in: enter the
   6-digit code from the authenticator → `Verify and sign in`. (`03-mfa-screen.png`)
3. **Overview** — workspace dashboard: projects, domains, databases, email,
   cron jobs, activity, server. (`04-workspace.png`)
4. **Projects → New project** — name it (`billu-mobile`); a production
   environment is created automatically. (`05-projects.png` … `08-project-created.png`)
5. **Add service → Application** — the modal offers Application / Database
   (PostgreSQL, MySQL, MariaDB) / Cron Job / Object Storage. Choose
   *Application*. (`09-add-service-modal.png`)
6. **Deploy application form** — choose project, service name, source
   (`Upload ZIP` vs `GitHub`). The ZIP is inspected **locally** — the UI showed
   `2 deployable entries · detected: Node.js` before anything left the laptop.
   Frameworks offered: Static, React/Vite, Next.js, SvelteKit, Nuxt, Angular,
   Astro, Node.js/Express, NestJS, Custom Dockerfile. `Start deployment` runs
   Validate → Detect → Build → Start → Health Check → Activate HTTPS.
   (`10-deploy-form.png`, `11-form-filled.png`)
7. **First build fails honestly** — pipeline events show every stage
   (`13-deployments-tab.png`): ZIP validated → dependencies installed in
   `node:20-alpine` → container started on `127.0.0.1:4137` → health probe.
   Two lessons the failures teach (see §Platform quirks): apps must answer
   `GET /` with 200, and containers resolve service names on the
   `cloudlane-internal` docker network.
8. **Provision MySQL through the UI** — Add service → Database → engine
   `MySQL`, name `app-mysql`, database `appdb` → Running in seconds
   (`14-database-*.png`, `15-database-provisioned.png`). The service page
   shows host `app-mysql.internal`, port 3306, user, encrypted password, and
   an `Open phpMyAdmin` button. (`16-mysql-service.png`)
9. **Wire variables** — app service → Variables tab → Add variable for
   `MYSQL_HOST/PORT/USER/PASSWORD/DB` plus `S3_ENDPOINT=http://cloudlane-garage:3900`,
   `S3_REGION`, `S3_ACCESS_KEY/SECRET_KEY`, `MEDIA_BUCKET=app-media`.
   Values are encrypted at rest. (`18-variables-*.png`, `19-*.png`, `28-variables-complete.png`)
10. **Redeploy** — Deployments tab → `Redeploy`. Health check passes, status
    flips to **Running / Live** and the platform activates HTTPS:
    `https://mobile-backend.apps.billucsolutions.co.ke` with a Let's Encrypt
    certificate. (`21-redeploy-result.png`)
11. **Live verification (from outside the server)** —
    - `/health` → ok · `/db-health` → `db: up, 5ms`
    - `POST /profiles` created Grace Wanjiru (MySQL insert)
    - photo upload → Garage object → download **byte-identical**
    - M-Pesa STK callback accepted, replay deduplicated to one row
12. **Custom domain** — Domains section → Add domain `billucsolutions.co.ke`
    → the platform runs a **live** DNS check (it correctly refused: apex A
    points at tela-host, `198.251.84.236`) → Add subdomain `api` → hostname
    `api.billucsolutions.co.ke` becomes **Available** with a Connect action
    that attaches it to any eligible app (routes + certificate automatic).
    (`30-add-domain.png` … `36-connect-state.png`)

## The one remaining user step

Verify the zone at your DNS host, then finish the connection in the UI:

- **Option A (recommended):** add TXT at tela-host:
  `_cloudlane` → `cloudlane-verify=b21f726725b93be545cd2e812c03d855`,
  then Domains → billucsolutions.co.ke → Verify ownership → Verify DNS now.
- **Option B:** point the apex A record to `95.211.164.33` — NOT recommended
  while your production site lives at tela-host.

After verification: domain → Subdomains → `api.billucsolutions.co.ke` →
Connect → pick `mobile-backend` → `https://api.billucsolutions.co.ke` goes
live with its own certificate.

## Platform quirks found during the walkthrough (fix candidates)

1. **`GET /` must return 200** — the health probe hits `/` only; a valid API
   that 404s on `/` fails deployment. (Fixed in the reference backend.)
2. **First-deploy route race** — `activatePlatformRoutes` waits up to 48s for
   the agent state to reflect the new deployment; if the health check failed
   first and a redeploy reuses the old container, the route never activates.
   Workaround: one more redeploy once the state is fresh.
3. **Redeploy doesn't restart containers** — Deployments-tab `Redeploy` with
   identical source flips the status Live without restarting anything;
   variable changes therefore don't apply. Removing *any* variable fires a
   real rebuild (`variablesRevision`), while *adding* one doesn't —
   inconsistent by design.
4. **Provisioned MySQL user had no grants** — `app_mysql_app@'%'` was created
   with `USAGE` only; `GRANT ALL ON appdb.*` was needed. The UI also shows the
   username as `app_mysql` while the real DB user is `app_mysql_app`.
5. **Database container lacks its advertised DNS name** — `app-mysql.internal`
   only resolves after `docker network connect --alias app-mysql.internal
   cloudlane-internal cl-appdb`. Provisioning should add that alias itself.
6. **Workspace Domains page shows `*.apps.example.test`** — the fallback
   suffix; `PLATFORM_APP_SUFFIX` is set correctly in api.env but the workspace
   record uses the default.

## Reference code

`deploy/mobile-backend/` in the repo (commit `5d8564b`): Express + mysql2 +
`@aws-sdk/client-s3`; binds `0.0.0.0:$PORT`, serves a JSON index on `/`,
`/health` and `/db-health`, idempotent webhook receivers, profile photos
streamed from Garage. Crash-safe: a down database never kills the process —
`/db-health` reports degraded until it returns.
