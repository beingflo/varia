# Service

One Rust binary: axum serving `/api/*` and the built frontend from the same origin. Because it stores
only ciphertext, its job is little more than an ordered log with authentication.

## Routes

```
POST /api/signup   {}                        → {token}
POST /api/sync     {device, cursor, ops[]}   → {ops[], cursor, accepted, more, usage, cap}
GET  /*                                      → ui/dist (SPA fallback)
```

No admin UI, no user listing, no search endpoint. Anything else the client needs is a local query.

## Storage

One SQLite file in WAL mode on a volume:

```
user(id, token_hash, created)
op(owner, server_seq INTEGER PK, op_id, device, kind, note_id, created, ciphertext BLOB,
   UNIQUE(owner, op_id))
```

`server_seq` is a per-owner monotonic counter assigned on insert; pulling is `WHERE owner = ? AND
server_seq > ? ORDER BY server_seq LIMIT 500`. Every response also reports `head`, the owner's
highest `server_seq`, so a client can notice that the log is shorter than what it already pulled. The unique key makes retries idempotent. Migrations
only ever create or add indexes here — the note schema lives in the client, which is what keeps the
server cheap to operate.

`rusqlite` with the `bundled` feature (it needs no FTS5: search is client-side). Statement timeouts
short, one writer connection, a small read pool.

## Limits and abuse

- Token bucket per token on `/api/sync` (burst 10, refill 30/min) and per IP on `/api/signup` (1/min),
  in memory — a restart empties it, which is fine.
- Storage cap 500 MB per account, checked at push time against
  `sum(length(ciphertext))`; over the cap the push accepts a prefix (duplicates always count as
  accepted) and the pull still happens — a device with pending writes is never split off; pulls keep
  working so data can always be rescued.
- Per-op and per-request size ceilings before the body is buffered.
- TLS only, behind Caddy. The main privacy requirement is the URL: nothing may leak note content into
  logs, and no op body is ever logged at any level.

## Headers

The app shell must be served with `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` for the
`opfs` VFS. Set them via Caddy or `tower-http`, and keep the wasm/js chunks same-origin so
`require-corp` stays satisfiable. CORP is not optional: WebKit refuses to start the worker the OPFS
VFS spawns without it, while Chrome happens to allow it. `/api/*` responses need none of this.

## Operations

A container running under Podman/Quadlet, Caddy terminating TLS and proxying to the container's
loopback port, the SQLite file on a named volume.

```
Containerfile     node build (ui) → rust build (server) → debian-slim runtime, ~108 MB
varia.container   quadlet unit: loopback port, varia-data:/data, keep-id uid 1000, no capabilities
.deploy.env       VARIA_HOST, VARIA_DOMAIN, VARIA_PORT — non-secret, committed
mise-tasks/       dev, service:dev, ui:dev, test, test:e2e, deploy, deploy:build
```

The container listens on 8080 and the host side comes from `VARIA_PORT` (default 8090, because 8080
belongs to another service on the deploy host); `mise run deploy` renders both the tag and the port
into the unit, since quadlet substitutes nothing.

`mise run deploy` builds the image, ships it over SSH (`podman save | zstd | ssh | podman load`),
installs the unit, restarts it, then checks three things: the
container is running, `127.0.0.1:$VARIA_PORT/healthz` answers, and `https://$VARIA_DOMAIN/` carries
all three isolation headers. A container that exits on startup leaves the unit inactive without an
error, which is why the running check comes first.

Unlike the service this repo borrows its deploy from, nothing is secret: the log is encrypted
client-side, so there are no podman secrets, no sops file and nothing to rotate. Caddy needs no
header configuration — the binary sets COOP/COEP/CORP on every response — only a reverse proxy to
the loopback port, in the `eos-core` checkout:

```
varia.page {
    reverse_proxy localhost:8090
}
www.varia.page { redir https://varia.page{uri} permanent }
```

The redirect is not cosmetic: the local SQLite database lives in OPFS, which is per origin, so a
second hostname would be a second, empty notebook.

`mise run dev` runs both dev servers with job control, so Ctrl-C stops both. The service listens on
`127.0.0.1:8099` and writes `.varia-dev.sqlite`; Vite proxies `/api` there.

Backups are dull because the data is already encrypted: the file copy (or `sqlite3 .backup`) to
another host is a valid backup. Daily cron is enough; history that is a day behind is still history.
Health: an unauthenticated `/healthz` and nothing else to watch — the log either accepts writes or it
does not.

## Implementation notes

Small deviations worth knowing, all in `server/`:

- **One connection, not a pool.** A `Mutex<Connection>` for reads and writes. Writes serialise
  anyway and pulls are 500-row scans; a pool is only worth it once sync requests queue behind each
  other.
- **`server_seq` is `MAX + 1` per owner** inside the push transaction, not a counter column. The
  insert order is the sequence order, and a retried push keeps its row.
- **A push does not return its own ops.** The pull floor is the highest sequence that request
  wrote, so a client never re-receives what it just sent, even at cursor 0.
- **The signup rate limit is keyed on `X-Forwarded-For`.** The container publishes on loopback and
  Caddy sets the header, so nothing off-host can forge it; tests set it directly.
- **Envelope checks before anything is stored**: labels (`id`, `device`, `note_id`, `kind`) non-empty,
  printable and bounded, `created > 0`, ciphertext 28 bytes to 4 MiB (nonce plus tag is the floor).
  A rejected request writes nothing.
- **Partial pushes are allowed up to the cap.** The ops that fit are stored, the request answers
  `403 storage_cap`, and the client keeps the rest pending.

## Tests

The interesting logic is the log, not the HTML: push/pull cursors, duplicate pushes, cap enforcement,
rate limits, envelope validation and one end-to-end test that signs up, pushes ops, pulls them back
on a second device and replays them into a fresh client database.
