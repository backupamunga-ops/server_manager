# Production domain wiring — server.billucsolutions.co.ke

This wires the panel, vercel-style app previews, and the managed-DNS scaffold
onto the production VPS (95.211.164.33). Do the DNS steps first.

## 1. DNS records (at your registrar / DNS host — hosted elsewhere)

| Record | Type  | Value            | Purpose |
|--------|-------|------------------|---------|
| `server.billucsolutions.co.ke` | A | `95.211.164.33` | Panel + API (already pointing, verify) |
| `*.apps.billucsolutions.co.ke` | A | `95.211.164.33` | Wildcard: every app gets `<slug>.apps.billucsolutions.co.ke` automatically |
| `ns1.billucsolutions.co.ke` | A | `95.211.164.33` | Managed-DNS nameserver 1 (scaffold) |
| `ns2.billucsolutions.co.ke` | A | *(second VPS, later)* | Nameserver 2 — required before offering managed DNS to real users |

Notes:
- `*` wildcard covers `anything.apps.billucsolutions.co.ke` — new previews
  resolve immediately; Caddy issues their certificates on demand (gated by the
  panel's registry via `/api/v1/domains/ondemand-ask`).
- Glue records are only needed if you later set NS records pointing INTO
  billucsolutions.co.ke itself.

## 2. Panel + app routing (Caddy)

```bash
# from your machine, copy infra/ to the VPS
scp -r infra root@95.211.164.33:/root/cloudlane-infra
ssh root@95.211.164.33 'bash /root/cloudlane-infra/caddy/apply-production-caddy.sh'
```

What this does:
- Backs up `/etc/caddy/Caddyfile`, installs `Caddyfile.production`.
- Panel serves at **https://server.billucsolutions.co.ke** (and the raw IP),
  keeping existing `/services/<id>/` path previews.
- Adds the top-level `import /etc/caddy/hostnames/*.caddy`. From then on,
  connecting a hostname to an app in the panel (Domains → Connections →
  Connect application) writes a real site block and reloads Caddy — the app
  is then live at `https://<hostname>/` with automatic HTTPS.

Then set the platform suffix on the API (`/etc/cloudlane/api.env`):

```
PLATFORM_APP_SUFFIX=apps.billucsolutions.co.ke
```

and `systemctl restart cloudlane-api`. Newly created applications get
`<slug>.apps.billucsolutions.co.ke` platform URLs instead of
`*.apps.example.test`.

## 3. Managed-DNS nameserver scaffold (for later)

```bash
ssh root@95.211.164.33 'bash /root/cloudlane-infra/pdns/install-pdns.sh'
```

Installs PowerDNS Authoritative (SQLite backend, HTTP API on 127.0.0.1:8053,
API key in `/etc/cloudlane/pdns-api-key`). Nothing is authoritative for any
zone until a domain owner delegates NS to us — safe to install now.

Important: keep managed DNS mode disabled for customers until **ns2 runs on a
second machine** (two independent nameservers — the panel already gates this;
the prototype docs require it).

## 4. Order of first checks after wiring

1. `https://server.billucsolutions.co.ke` serves the panel (LE cert for the
   hostname, not just the IP).
2. Deploy a test ZIP app → path preview `https://server.billucsolutions.co.ke/services/<id>/` works.
3. In Domains, add your domain, verify ownership (real TXT check runs via
   `dig` on the VPS), create a subdomain, connect it to the app →
   `https://<hostname>/` responds and Caddy obtained a certificate.
4. `*.apps` preview: any new app's platform URL resolves + serves.
