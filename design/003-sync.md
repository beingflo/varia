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

Signup is the one moment raw key bytes exist: `getRandomValues(32)` produces both the enrolment code
and the input to a non-extractable import, so there is no importable-then-exportable key at all
(Firefox refuses `exportKey('raw')` on HKDF keys, and now it never matters):

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
- `/api/sync`: token bucket, burst 10, refill 30/min. Commits are coarse (blur, `⌘S`, navigation),
  so ordinary writing produces a push per save rather than per keystroke, so anything tighter throttles ordinary use.
- `/api/signup`: 1/min per IP.

## When it runs

Push immediately after a local write (a burst of writes coalesces into at most one follow-up
request per round trip), pull on app start and on foreground, flush on `visibilitychange → hidden`,
plus a 60 s timer while visible and a manual "sync now" (`⌘⇧S`, then Enter). No websockets, no push
notifications: on iOS a socket dies with the tab anyway.

Every trigger is best-effort. Failure is silent and retried with backoff; the UI carries the state
("synced", "3 changes pending", "never synced").

The account (token plus the non-extractable AES key) lives in IndexedDB, the only place a CryptoKey
can be stored without exporting it. The root key is never written anywhere: signup imports it once
and shows the enrolment code the one time it can exist, which is also why a lost code is a lost
account. `⌘⇧S` opens the sync overlay: paste a code, or press Enter on the empty field to create an
account and see the code for the first time.

## Implementation notes

- **The outbox is the op log itself.** `op.pushed` is the queue flag, so a push never copies ops
  anywhere; `markPushed` runs only after the server answered 200. A failed push leaves everything
  pending, and duplicates on the server make the retry harmless.
- **An op that cannot be opened is skipped, not retried.** A wrong key or a damaged payload would
  otherwise pin the cursor forever; `syncNow` counts them in `skipped` and moves on.
- **A pulled page is decrypted in parallel and applied in one transaction.** Per-op work was the
  whole cost of a replay: one worker round trip, one commit and one view refresh each. Measured on
  Chromium: a 500-op page costs ~21 ms of request and ~86 ms of apply; 400 ops land on a fresh
  device in ~130 ms. The crypto was never the bottleneck.
- **At most five push/pull rounds per call**, so a large backlog drains over several syncs instead of
  holding one request open.
- **The local lamport clock is raised to the remote one** when an op is applied, otherwise the next
  local write would lose the tie-break against the device it just pulled from.

## Conflict

When a pull lands a note whose server head is not an ancestor of the local head, both branches stay
in the log and the note shows the head with the highest `(lamport, device)`. Nothing is merged and
nothing is dropped. The version tree view, and the badge that accompanies it, are a later feature
(`PLAN.md` phase 4) — the data already supports both.
