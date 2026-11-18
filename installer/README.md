# Cloudlane Installer

The Cloudlane installer is a multi-stage bash script that provisions a fresh Ubuntu 24.04 VPS into a running Cloudlane platform.

## Stages

| Stage | Name | Purpose |
|---|---|---|
| 00 | preflight | Verify OS, RAM, disk, ports, Docker, network, time sync, public IP |
| 01 | prepare_host | Create system users, directories, set permissions |
| 02 | install_docker | Install or reuse Docker Engine 24+ |
| 03 | deploy_postgres | Deploy tuned PostgreSQL 16 container |
| 04 | deploy_api | Pull and start NestJS API |
| 05 | deploy_dashboard | Extract static SvelteKit dashboard |
| 06 | deploy_agent | Pull and start Go agent |
| 07 | deploy_caddy | Install and configure Caddy 2.7+ |
| 08 | deploy_stalwart | Deploy Stalwart Mail |
| 09 | deploy_garage | Deploy Garage object storage |
| 10 | configure_https | ACME short-lived IP certificate issuance |
| 11 | print_claim | Generate and print one-time claim code |
| 12 | finalize | Enable systemd units, write installed.marker |

## Usage (when implemented)

```bash
# Verify the host is ready
sudo bash installer/stages/00_preflight.sh

# Full install (when all stages are wired)
sudo ./cloudlane-installer install --version 0.1.0

# Resume after interruption
sudo ./cloudlane-installer resume

# Diagnose issues
sudo ./cloudlane-installer doctor
```

## State

The installer journal lives at `/var/lib/cloudlane/installer-state.json` and tracks stage completion for idempotent reruns.

## Current status

- Stage 00 (preflight): **implemented**
- Stages 01-12: **stubbed** — implementation in CL-081

See `docs/PHASE_1_2_BUILD_PLAN.md` section 7 for the full stage list and preflight matrix.
