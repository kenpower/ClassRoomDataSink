# RoomSink

An ephemeral, schemaless event sink for in-class experiments. Anonymous phone web apps send JSON events to a
six-character room code; staff sign in to create rooms, watch data arrive live, and export it. **All data deletes
itself automatically** — rooms close (default 3 h after opening) and are deleted with all their data (default 24 h
after closing, never more than 30 days).

```
phones ──► /sdk/roomsink.js ──► /api/v1/rooms/CODE/{config,join,events,me}  ┐
staff  ──► /admin (Svelte SPA) ─► /api/v1/admin/…, /rooms/CODE/{events,summary,export,live}
                                                                            ▼
                         proxy (nginx) ──► api (Node/Fastify, 1 instance) ──► db (MySQL 8.4)
```

| Path | What |
|---|---|
| `api/` | Fastify API (TypeScript), SQL migrations, OpenAPI 3.1 file, tests |
| `admin/` | Svelte 5 / SvelteKit admin SPA (static build), Playwright smoke tests |
| `sdk/` | `roomsink.js` client SDK (dependency-free ES module) and `example.html` |
| `deploy/` | nginx configs (proxy, admin, TLS example), MySQL init script, k6 load test |

## Quick start

```bash
docker compose up -d --build
```

That works from a clean checkout with development defaults and serves everything on
<http://localhost:8080> (`/admin/`, `/api/v1/…`, `/sdk/roomsink.js`). Staff sign-in needs the STARS settings below.

For a real deployment:

```bash
cp .env.example .env
```

Then set at least `PUBLIC_URL`, the three DB passwords, `TOKEN_SECRET` (`openssl rand -base64 48`),
`AUTH_JWT_SECRET`, `STAFF_EMAIL_DOMAINS` and `ADMIN_EMAILS`, and run:

```bash
docker compose up -d --build
```

## Staff sign-in (STARS auth service)

The API — never the browser — holds the STARS shared secret.

1. The admin SPA sends the browser to `GET /api/v1/auth/login`, which redirects to
   `{AUTH_BASE_URL}/sign_in?redirect={PUBLIC_URL}/api/v1/auth/callback&auth_provider=microsoft,google`.
2. STARS redirects back to `/api/v1/auth/callback?token=<JWT>`. The API verifies it with `AUTH_JWT_SECRET`
   (algorithm pinned to HS256) and decides whether the person is staff:
   * email at one of `STAFF_EMAIL_DOMAINS` (subdomains included), or listed in `STAFF_EMAILS`, or in `ADMIN_EMAILS`.
   * `ADMIN_EMAILS` may be any address (Gmail etc.). Admins can see every room. The list is re-checked on each request.
3. The API redirects to `/admin/auth#code=…` with a single-use, 60-second code (in the URL fragment, so it never reaches
   server logs). The SPA swaps it for a RoomSink session token (`POST /api/v1/auth/session`) that is kept **in memory
   only**, renewed silently before expiry (`SESSION_HOURS`, default 8), up to `SESSION_MAX_HOURS` (12) after sign-in.
   Reloading the page signs in again; STARS skips its screen while its own session is valid.

Staff identity (room owner, co-owners) is the lower-cased email (or STARS `user_id` when the account has no mail).
Register `{PUBLIC_URL}/api/v1/auth/callback` as the redirect with the STARS administrator if they restrict it.

STARS tokens carry no `exp`; if they ever include `iat`, set `AUTH_TOKEN_MAX_AGE_S` to bound their age.

## Environment variables

All are read by the API unless noted. `*_PASSWORD`/`*_SECRET` may be given as `*_FILE` (Docker secrets).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | `db`, `3306`, `roomsink` | |
| `DB_USER` / `DB_PASSWORD` | `roomsink` | Runtime user, DML only (created by `deploy/mysql/01-app-user.sh`) |
| `DB_MIGRATE_USER` / `DB_MIGRATE_PASSWORD` | = `DB_USER` | DDL user used by migrations at start-up |
| `DB_POOL_SIZE` | `20` | |
| `TOKEN_SECRET` | random per start | HMAC key for join tokens and staff sessions; ≥ 32 bytes. Set it, or tokens die on restart |
| `TOKEN_KID` | `k1` | Key id in join tokens (change together with the secret to rotate) |
| `AUTH_BASE_URL` | `https://compucore2.setu.ie/auth` | STARS base URL |
| `AUTH_JWT_SECRET` | — | STARS `JWT_SECRET_KEY` |
| `AUTH_PROVIDERS` | `microsoft,google` | |
| `STAFF_EMAIL_DOMAINS`, `STAFF_EMAILS`, `ADMIN_EMAILS` | — | Comma-separated |
| `SESSION_HOURS`, `SESSION_MAX_HOURS` | `8`, `12` | |
| `AUTH_TOKEN_MAX_AGE_S` | `0` (off) | |
| `PUBLIC_API_URL` | request host | External base URL, used to build the STARS callback (compose sets it from `PUBLIC_URL`) |
| `ADMIN_URL` | `{ADMIN_ORIGIN}/admin/` | Where the callback sends the browser |
| `CORS_CLIENT_ORIGINS` | — | Origins allowed on client endpoints; `*` is safe (bearer tokens, no cookies) |
| `ADMIN_ORIGIN` | — | Only needed if the admin is on a different origin from the API |
| `IP_ALLOWLIST` | — | Optional CIDRs for the whole API. Leave empty so people can connect from home |
| `TRUST_PROXY_CIDRS` | — | Read `X-Forwarded-For` only from these proxies |
| `IP_RATE_PER_SEC`, `IP_RATE_BURST` | `50`, `300` | Per-IP request bucket (see *Rate limits*) |
| `MEMORY_LIMIT_MB` | `400` | Above this RSS, writes and joins get 503 |
| `LOG_LEVEL` | `info` | |
| Admin build args: `PUBLIC_API_URL` (`ADMIN_API_URL` in `.env`), `PUBLIC_CLIENT_URL` (`CLIENT_URL`) | empty | API origin baked into the SPA (empty = same origin) and default client-app URL for the join QR |

`OIDC_CLIENT_ID`, `OIDC_AUTHORITY`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `STAFF_ROLE` and
`ADMIN_ROLE` from the original spec are replaced by the STARS settings above (STARS is not an OIDC provider and has no roles).

## Rate limits and the classroom NAT

Defaults follow the spec: per IP 50 req/s (burst 300), joins 10/s (burst 100) per IP and 600/hour per room, 10 unknown
room codes/min then a 10-minute block, per client 2 writes/s (burst 20) plus `maxEventsPerClient` per app, per room
100 writes/s / 50k events / 1,000 clients / 20 MB, 50 active rooms per staff member, and 1,000 writes/s globally (then 503).
Every 429/503 has `Retry-After`; the SDK backs off with jitter.

A whole class usually shares one public IP. **For a big class sending continuously** (e.g. 300 phones × 1 event/s),
raise `IP_RATE_PER_SEC` (≈ 400) and the room's `limits.writesPerSecond` (room editor / API, up to 1,000).

## Data, privacy and backups

* No IP addresses are stored. Logs contain no payloads or tokens, and IPs only as a hash with a daily-rotating salt.
* Students can delete their own data at any time (`DELETE /rooms/CODE/me`, the SDK's `<roomsink-privacy>` button),
  even after the room closes. The dashboard has a privacy notice to copy onto a slide.
* A clean-up job inside the API runs every 5 minutes (MySQL has no TTL; `GET_LOCK` ensures one runner): it closes rooms
  past `closes_at`, deletes expired rooms in batches of 1,000 (foreign-key cascades remove their data), retires their
  codes for 30 days, and prunes idempotency keys (10 min) and WebSocket tickets.
* **Backups: none, by design.** The data is meant to disappear. The MySQL named volume `db-data` survives container
  restarts and upgrades; `docker compose down -v` deletes it. Do not add the volume to host backup jobs.

## DMZ notes

* `proxy` (nginx, unprivileged, port 8080) routes `/api`, `/sdk`, `/admin`, sets body limits (8 KB for event writes,
  64 KB otherwise) and timeouts, and does **not** expose `/healthz`, `/readyz` or `/metrics`. By default it is
  published on `127.0.0.1:8080` for a TLS-terminating host nginx — see `deploy/nginx/roomsink-tls.conf.example`
  (TLS, HSTS, WebSocket upgrade). If the DMZ nginx should talk to the services directly, leave `proxy` out and copy its
  location blocks.
* Set `TRUST_PROXY_CIDRS` to the addresses of the proxies in front of the API so rate limits use the real client IP.
* Networks: `public` (proxy, api, admin) and `internal` (api, db; no outbound access, no published DB port).
* Containers: non-root, read-only root filesystems (tmpfs `/tmp`), `cap_drop: [ALL]`, `no-new-privileges`, memory/CPU
  limits, `restart: unless-stopped`, base images pinned by digest, JSON logs on stdout.
* The admin is served with a strict CSP: `default-src 'self'; script-src 'self'; connect-src 'self' <api>` — SvelteKit's
  inline bootstrap script is moved into a file at build time (`admin/scripts/externalize-inline.mjs`). The only inline
  style allowed (by hash) is SvelteKit's screen-reader route announcer.
* The API runs as **one instance**: rate-limit buckets, WebSocket fan-out and per-room write batching are in memory
  behind interfaces (`RateLimitStore`, `LiveBus`) so Redis can be added later for several instances.
* Prometheus metrics: `http://api:3000/metrics` from the internal network.

## Client SDK

```html
<script type="module">
  import { RoomSink } from 'https://roomsink.example.ie/sdk/roomsink.js';
  const rs = await RoomSink.connect({ api: 'https://roomsink.example.ie' }); // reads ?r=CODE, joins, caches the token
  rs.config; rs.app('quiz').config; rs.group('quiz');   // public config, app config, A/B group
  await rs.send('quiz', { answer: 'B' });               // idempotency key, retries 429/5xx with jitter, bounded queue
  await rs.deleteMyData();
  rs.onStatus((s) => …);                                // 'open' | 'closed' | 'draft' | 'gone'
</script>
<roomsink-privacy></roomsink-privacy>                    <!-- notice + "Delete my data" button -->
```

`sdk/example.html` is a complete four-button quiz. Event rules: one event ≤ 2 KB or a batch of ≤ 20 (≤ 8 KB); `data`
depth ≤ 4, ≤ 50 keys/items, keys `^[A-Za-z0-9_]{1,40}$`, strings ≤ 40 characters (≤ 200 if the app allows free
text), plus the app's JSON Schema if set.

## API

`api/openapi.yaml` (OpenAPI 3.1) documents every route. The admin's TypeScript types are generated from it
(`npm run gen:api` in `admin/`; CI fails if they drift). Errors are always `{"error":{"code","message","retryAfter?"}}`.

## Development and tests

```bash
cd api && npm ci
```

```bash
npm run lint
```

```bash
npm run test:unit
```

```bash
npm run test:integration
```

The integration tests start MySQL with Testcontainers (needs Docker). Set `TEST_DB_HOST` etc. to use an existing server.

* **Unit:** validation, tokens, STARS/session auth, rate-limit buckets, CSV escaping, CIDRs, live bus, SDK.
* **Integration:** rooms lifecycle, join/write/read/export, caps, JSON Schema, idempotency (incl. concurrent retries),
  gap-free `seq` under 150 concurrent writes, clean-up/TTL, cascades, `GET_LOCK`, live WebSocket and tickets.
* **Abuse:** oversized bodies, deep nesting, `__proto__`/`constructor` keys, forged/expired/cross-room tokens, floods from
  one token and one IP, join floods, room-code brute forcing, SQL injection attempts, XSS payloads, CORS.
* **Admin (Playwright):** start the stack with a known STARS secret, then run the tests; login is mocked by signing a
  STARS-style token, so the real auth service is never contacted:

  ```bash
  AUTH_JWT_SECRET=local-stars-secret-local-stars-secret STAFF_EMAIL_DOMAINS=setu.ie docker compose up -d --build
  ```

  ```bash
  cd admin && npm ci && npx playwright test
  ```

* **Load (k6):** `deploy/k6/load.js` runs 300 clients × 1 event/s for 10 minutes:

  ```bash
  ROOM=ABC234 BASE_URL=https://roomsink.example.ie k6 run deploy/k6/load.js
  ```

  Measured on a 4-vCPU VM with the compose stack: p95 write 16 ms, 0 write errors, about 280 events/s sustained.

CI (`.github/workflows/ci.yml`) runs lint, all API tests, the admin type/a11y check and build, builds the images,
runs the Playwright smoke tests against the composed stack, and scans images and config with Trivy.
