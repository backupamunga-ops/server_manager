# Drevanta Round 3 — unified theme, mail rework, attachments, mail stack

## What this package contains

| Path | Purpose |
| --- | --- |
| `tools/theme.css` | **The single token source.** Full design-system matrix (Original/Slate/Sand/Sage/Mauve × light/dark), exact values from the design-system document. Both tool windows consume only these `--dv-*` tokens. |
| `tools/theme.js` | Binds the tools to the ONE appearance manager: Workspace → Settings → Appearance (`localStorage["cloudlane-appearance-v110"]` → `<html data-palette="…">` + `.dark`). Live-updates via the `storage` event when you change Appearance in another tab. |
| `tools/mail/` | Drevanta Mail — rebuilt: single brand row (logo + "Drevanta Mail", no BETA chip, no workspace switcher), collapsible ACCOUNTS / MAILBOX / LABELS sidebar sections (state persists), design-system compose button (40px, filled primary, white text), **attachments in compose** (chips, ≤10 MB × 5, uploaded to Garage under `.mail/attachments/`), reader attachment cards are real download links, honest "Send email". |
| `tools/files/` | Drevanta Files — logo brandmark, same token bridge, footer "Live tools · Real storage", hides the `.mail/` storage prefix, design-system dialogs. |
| `api/mail.controller.ts` | Adds `POST /mail/attachments` (multipart → Garage), `GET /mail/attachments/download` (workspace-scoped), attachments on send/drafts/patch, and real **outbound SMTP** for external recipients via the mail-stack service (graceful fallback + honest warning when it is down). |
| `api/mail-stack.controller.ts` | Token-guarded internal endpoints: `GET /mail/registry` (mailbox list for RCPT-time rejection) and `POST /mail/inbound` (stores received SMTP mail in the right workspace mailbox). |
| `api/mail.module.ts` | Registers both controllers, imports StorageModule for S3 access. |
| `mail-stack/` | The mail stack daemon itself: SMTP receiver on **port 25** (rejects unknown recipients at RCPT, parses, stores inbound mail) + outbound sender (direct MX delivery with DKIM signing, attachment fetch from Garage). |
| `apply_round3.py` | Idempotent repo patcher: copies tool pages into `apps/dashboard/static/tools/`, replaces the mail module, patches the storage controller (allow empty files → fixes **"can't create a new file"**, hide `.mail/` prefix from listings). |
| `DEPLOY_ALL_VPS.sh` | One-shot: apply → build → swap → install mail stack → DKIM keypair → MAIL_STACK_TOKEN → systemd service → prints the DNS records + port-25 check. |

## Deploy (needs VPS SSH access again — the sandbox recycle wiped the stored credentials)

```bash
scp -r round3 root@95.211.164.33:/root/
ssh root@95.211.164.33 'bash /root/round3/DEPLOY_ALL_VPS.sh'
```

No database migration is needed this round (MailMessage already exists).

## DNS records to add at your DNS provider (per mail domain, e.g. admin.billucsolutions.co.ke / server.billucsolutions.co.ke)

| Type | Name | Value |
| --- | --- | --- |
| MX | `@` | `10 server.billucsolutions.co.ke` (the panel host already resolves to 95.211.164.33) |
| TXT (SPF) | `@` | `v=spf1 ip4:95.211.164.33 ~all` |
| TXT (DKIM) | `mail._domainkey` | `v=DKIM1; k=rsa; p=…` — printed by the deploy script from the generated keypair |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@<zone>` |

MX delivery only starts once these records exist and port 25 is reachable — the deploy script ends with an outbound port-25 probe. If the provider blocks port 25, external delivery keeps the current honest "not delivered" behavior until a relay is configured; internal delivery is unaffected.

## Verified locally (headless Chromium, static server + API mocks)

- Mail: brand/logo row, 3 account rows, collapsible sections persist across reloads, compose opens with Attach files, attachment chip renders, send → "Delivered to mimi@…", paperclip in list, reader attachment is a real download link, labels collapse/expand.
- Theme: switching the shared appearance store to `{"mode":"light","palette":"sand"}` re-skins the whole mail window (bg `#f8e5ce`, primary `#8b4513`, selected tint `#ecdbcb`) with zero reload logic beyond what the workspace already does.
- Files: tree + real object list, New → New file → "Created hello.txt" (server-side empty-file fix ships in `apply_round3.py`), New folder, footer "Live tools · Real storage".
- Zero page errors after the wiring fixes.
