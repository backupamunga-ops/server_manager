# Hosting a Mobile-App Backend on the Billu Platform

How a user takes an idea (React Native / Expo app, MySQL, profile photos, provider
webhooks) from zero to a live HTTPS API on this platform — using
`api.billucsolutions.co.ke` as the worked example that is live right now.

## 0. What the platform already gives you

| Need | Already running on the VPS |
|---|---|
| HTTPS + domains | Caddy with Let's Encrypt, gated by the panel's domain registry |
| Object storage | Garage (S3 API) — photos, documents, media |
| Relational DB | Postgres (platform) — and now MySQL 8 in a container for app data |
| Process supervision | systemd units that restart on failure and start on boot |
| Reverse proxy | per-hostname site blocks under `/etc/caddy/hostnames/` |

You never touch TLS certificates, firewall rules for HTTPS, or DNS propagation
for subdomains — the wildcard A record plus on-demand TLS handle it.

## 1. DNS (already done, nothing to do for new subdomains)

The zone has a wildcard A `* → 95.211.164.33`, so `api.billucsolutions.co.ke`
resolves immediately. Caveat learned the hard way: once you add any other record
at a subdomain name (e.g. an SPF TXT), the wildcard no longer covers that name —
add an explicit A record then.

## 2. Register the hostname (certificate gate)

TLS is issued on demand, but only for hostnames registered in the platform
registry — Caddy asks `GET /api/v1/caddy/ask?domain=...` before obtaining a
certificate. Register the subdomain once:

```bash
docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -c \
  "INSERT INTO \"Hostname\" (id, \"zoneId\", name, type) \
   SELECT gen_random_uuid(), \"zoneId\", 'api.billucsolutions.co.ke', type \
   FROM \"Hostname\" LIMIT 1;"
```

(In the UI flow this is the Domains panel; the SQL is the one-time seed.)

## 3. Point the hostname at your backend

One site block per hostname, then reload:

```bash
cat > /etc/caddy/hostnames/api.billucsolutions.co.ke.caddy <<'EOF'
api.billucsolutions.co.ke {
	reverse_proxy 127.0.0.1:4100
}
EOF
systemctl reload caddy
```

First HTTPS hit triggers Let's Encrypt issuance automatically (tls-alpn-01).
Your backend only ever binds to `127.0.0.1` — Caddy is the only public door.

## 4. MySQL for the app

A dedicated container, localhost-only, persistent, boot-safe:

```bash
docker run -d --name app-mysql --restart unless-stopped \
  -p 127.0.0.1:3306:3306 \
  -v /opt/app-mysql/data:/var/lib/mysql \
  -e MYSQL_DATABASE=appdb -e MYSQL_USER=appuser \
  -e MYSQL_PASSWORD="$PW" -e MYSQL_ROOT_PASSWORD="$ROOTPW" \
  mysql:8.0 --performance_schema=off --innodb-buffer-pool-size=128M
```

Credentials live in `/etc/cloudlane/app.env` (chmod 600, never committed).
The database file lives on disk at `/opt/app-mysql/data` — survives reboots
and container recreation.

## 5. The backend itself

`deploy/mobile-backend/server.mjs` in this repo is the working reference
(live at `api.billucsolutions.co.ke`):

- `GET /health` — liveness, no DB. Ping this from Expo, uptime monitors, and
  the load balancer of your dreams.
- `GET /db-health` — `SELECT 1` + latency. Returns 503 with the error code when
  MySQL is down, so monitoring tells you *what* broke.
- `POST /callbacks/mpesa` — real STK-push callback contract: stores the payload,
  extracts receipt/amount/phone, deduplicates on `CheckoutRequestID` via a
  unique index, answers `{"ResultCode":0,"ResultDesc":"Accepted"}` (what
  Safaricom requires), and returns that immediately — heavy work happens on the
  stored row, never inline in the callback.
- `POST /callbacks/:provider` — generic idempotent receiver for any other
  provider (event id from `x-event-id` header or body), stores raw JSON.
- `POST /profiles` / `GET /profiles` / `GET /profiles/:id` — MySQL CRUD.
- `POST /profiles/:id/photo` — multipart upload (≤5 MB, jpeg/png/webp) streamed
  into Garage (`app-media` bucket), key saved in MySQL.
- `GET /profiles/:id/photo` — streams the object back with the right
  content-type; this URL is what the app puts in `<Image>`.

Runs as `mobile-backend.service`; secrets via `EnvironmentFile`; every async
route is wrapped so a failing S3/DB call is a 500 response, not a crash.

Two Garage specifics the reference handles: bucket creation is done via the
`garage` CLI (`bucket create app-media` + `bucket allow --read --write --owner
--key <key> app-media`) because the platform key does not hold
`--create-bucket`; and photos are served through the API rather than presigned
URLs, because Garage listens on localhost only (see §7 for the presigned option).

## 6. The Expo side

```js
const API = 'https://api.billucsolutions.co.ke';

// create a profile
await fetch(`${API}/profiles`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email }),
});

// upload a profile photo (expo-image-picker)
const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
const form = new FormData();
form.append('photo', { uri: r.assets[0].uri, name: 'avatar.jpg', type: 'image/jpeg' });
await fetch(`${API}/profiles/${id}/photo`, { method: 'POST', body: form });

// show it
<Image source={{ uri: `${API}/profiles/${id}/photo` }} style={{ width: 80, height: 80 }} />
```

Add your own auth (JWT middleware) before exposing write endpoints publicly —
the reference deliberately leaves auth out so the plumbing is readable.

## 7. Production notes / roadmap

- **Presigned public URLs**: if you want the phone to hit Garage directly,
  expose it once via Caddy (e.g. `media.billucsolutions.co.ke → 127.0.0.1:3900`)
  and presign GETs with `@aws-sdk/s3-request-presigner` (15-min expiry). The
  proxy pattern in §5 is simpler and hides the storage entirely.
- **Webhook security**: M-Pesa signs nothing on STK callbacks — validate
  `CheckoutRequestID` against your own initiated transactions instead. Stripe
  and friends send signatures; verify them before trusting the payload.
- **Backups**: `mysqldump appdb` nightly via cron; Garage data is replicated
  by the platform layout.
- **Hardening**: run the service under a dedicated user instead of root; rate
  limit `/callbacks/*` at Caddy.

## 8. Verified live (2026-11-20)

`/health` ok · `/db-health` 2–3 ms · profile created · photo uploaded and
downloaded byte-identical over HTTPS · M-Pesa callback accepted, replay
deduplicated to one row · generic webhook stored with its event id.
