# Sync

The server is an authenticated, ordered, encrypted op log. It has no note tables, no search, no
migrations of the data model, and no ability to read anything a human wrote. Its own two tables do
get migrated on open — see `005-service.md`.

## Accounts

`POST /api/signup` creates a `user` and returns a token. Registration is open, guarded by an IP rate
limit (1/min) and a storage cap. The token is a random 32-byte value shown once, stored server-side
as a SHA-256 hash, and used as a bearer credential on every sync call. One token per account, shared
by its devices; revocation and multiple tokens are a later feature.

Server tables: `user(id, token_hash, created)`,
`op(owner, server_seq, op_id, device, kind, note_id, created, ciphertext)` with a unique
`(owner, op_id)` — that uniqueness is what makes a retried push harmless. The id is random, chosen by
the client, so nothing can predict one and pre-empt it.

**Enrolment normalises what a phone does to a paste.** The token is lowercase hex; iOS capitalises
the first character of a paste, share sheets add spaces and newlines, so whitespace is stripped and
the token lowercased before it is used. Nothing that was ever issued changes meaning under that.

**A 401 says which 401 it was.** `missing_token` means the header never arrived; `unknown_token`
means this server has no account with that token's hash — a token from another deployment, or a
database that was recreated. The server logs the hash's first six hex characters and how many
accounts it holds, and the panel shows the same six characters next to the endpoint it asked, so
the two logs line up without either side handling the token.

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
POST /api/sync     {device, cursor, ops[]}     → {ops[], cursor, accepted, more, usage_bytes, cap_bytes}
```

`/api/sync` pushes and pulls in one request. Push is best-effort per op: duplicates are ignored,
ordering is the server's `server_seq`, and `accepted` says how many of the request's ops (in
order) the account now holds — a full account accepts a prefix and the rest stay pending on the
client, never marked pushed. Pull returns ops with `server_seq > cursor`, at most 2000 ops
or 8 MB, with `more: true` when the client should immediately request again.

A token holder who is not the user can read the envelope metadata (device ids, note ids, kinds,
timestamps, sizes) and nothing else: a forged ciphertext fails to authenticate on the client and is
skipped. They can waste the account's cap and pull budget; they cannot delete an op — there is no
delete endpoint — and with a random op id they cannot pre-empt one either. Signing the envelope with a
per-device key derived from the root would close the waste as well; it is a phase 4 option, not
something the log needs today.

Errors are boring on purpose: `401` bad token, `413` op or body too large, `429` with `Retry-After`.
A full account never errors: it accepts the prefix that fits (duplicates always count as
accepted), and the pull in the same response always happens, so a device with pending writes is
never split off from the account.

## Limits

- op ≤ 4 MB, request ≤ 16 MB, at most 2,048 ops per request (a client batches at most 500).
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
  anywhere; `markPushed` runs only after the server answered, and only for the prefix it says it
  holds (`accepted`). A failed push leaves everything pending, and duplicates on the server make
  the retry harmless.
- **The outbox is pushed in insert order, not wall-clock order.** A clock stepped backwards between
  a note's meta and its snapshot must not push the child before its parent, or every recipient
  would skip both.
- **An op that cannot be opened — or cannot be applied — is skipped, not retried.** A wrong key, a
  damaged payload or a snapshot whose note never arrived would otherwise pin the cursor forever;
  `syncNow` counts the unopenable ones in `skipped`, and an unapplicable one stays unseen so a
  repair retries it once it can.
- **A change that could never travel is refused at the write, and a legacy one never blocks.**
  Writes over ~4.5 MB of payload are rejected (text compresses to at least ~6 bits per character,
  so the ciphertext stays under the 4 MB wire limit), and an oversized op already in the log is
  counted, left pending and shown, never dropped and never allowed to pin the ops behind it.
  Pushes are batched by bytes so a request stays under the server's body cap.
- **A pulled page is decrypted in parallel and applied in one transaction.** Per-op work was the
  whole cost of a replay: one worker round trip, one commit and one view refresh each. Measured on
  Chromium: a page costs ~21 ms of request and ~86 ms of apply per 500 ops, so ~0.2 ms per op; 400
  ops landed on a fresh device in ~130 ms. The crypto was never the bottleneck, so the page size only
  trades requests against the size of one response (2,000 ops is a few MB of ciphertext).
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

Before the first push, enrolment asks the account for one page and checks the key against a few
ops: a wrong key would encrypt this device's history into ciphertext nobody can open, and the
op-id dedupe would keep the garbage forever, so the join is refused instead. Enrolment and signup
also adopt the provenance of pulled notes the outbox edits — their current meta and body — since
the outbox holds only this device's own ops and an edit without its note would be skipped by every
recipient. Account switches (link, unlink, re-pull) wait for a sync already in flight, and every
trigger re-reads the keystore, so a switch in one tab is picked up by the others and nothing marks
ops pushed for an account that was just left behind.

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
- **A rich history costs requests.** Pages are 2,000 ops and the token bucket allows 10 burst / 30 per
  minute, so 20,000 ops land within the burst and the rest arrive with backoff.

## Conflict

When a pull lands a note whose server head is not an ancestor of the local head, both branches stay
in the log and the note shows the head with the highest `(lamport, device)`. Nothing is merged and
nothing is dropped, on any device: `applySnapshot` only overwrites the note when the op beats its body
stamp, and `heads()` reports every leaf, so both sides materialise the same tree.

There is no resolve action and no "seen" state. The version tree shows the fork with both heads, the
user reads either branch in its preview and resolves it by editing — which writes the text as a new
snapshot and leaves the other branch in the tree. Wall clocks never decide anything: only lamport and
device id do.
