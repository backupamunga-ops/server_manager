# Cloudlane — Agent & Contributor Guide

This document is the universal safety and working-rules reference for any contributor (human or AI) working on Cloudlane. Read it before writing any code.

## Source of truth

| File | Purpose |
|---|---|
| `docs/00-SOURCE_OF_TRUTH.md` | Locked product decisions and precedence |
| `docs/PHASE_1_2_BUILD_PLAN.md` | Approved Phase 1+2 build plan (v1.0) |
| `tasks/BACKLOG.md` | Stable task IDs, dependencies, acceptance criteria |
| `tasks/progress/CL-###.md` | Canonical per-task progress and handoff |
| `PROJECT_PROGRESS.md` | Verified integrated milestones only |
| `docs/ADR/` | Architecture Decision Records |

Never infer status from conversation. A task is `verified` only when its `tasks/progress/CL-###.md` records a real commit SHA and passing test evidence.

## Hard rules

1. **No demo mode in production builds.** Test fixtures are fine in `tests/` and behind `NODE_ENV=test`. Never ship simulated success in production code.
2. **No credentials in chat, code, or commits.** Secrets live in environment variables, GitHub Actions secrets, or root-protected files on the VPS (`/etc/cloudlane/secrets.env`, mode 0600).
3. **Every mutation goes through the typed agent contract.** The API never shells out to Docker, Caddy, or the host. The agent validates signature, expiry, allowlist, and ownership on every command.
4. **Every state-changing API call writes an audit event.** Allowed and denied.
5. **No host filesystem exposure to user workloads.** Named volumes under `/var/lib/cloudlane/volumes/<id>/` only.
6. **Off-host builds for any app that needs a build step.** On-VPS builds are forbidden by default on the 1 GB target.
7. **Tests must pass before merge.** `pnpm lint && pnpm typecheck && pnpm test` is the minimum gate.
8. **Update `tasks/progress/CL-###.md` for every task you touch.** No silent progress.
9. **No silent deviation from locked ADRs.** Propose a new ADR, get review, then change.

## Commit conventions

- Format: `type(scope): summary` where type is `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`
- Scope is the task ID: `feat(cl-031): add prisma schema for v1`
- Body explains the why, references the task file
- Sign off with `Co-Authored-By: Cloudlane Agent <agent@cloudlane.local>` only if relevant

## Branch conventions

- Main branch: `main` (protected)
- Task branches: `task/CL-XXX-short-label`
- One active branch per task

## Verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @cloudlane/api test:integration
pnpm --filter @cloudlane/tests-e2e test
cd agent && go test ./...
shellcheck installer/**/*.sh
```

## Resume from anywhere

1. `git status --short && git branch --show-current && git log -1 --oneline`
2. Read `PROJECT_PROGRESS.md` and the relevant `tasks/progress/CL-###.md`
3. Run the last recorded verification command
4. Continue from `## Next action` in the task file
