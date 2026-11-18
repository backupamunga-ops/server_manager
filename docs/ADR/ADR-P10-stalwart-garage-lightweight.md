# ADR-P10: Stalwart Mail and Garage Storage as lightweight self-hosted alternatives

**Status:** accepted
**Date:** 2026-11-19
**Owner:** User (project owner) + Cloudlane Agent

## Context

The Cloudlane Master Implementation Guide v2.1 specifies external S3-compatible storage and external email providers for v1, citing resource constraints on the 1 GB starter VPS target (sections 09, 10.6, ADR-009). The project owner wants self-hosted storage on the same VPS and a full self-hosted mail stack including webmail.

The classic self-hosted stacks (MinIO + Postfix + Dovecot + Rspamd) cannot fit on a 1 GB VPS alongside Postgres, NestJS, pg-boss, Caddy, the Go agent, Docker daemon, and application workloads. Total idle RSS would exceed 1.2 GB before any workload runs.

## Decision

Adopt two modern lightweight Rust implementations as the self-hosted stack:

1. **Garage** (https://garagehq.deuxfleurs.fr/) for object storage
   - Rust, S3-compatible, single-binary, LMDB metadata backend
   - Idle RSS ~40 MB, fits the 1 GB budget
   - Same S3 API surface as external providers, so Cloudlane's storage module code is identical to what it would be against external S3
   - Configured in single-node mode for Phase 1+2; multi-node cluster is a future option

2. **Stalwart Mail Server** (https://stalw.art/) for email
   - Rust, all-in-one: SMTP (send + receive), IMAP, JMAP, SPF/DKIM/DMARC, spam filtering in one process
   - Idle RSS ~80 MB
   - Replaces Postfix + Dovecot + Rspamd + OpenDKIM
   - Webmail via Roundcube (PHP-FPM served by Caddy, ~30 MB)

## Alternatives considered

- **MinIO + Postfix + Dovecot + Rspamd** — too heavy, ~400 MB combined idle RSS, would not fit 1 GB target
- **External S3 + external SMTP relay** — explicitly rejected by project owner
- **Mailu** — Docker-based but resource heavy, same problem as classic stack
- **Haraka + IMAP server** — Haraka is Node.js based, less proven for production mail

## Security/resource implications

- Total added idle RSS: ~150 MB (Garage 40 + Stalwart 80 + Roundcube 30)
- Garage in single-node mode is not replicated — data loss possible on disk failure. Phase 5 must add off-server backup of `/var/lib/cloudlane/garage-data/`
- Mail deliverability from fresh VPS IP requires PTR record setup with VPS provider and 2-week warmup before Gmail/Outlook stop spam-foldering
- Stalwart admin API exposed only on internal socket, never publicly
- DKIM private keys stored root-only at `/etc/cloudlane/stalwart/dkim-private.pem`

## Compatibility/migration

- No migration concern — greenfield deployment
- Garage's S3 API is wire-compatible with AWS S3, so a future migration to external S3 (if needed) would only require changing endpoint configuration
- Stalwart uses standard Maildir/mbox storage formats, portable if migration needed

## Acceptance evidence

- Memory budget verified in `docs/PHASE_1_2_BUILD_PLAN.md` section 1.4 (target hardware budget)
- Phase 1+2 acceptance test: all services idle on 1 GB VPS with <800 MB RSS combined (to be validated on first VPS install)
- Phase 5 acceptance test: off-server backup and restore of Garage data directory

## Links

- Task IDs: CL-081 (installer stages 08, 09 deploy Stalwart and Garage)
- Original blueprint: `Cloudlane_Master_Implementation_Guide_v2.1.md` sections 09, 10.6
- User decision: confirmed 2026-11-19 conversation
