# RoomSink: Build Spec (v0.2)

## Goal
Build an ephemeral, schemaless event sink for in-class experiments. Anonymous phone web apps send JSON events to a room code. Staff log in to create rooms and read the data. All data deletes itself automatically.

## Stack
- **API:** Node 20+, TypeScript, Fastify, `@fastify/websocket`, `mysql2/promise`, `jose` (JWT/JWKS), Ajv, `ulid`, Zod for env and config validation
- **Database:** MySQL 8.0+ (InnoDB, `utf8mb4`). Migrations use plain versioned SQL files, run by a migrate command when the container starts.
- **Admin UI:** Svelte 5 (runes) with SvelteKit and `adapter-static` (SPA mode, `fallback: index.html`), TypeScript, and no external CDNs. It's built into static files.
- **Rate-limit buckets and WebSocket fan-out:** in memory, so the API runs as **one instance** in v1. Keep the store behind an interface so Redis can be added later for multiple instances.
- **Containers:** Docker with a Compose file. nginx in the DMZ handles TLS (or the host's existing nginx proxies to the stack).

## Containers (`docker-compose.yml`)
| Service | Image | Notes |
|---|---|---|
| `api` | Multi-stage build, `node:20-alpine`, non-root user | Port 3000 (internal only). Runs migrations, then starts. Read-only root filesystem with a tmpfs `/tmp`. Healthcheck on `/healthz`. |
| `admin` | Multi-stage build: build Svelte, then `nginx:alpine` (unprivileged) | Serves the static SPA at `/admin` |
| `db` | `mysql:8.4` | Named volume, internal network only (no published port). Healthcheck with `mysqladmin ping`. |
| `proxy` (optional) | `nginx:alpine` | TLS termination, body size limits, timeouts and IP allowlist. Routes `/api` and `/admin`. Leave this out if the DMZ already has nginx. |

- Use two networks: `public` (proxy, api, admin) and `internal` (api, db).
- Secrets go in Docker secrets or an `.env` file that isn't committed. Provide `.env.example`.
- Set resource limits (memory and CPU) on every service and `restart: unless-stopped`.
- Logs are JSON on stdout.

## Environment variables
`PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (or `_FILE`), `DB_POOL_SIZE`, `TOKEN_SECRET` (or `_FILE`), `TOKEN_KID`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `STAFF_ROLE`, `ADMIN_ROLE`, `CORS_CLIENT_ORIGINS`, `ADMIN_ORIGIN`, `IP_ALLOWLIST` (optional CIDRs), `TRUST_PROXY_CIDRS`, `PUBLIC_API_URL` (for the admin build), `OIDC_CLIENT_ID`, `OIDC_AUTHORITY`

## Auth
- **Staff:** a Bearer JWT from the existing auth service, verified with JWKS (`iss`, `aud`, `exp`). The JWT must have `STAFF_ROLE`. `ADMIN_ROLE` can see every room. The owner is the `sub` claim. The admin SPA uses OIDC Authorization Code + PKCE and keeps tokens in memory, not `localStorage`.
- **Clients:** an HMAC-SHA256 join token over `{v, kid, room, cid, iat, exp}`, base64url-encoded. `exp` is the earlier of the room's expiry and 12 hours after issue. Verify with a timing-safe comparison.
- **Presenter key (optional):** a random 32-byte key per room, stored only as a SHA-256 hash. It gives read-only access and is sent in the `X-Presenter-Key` header.
- **WebSocket:** connect with `?ticket=`, a single-use ticket valid for 30 seconds from an authenticated POST. Never put JWTs or keys in URLs.

## MySQL schema (outline)
```sql
CREATE TABLE rooms (
  code CHAR(6) PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  owner VARCHAR(255) NOT NULL,
  status ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  purpose ENUM('teaching','research') NOT NULL DEFAULT 'teaching',
  public_config JSON NOT NULL,
  limits JSON NOT NULL,
  presenter_key_hash CHAR(64) NULL,
  next_seq BIGINT NOT NULL DEFAULT 1,
  event_count INT NOT NULL DEFAULT 0,
  bytes_used INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  closes_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX (owner), INDEX (expires_at)
);
CREATE TABLE room_owners (room CHAR(6), staff_id VARCHAR(255),
  PRIMARY KEY (room, staff_id),
  FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE);
CREATE TABLE apps (room CHAR(6), name VARCHAR(40), enabled BOOL,
  max_events_per_client INT DEFAULT 100, allow_free_text BOOL DEFAULT FALSE,
  `groups` JSON NULL, config JSON NOT NULL, `schema` JSON NULL,
  PRIMARY KEY (room, name),
  FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE);
CREATE TABLE clients (room CHAR(6), cid CHAR(26), joined_at DATETIME(3),
  `groups` JSON NOT NULL, deleted BOOL DEFAULT FALSE,
  PRIMARY KEY (room, cid),
  FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE);
CREATE TABLE events (id CHAR(26) PRIMARY KEY, room CHAR(6), seq BIGINT,
  app VARCHAR(40), cid CHAR(26), t DATETIME(3), client_t BIGINT NULL,
  app_version VARCHAR(20) NULL, data JSON NOT NULL,
  UNIQUE (room, seq), INDEX (room, app, seq), INDEX (room, cid),
  FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE);
CREATE TABLE idempotency (room CHAR(6), cid CHAR(26), `key` VARCHAR(64),
  event_id CHAR(26), created_at DATETIME(3),
  PRIMARY KEY (room, cid, `key`), INDEX (created_at));
CREATE TABLE retired_codes (code CHAR(6) PRIMARY KEY, retired_at DATETIME(3));
CREATE TABLE ws_tickets (ticket CHAR(43) PRIMARY KEY, room CHAR(6),
  expires_at DATETIME(3));
```
- **Sequence numbers:** assign `seq` in a transaction with `SELECT next_seq ... FOR UPDATE` and then increment it. Batch inserts in the same transaction.
- **Per-client caps:** check them with a `COUNT` on `(room, cid, app)`, or keep a counter table if load testing shows it's needed.
- **Never store IP addresses.**

## Data rules
- **Room code:** 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. A code can't be reused within 30 days of retirement.
- **App name:** `^[a-z0-9-]{1,40}$`. App `config` ≤ 4 KB, `publicConfig` ≤ 8 KB. `expiresAt` is at most 30 days away.
- **Group assignment:** the server assigns weighted A/B groups per app when a client joins.

## API (`/api/v1`)

**Public / client**
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/rooms/:code/config` | none | Returns code, title, status, closesAt, enabled apps (name and config), publicConfig. Cached for 5 s. Unknown and expired rooms both return the same 404. |
| POST | `/rooms/:code/join` | none | Body `{existingToken?}`. Returns `{token, cid, groups, expiresAt}`. Reuses a valid existing token. The room must be open. |
| POST | `/rooms/:code/events` | join token | Body `{app, data, clientT?, appVersion?}` or `{events:[≤20]}`. Requires an `Idempotency-Key` header (deduplicated for 10 minutes). Returns 202 `{id, seq}`. |
| GET | `/rooms/:code/me` | join token | Returns this client's own events. |
| DELETE | `/rooms/:code/me` | join token | Hard-deletes the client's events, marks the cid as deleted, and pushes a WebSocket `deleted` message. Works after the room closes. |

**Staff / presenter**
| Method | Path | Notes |
|---|---|---|
| POST | `/admin/rooms` | Creates a room. Returns the code and the presenter key (shown only this once). |
| GET | `/admin/rooms` | Lists my rooms. `?all=1` for admins. |
| GET / PATCH / DELETE | `/admin/rooms/:code` | Owner or admin only. DELETE removes all data and retires the code. |
| POST | `/admin/rooms/:code/{open,close,rotate-key,clone}` | Status changes and utilities |
| DELETE | `/admin/rooms/:code/events?app=` | Clears data for one app or the whole room |
| GET | `/rooms/:code/events?app=&since=&limit≤1000` | JWT or presenter key. Paged by `seq`. |
| GET | `/rooms/:code/summary?app=` | Counts per app and group, plus unique clients |
| GET | `/rooms/:code/export?format=csv\|json&app=` | Streamed response, CSV-injection-safe |
| POST | `/rooms/:code/live-ticket` | Returns a WebSocket ticket |
| WS | `/rooms/:code/live?ticket=&app=&since=` | Messages: `events` (batched every 250 ms), `deleted`, `room`, `ping` |

**Ops:** `/healthz` (liveness), `/readyz` (database reachable), `/metrics` (Prometheus, internal network only)

**Error format:** `{error:{code, message, retryAfter?}}`. Codes: `ROOM_NOT_FOUND`, `ROOM_CLOSED`, `APP_DISABLED`, `RATE_LIMITED`, `CAP_REACHED`, `INVALID_PAYLOAD`, `SCHEMA_FAILED`, `TOKEN_INVALID`, `CLIENT_DELETED`, `UNAUTHORISED`, `FORBIDDEN`.

## Validation (apply in order, reject at the first failure)
1. Content-Type must be `application/json`. Raw body ≤ 2 KB for one event, ≤ 8 KB for a batch (set Fastify `bodyLimit` per route as well as the nginx limit).
2. Envelope keys are limited to `app`, `data`, `clientT`, `appVersion` (or `events`). Reject anything else, including `cid` and `t`.
3. The app must exist in the room and be enabled.
4. `data`: depth ≤ 4, ≤ 50 keys or items in total, keys match `^[A-Za-z0-9_]{1,40}$`, no `__proto__`, `constructor` or `prototype` keys, numbers must be finite, strings ≤ 200 characters (≤ 40 if `allowFreeText` is false).
5. Validate against the app's JSON Schema if one is set (Ajv strict mode, compiled schemas cached).
6. Check caps: per client per app, then per room (events, bytes, clients).
7. Use parameterised queries only. Never echo the payload back in a response.

## Rate limits (token bucket; defaults can be overridden per room)
- **Per IP:** 50 req/s (burst 300). Joins: 10/s and 600 per room per hour. Failed room codes: 10/min, then a 10-minute block. Limits are generous because the whole classroom shares one NAT IP.
- **Per cid:** 2 writes/s (burst 20), plus `maxEventsPerClient` per app
- **Per room:** 100 writes/s, 50k events, 1,000 clients, 20 MB
- **Per staff member:** 50 active rooms
- **Global:** 1,000 writes/s, after which the server returns 503, plus a memory cap
- Every 429 includes `Retry-After`. Stale buckets are cleared every minute.
- Take the client IP from `X-Forwarded-For` only when the request comes from `TRUST_PROXY_CIDRS`.

## Lifecycle and clean-up
- Rooms move from draft to open to closed (manually or at `closesAt`) and are deleted at `expiresAt`.
- Defaults: rooms close 3 hours after opening, and data expires 24 hours after closing.
- Closed rooms reject writes but still allow reads, export and delete-my-data.
- **A clean-up job inside the API runs every 5 minutes.** MySQL has no native TTL, so the job must:
  - close rooms that are past `closes_at`
  - delete expired rooms in batches (`LIMIT 1000` per loop), with the cascade removing their data
  - remove idempotency rows older than 10 minutes and expired tickets
  - retire the codes of deleted rooms
- Use a MySQL `GET_LOCK('roomsink_cleanup', 0)` so only one clean-up job runs at a time.

## Security
- TLS and HSTS are handled by nginx. CORS: client endpoints allow `CORS_CLIENT_ORIGINS`, and admin and read endpoints allow only `ADMIN_ORIGIN`.
- Apply `IP_ALLOWLIST` if it's set.
- **Admin SPA:** strict Content Security Policy from nginx (`default-src 'self'; connect-src 'self' <api>`). Never use Svelte's `{@html}`; the default `{expr}` text output is safe. Confirmation dialogs for destructive actions.
- **CSV export:** prefix any cell starting with `= + - @ \t \r` with `'`.
- **Logs:** no payloads, no tokens and no full IPs (hash them with a daily salt).
- **Containers:** non-root users, read-only filesystems, `cap_drop: [ALL]`, `no-new-privileges`, pinned image digests, and an image vulnerability scan (Trivy) in CI.
- **Database user:** limited to DML on `roomsink`. A separate migration user handles DDL.

## Admin UI (Svelte 5)
- Use runes (`$state`, `$derived`, `$effect`) and a typed API client generated from or checked against the OpenAPI file.
- Login through OIDC with PKCE, and handle silent token renewal.
- **Rooms list:** status, code, title, counts and expiry, with actions to open, close, clone, delete and export.
- **Room editor:** title, times, a JSON editor for publicConfig with validation, and an apps table (enabled, max events, groups, config, schema).
- **Room dashboard:** full-screen QR code and room code, a join URL builder (`{clientUrl}?r=CODE`), live counters over WebSocket, app on/off toggles, a table of recent events, rejection stats, and a privacy notice to copy onto a slide.
- Warn the owner 1 hour before data expires.
- **Accessibility:** keyboard navigation, AA contrast, labels, and no Svelte a11y warnings.

## Client SDK (`roomsink.js`, ES module with no dependencies, served at `/sdk/roomsink.js`)
```js
const rs = await RoomSink.connect({ api }); // reads ?r=, joins, caches the token per room
rs.config; rs.app("x").config; rs.group("x");
await rs.send("x", data);                   // idempotency key, backoff on 429/5xx with jitter, bounded queue
await rs.deleteMyData();
rs.onStatus(cb);                            // polls the room config and reports open/closed
```
The SDK also includes a privacy notice and a "Delete my data" button as a web component, so it works in any framework, including Svelte apps.

## Non-functional targets
300 clients per room, 5 rooms open at once, p95 write time under 150 ms, under 1 s from write to dashboard, no data lost on container restart (MySQL volume), and `docker compose up` working from a clean checkout.

## Tests (required)
- **Unit (Vitest):** validation, tokens, rate-limit buckets, CSV escaping, sequence allocation
- **Integration:** Testcontainers running MySQL. Covers the TTL clean-up, cascades, idempotency, and seq under concurrent writes.
- **Abuse:** oversized bodies, deep nesting, `__proto__` keys, forged or expired tokens, a flood from one token, a flood of joins, code brute-forcing, SQL injection attempts, XSS payloads shown on the dashboard
- **Admin UI:** Playwright smoke tests (login mocked, create room, live counter updates)
- **Load (k6):** 300 clients sending 1 event/s for 10 minutes

## Deliverables
A monorepo (`/api`, `/admin`, `/sdk`, `/deploy`), Dockerfiles, `docker-compose.yml` and `.env.example`, an nginx config example, SQL migrations, an OpenAPI 3.1 file, a README (setup, environment variables, DMZ notes, backup policy saying "none by design"), the test suite, a k6 script, and CI (lint, test, build, Trivy scan).

## Build order
1. Compose stack, migrations, then rooms, join, write and config
2. Validation and rate limits
3. Staff JWT auth, read APIs and export
4. Svelte admin UI
5. WebSocket live stream
6. Delete-my-data and the SDK
7. Clean-up job and metrics
8. Container hardening, then load and abuse tests

---

**What changed from the last version:**
- **MySQL has no automatic expiry,** so the clean-up job now does all the deleting and uses a lock so only one copy runs at a time.
- **Sequence numbers** are now assigned inside a database transaction.
- **The API runs as one container,** because rate limits and live updates are kept in memory. You'd need Redis to run more than one copy.



