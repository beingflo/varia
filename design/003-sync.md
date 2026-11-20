# Sync

The server is an authenticated, ordered, encrypted op log. It has no note tables, no search, no
migrations of the data model, and no ability to read anything a human wrote.

## Accounts

`POST /api/signup` creates a `user` and returns a token. Registration is open, guarded by an IP rate
limit (1/min) and a storage cap. The token is a random 32-byte value shown once, stored server-side
as a SHA-256 hash, and used as a bearer credential on every sync call. One token per account, shared
by its devices; revocation and multiple tokens are a later feature.

Server tables: `user(id, token_hash, created)`,
`op(owner, server_seq, op_id, device, kind, note_id, created, ciphertext)` with a unique
`(owner, op_id)` — that uniqueness is what makes a retried push harmless. The id is random, chosen by
the client, so nothing can predict one and pre-empt it.

There is no owner column on the client: a local database belongs to one person by definition, and
attribution only exists once ops reach the server.

## Keys

The root key never leaves the device. `HKDF-SHA256(root, info="varia/op")` gives the AES-256-GCM
key; the same construction will produce subkeys for blob ids and anything else. Keys are imported
non-extractable, so an XSS can read what it can read today but cannot exfiltrate the key itself.

`getRandomValues(32)` produces the root key; HKDF derives the AES key from it, imported
non-extractable. The root exists in memory only while the signup screen shows it — it is never
written anywhere, so a script with same-origin access can use the AES key but can export neither it
nor the root. The price is that the key is shown exactly once: losing it loses the server copy of
every note, with no reset.

Two strings, never combined:

```
token     64 hex characters, identifies the account on the server
key       32 bytes as 52 base32 characters, decrypts the log
```

The panel shows both once, at signup, with a download of the pair and a warning that the key is
unrecoverable. Afterwards it shows the token only: the key is not stored, so a second device needs
the copy the user saved. Losing both means the account is gone; the server keeps only ciphertext,
and there is no reset and no server-side recovery.

## Wire format

An op travels as `{id, device, kind, note_id, created, ciphertext}`. The payload is
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

A token holder who is not the user can read the envelope metadata (device ids, note ids, kinds,
timestamps, sizes) and nothing else: a forged ciphertext fails to authenticate on the client and is
skipped. They can waste the account's cap and pull budget; they cannot delete an op — there is no
delete endpoint — and with a random op id they cannot pre-empt one either. Signing the envelope with a
per-device key derived from the root would close the waste as well; it is a phase 4 option, not
something the log needs today.

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

Unlinking is the one way out: it drops the token and the derived key from the device and rewinds the
outbox, so the same local history can be pushed to a different account. The notes are never touched.
The old account's log stays on the server, unreadable without a key that device no longer holds.

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

## The cursor can be wrong, so it is never trusted alone

A pull cursor is a number that can disagree with the content it stands for, and every sync bug so far
was such a disagreement. Three rules remove the class instead of patching instances:

- **Applied and advanced together.** A page and the cursor it stands for are written in one worker
  call and one transaction (`applyRemotePage`). A crash or a closed tab cannot leave the cursor ahead
  of the ops, which would have skipped them permanently and silently.
- **Bound to its account.** The cursor is stored with a fingerprint of the token (`accountTag`, a
  non-secret SHA-256 prefix). A cursor from another account reads as `0`, so losing the keystore or
  pointing the database at a different bucket self-heals instead of skipping the account's history.
- **Compared with the server's head.** Every response carries `head`, the highest `server_seq` in the
  account. If it is *below* our cursor, the server has lost ops (a restored backup, a wiped table).
  The client rewinds the outbox, re-pushes its whole log, and pulls from zero.
- **A push never skips what it did not see.** The pull floor skips a request's own writes only when
  the client was caught up before pushing (`cursor >= base`). A device that was behind — two devices
  writing while offline — gets the ops in between in the same response, or its new cursor would sit
  above ops it never received. That was a real loss: a child version arrived without its parent.
- **Repair is explicit.** `re-pull the log` in the sync panel forgets the cursor for the account and
  keeps every op and its pushed flag; the next sync re-applies the whole log, which is idempotent
  (`op_seen`, `INSERT OR IGNORE`). The way out of a database that sat above a hole.

A content hash would only add detection of *reordering* by an operator who can already serve garbage;
ordering does not affect the result, because conflicts are decided by lamport stamps inside the ops.
Divergence is not tracked either: a fork is two heads, and only the ops decide which one the note
shows. Nothing acknowledges, resolves or hides a branch — the history tree is the only view of it.
So the cheap structural rules win: nothing to hash, no full re-pull on the normal path.

## Two histories, one account

Linking a device that already has notes is a merge, not an upload: enrolment rewinds the outbox
(`pushed = 0`, cursor `0`) and clears the pull dedupe, so the whole local log goes up and the whole
account log comes down. Both devices end with the union, ordered by `(lamport, device)`.

- **Distinct notes never conflict.** Note ids are random and minted per device, so two independent
  histories touch disjoint notes. Nothing is overwritten; the account holds both.
- **The same note only exists on both sides if the database was cloned.** Then edits meet field by
  field under last-writer-wins, decided by lamport, not by wall clock: a device with a longer history
  wins a tie even when its write is older. Both devices still converge, and the losing snapshot
  survives in the version tree as a branch to restore from.
- **Lamport clocks jump to the maximum on apply**, so everything written after a merge wins against
  everything written before it, on either side.
- **Only ops new to the account are stored**: the server dedupes on the op id, so a history that is
  already up there is re-pushed harmlessly (and its `pushed` flags go back to 1).
- **A rich history costs requests.** Pages are 500 ops and the token bucket allows 10 burst / 30 per
  minute, so a few thousand ops land immediately and the rest arrive with backoff.

## Conflict

When a pull lands a note whose server head is not an ancestor of the local head, both branches stay
in the log and the note shows the head with the highest `(lamport, device)`. Nothing is merged and
nothing is dropped. The version tree view, and the badge that accompanies it, are a later feature
(`PLAN.md` phase 4) — the data already supports both.
