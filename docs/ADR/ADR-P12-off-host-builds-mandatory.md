# ADR-P12: Off-host builds mandatory on 1 GB VPS target

**Status:** accepted
**Date:** 2026-11-19
**Owner:** Cloudlane Agent

## Context

The Cloudlane Master Implementation Guide v2.1 section 04.6 and 07.4 specify that off-server customer builds or prebuilt image deploys may be necessary for the 1 GB VPS target. The guide is permissive ("may be necessary").

Empirically, `npm install` + `npm run build` for a moderate Next.js or NestJS application spikes to 600 MB–1 GB+ RAM. On a 1 GB VPS already running Postgres, NestJS API, pg-boss, Caddy, Go agent, Docker daemon, Stalwart, Garage, and one running application workload (~755 MB idle baseline per the build plan's memory budget), an on-VPS build will OOM every time.

## Decision

Make off-host builds **mandatory** for any application that requires a build step:

- **Static ZIP apps** (HTML/CSS/JS only, no build step): built on VPS by extracting the ZIP and serving via a `caddy:2-alpine` container. Memory cost ~30 MB.
- **Dynamic apps** (Next.js, NestJS, Express with TypeScript, etc.): built via GitHub Actions on GitHub's runners, image pushed to ghcr.io, VPS pulls the prebuilt image. VPS never runs a build.

A `cloudlane-build.yml` GitHub Actions workflow file is provided as part of the platform. Users add it to their app repo. On push, GitHub Actions runs the build, tags the image with the commit SHA, pushes to ghcr.io, and notifies Cloudlane via `repository_dispatch` or direct API callback.

## Alternatives considered

- **On-VPS builds with 2 GB swap** — slow (5-10 minutes per build), unreliable (OOM kills common), wears SSD. Rejected.
- **Bring-your-own-image only** — too restrictive, defeats the "zero-friction deployment" pillar. Rejected.
- **External build service (Cloud Build, CodeBuild)** — adds vendor dependency and cost. GitHub Actions is free for public repos and has 2000 free minutes/month for private repos.

## Security/resource implications

- VPS memory budget preserved: ~245 MB free for workload (per build plan section 1.4)
- GitHub Actions workflow runs in GitHub's sandbox, not on the VPS. No VPS credentials exposed to build environment.
- Image signature verification (cosign) required before agent pulls the image. Prevents supply chain attacks.
- ghcr.io credentials: stored as repository secret `CLOUDLANE_DEPLOY_TOKEN` in user's app repo, never on the VPS in plaintext (the VPS uses a read-only deploy key or a separate pull token stored root-only).

## Compatibility/migration

- ZIP upload path unchanged for static apps
- GitHub App installation flow unchanged; the workflow file is added to user repos as part of the installation
- Future: support on-VPS builds as an opt-in feature for larger VPS profiles (4 GB+)

## Acceptance evidence

- Phase 2 acceptance test: GitHub-sourced app deploy succeeds on 1 GB VPS without OOM
- Memory telemetry during deploy: peak RSS <900 MB
- Image signature verification test: unsigned image rejected by agent

## Links

- Task IDs: CL-053 (static deploy), CL-055 (GitHub App), CL-056 (dynamic runtime via off-host builds)
- Original blueprint: `Cloudlane_Master_Implementation_Guide_v2.1.md` sections 04.6, 07.4
- Build plan: `docs/PHASE_1_2_BUILD_PLAN.md` section 11.2
