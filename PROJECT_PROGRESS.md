# Cloudlane — Verified Project Progress

**Recorded:** 2026-11-19
**Implementation phase:** Phase 0+1+2 — scaffolding and core implementation
**Evidence status:** Active development. Tasks marked `verified` have real commit SHAs and passing tests.

## Milestone status

| Area | Status | Last evidence |
|---|---|---|
| Repository and toolchain | Verified (CL-001) | monorepo + pnpm workspace + CI green (runs 15–22) |
| Contracts package | Verified (CL-003) | `packages/contracts` 5 tests pass |
| NestJS API skeleton | Verified (CL-030/031) | `apps/api` boots, `/health` 200 on deployment VPS |
| Prisma schema v1 | Verified (CL-032) | `apps/api/src/prisma/schema.prisma`, Postgres on VPS |
| SvelteKit dashboard shell | Verified (CL-010/011) | `apps/dashboard` builds; svelte-check 0 errors |
| Design tokens | Verified (CL-006) | `packages/design-tokens` palettes |
| Go agent skeleton | Verified (CL-052) | `agent/` Go tests pass in CI (agent job) |
| Installer preflight | Verified (CL-081) | `installer/stages/00–12` executed on VPS |
| Bootstrap claim + auth | Implemented (CL-080/033–035) | claim/login/MFA flows in API; smoke-tested via session middleware |
| First static ZIP deploy | Implemented (CL-050/051/053) | uploads + deployment state machine + static deploy; `/var/lib/cloudlane/deployments` active |
| GitHub App integration | Not started | Phase 3 |
| Production VPS install | Verified | deployed on VPS: API :3000, agent, Caddy :80/:443, Postgres :5432, Garage S3 :3900 |

## Reconciliation record — 2026-11-19

- VPS working tree (uncommitted build state on top of `8487b99`) committed and pushed as
  `f7ac6e2` — GitHub main was 2 commits ahead (`1e91cdc`, `ebab68a`: installer Ubuntu 26.04,
  MfaService/Prisma fixes already contained in the VPS state); clean overlay, no loss on either side.
- VPS fast-forwarded to the reconciled `main`; pre-reconcile state kept in `stash@{0}` on the VPS.
- Garage object storage repaired: unit mount moved to `/etc/garage.toml` (v1.0.1 path), config
  upgraded to v1.0.1 schema, layout applied (50 GB), buckets `cloudlane-uploads` /
  `cloudlane-deployments` + S3 key `cloudlane-api` created (`4f5203c`, `a454971`, `896b7c4`).
- Verification gates now pass on the reconciled tree (`5cbad30`): `pnpm lint`, `pnpm typecheck`,
  `pnpm test` all exit 0; API rebuilt from committed source and boots on :3000.
- Known deviations documented in commits: CSRF enforcement deferred until HTTPS (session
  middleware), cookie `secure=false` for the HTTP-only deployment, sha256 verified only when
  declared on uploads. Revisit at Phase 2 HTTPS hardening.

## Release gates

- [x] Phase 0 — repo, toolchain, contracts, CI, task-progress gate
- [x] Phase 1 — SvelteKit shell + design tokens + Overview/Projects UI
- [x] Phase 2 — installer + owner claim + IP HTTPS + first static ZIP deploy (HTTPS on IP still
      to be finalized; CSRF/cookie hardening deferred, see reconciliation record)
- [ ] Phase 3 — GitHub dynamic deploys via off-host Actions builds
- [ ] Phase 4 — domains, databases, cron, storage UI, email UI (future)
- [ ] Phase 5 — DeepSeek Assistant, backups, upgrades, hardening (future)

## Update rules

This file is updated only by the integrator after merge with real commit SHAs and test evidence. Per-task detail lives in `tasks/progress/CL-###.md`.

## Resume

1. Read `AGENTS.md`
2. `python3 scripts/taskboard.py list` (once taskboard script is implemented)
3. Fetch latest `git pull origin main`
4. Pick the next unblocked task from `tasks/BACKLOG.md`
