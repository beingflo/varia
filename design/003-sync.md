# Sync

The server is an authenticated, ordered, encrypted op log. It has no note tables, no search, no
migrations of the data model, and no ability to read anything a human wrote.

## Accounts

`POST /api/signup` creates a `user` and returns a token. Registration is open, guarded by an IP rate
limit (1/min) and a storage cap. The token is a random 32-byte value shown once, stored server-side
as a SHA-256 hash, and used as a bearer credential on every sync call. One token per account, shared
by its devices; revocation and multiple tokens are a later feature.

Server tables: `user(id, token_hash, created)`,
`op(owner, server_seq, device, seq, kind, note_id, created, ciphertext)` with a unique
`(owner, device, seq)` — that uniqueness is what makes a retried push harmless.

There is no owner column on the client: a local database belongs to one person by definition, and
attribution only exists once ops reach the server.

## Keys

The root key never leaves the device. `HKDF-SHA256(root, info="varia/op")` gives the AES-256-GCM
key; the same construction will produce subkeys for blob ids and anything else. Keys are imported
non-extractable, so an XSS can read what it can read today but cannot exfiltrate the key itself.

Signup is the one moment raw key bytes exist: generate extractable, export, re-import as
non-extractable, discard. That export is the enrolment code:

```
varia1.<token>.<root key, base32>
```

Shown as text and offered as a download. A second device pastes it once and then pulls from cursor 0.
Losing every device and the enrolment code loses the data: there is no reset and no server-side
recovery.

## Wire format

An op travels as `{kind, note_id, device, seq, created, ciphertext}`. The payload is
`JSON → gzip (CompressionStream / flate2) → AES-256-GCM` with a random 12-byte nonce prepended.
`lamport` lives inside the encrypted payload; the plaintext envelope keeps only what the server needs
to order, dedupe and cap.

## Endpoints

```
POST /api/signup   {}                          → {token}
POST /api/sync     {device, cursor, ops[]}     → {ops[], cursor, more, usage_bytes, cap_bytes}
```

`/api/sync` pushes and pulls in one request. Push is best-effort per op: duplicates are ignored,
ordering is the server's `server_seq`. Pull returns ops with `server_seq > cursor`, at most 500 ops
or 8 MB, with `more: true` when the client should immediately request again.

Errors are boring on purpose: `401` bad token, `413` op or body too large, `429` with `Retry-After`,
`403` with `{"error": "storage_cap"}` when the account is full. A full account can always pull.

## Limits

- op ≤ 4 MB, request ≤ 16 MB.
- 500 MB of stored ciphertext per account, counted as `sum(length(ciphertext))`.
- `/api/sync`: token bucket, burst 10, refill 30/min. A 1.5 s snapshot debounce means normal writing
  produces ~30 pushes an hour, so anything tighter throttles ordinary use.
- `/api/signup`: 1/min per IP.

## When it runs

Push after a local change settles (the same ~1.5 s debounce that writes ops), pull on app start and
on foreground, flush on `visibilitychange → hidden`, plus a 60 s timer while visible and a manual
"sync now". No websockets, no push notifications: on iOS a socket dies with the tab anyway.

Every trigger is best-effort. Failure is silent and retried with backoff; the UI carries the state
("synced", "3 changes pending", "never synced").

## Conflict

When a pull lands a note whose server head is not an ancestor of the local head, both branches stay
in the log and the note shows the head with the highest `(lamport, device)`. Nothing is merged and
nothing is dropped. The version tree view, and the badge that accompanies it, are a later feature
(`PLAN.md` phase 4) — the data already supports both.
