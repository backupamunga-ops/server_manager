# Cloudlane

Self-hosted VPS infrastructure platform. Turn a fresh Ubuntu 24.04 VPS into an application hosting and control platform with guided deployments, resource management, and safe infrastructure controls.

## Status

Active development. Not ready for production install. See `PROJECT_PROGRESS.md` for current state and `docs/PHASE_1_2_BUILD_PLAN.md` for the approved plan.

## Stack

- **Dashboard:** SvelteKit 2 + Svelte 5 (static output via `adapter-static`)
- **API:** NestJS 10 + TypeScript
- **Database:** PostgreSQL 16 + Prisma 5
- **Job queue:** pg-boss 10 (in-process with API)
- **Ingress:** Caddy 2.7+ (ACME short-lived IP certs)
- **Workload runtime:** Docker Engine 24+
- **Server agent:** Go 1.22+
- **Mail:** Stalwart Mail Server
- **Object storage:** Garage (S3-compatible)
- **Webmail:** Roundcube

## Quick start (development)

```bash
# Install dependencies
pnpm install

# Set up environment
cp apps/api/.env.example apps/api/.env
# Edit .env with your local Postgres connection string

# Run database migrations
pnpm prisma:generate
pnpm prisma:migrate

# Start API and dashboard in dev mode
pnpm dev:api
pnpm dev:dashboard
```

## Repository layout

See `docs/PHASE_1_2_BUILD_PLAN.md` section 2 for the full monorepo tree.

## Documentation

- `docs/00-SOURCE_OF_TRUTH.md` — locked product decisions
- `docs/PHASE_1_2_BUILD_PLAN.md` — approved build plan
- `docs/ADR/` — architecture decision records
- `AGENTS.md` — contributor safety and working rules
- `tasks/BACKLOG.md` — task breakdown
- `PROJECT_PROGRESS.md` — verified integrated milestones

## License

UNLICENSED. Proprietary.
