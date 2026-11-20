# Data model

Everything the client shows is materialised from an append-only log. The client owns the schema;
the server stores the same log encrypted and without a schema of its own (`003-sync.md`).

## Ops

An op is one immutable change, identified by a random 128-bit `id` the client picks when it appends.
Not a counter: a counter is guessable (a stolen token could squat a device's next number and have the
server dedupe swallow the real op) and two copies of one database would reissue the same numbers.
The server adds a per-owner `server_seq` used only as a pull cursor.

| kind            | payload                                              |
| --------------- | ---------------------------------------------------- |
| `note_meta`     | `{note_id, kind, title, tags[], deleted}`            |
| `note_snapshot` | `{note_id, version_id, parent_version_id, body}`     |
| `todo_item`     | `{note_id, item_id, text?, done?, deleted?, order?}` |

Every op also carries `lamport` and a wall-clock `created` (display only).

- `note_meta` is last-writer-wins as a whole object: it creates a note, and covers rename, tagging
  and the tombstone.
- `note_snapshot` carries a whole compressed body, `parent_version_id` pointing at the version it
  was written from, and is only written when the body differs from that parent.
- `todo_item` carries only the fields it changes, so a check-off is a few dozen bytes.
- Future kinds slot in next to these: `note_chunked` (manifest of content-addressed chunks, below)
  and `checkpoint` (materialised state up to a `server_seq`) for fast bootstrap. Not `note_patch`: a
  stored diff makes every future reader depend on one diff implementation.

A kind a client does not know is skipped, not an error, and deliberately without an `op_seen` row:
the pull cursor still advances, so an old client keeps syncing, and the op is applied by the same
device once it has been upgraded or the log is re-pulled (`repair`).

`lamport` starts at 1 on a new device and is `max(all lamports seen) + 1` for any local change.
Ties break on device id. It is the only ordering authority; wall clocks are for labels.

## Client tables

Log (source of truth, doubles as the push outbox):

```
op(id, device, kind, note_id, payload, created, pushed)    -- PK(id)
op_seen(id)                      -- idempotency on pull
meta(cursor, cursor_account)      -- pull position, valid only for the account it was pulled under
sync_state(device, server_cursor, last_sync_at)
```

Materialised (cheap to rebuild by replaying `op`):

```
note(id, kind, title, body, created, updated, deleted, lamport, device)
version(id, note_id, parent_id, body, lamport, device, created)
todo_item(id, note_id, text, done, ordering, deleted, lamport, device)
todo_item_op(id, item_id, note_id, fields, lamport, device, created)  -- per-item history index
tag(name), note_tag(note_id, name)
```

Every local change writes the op and updates the materialised rows in one transaction. Nothing in
the materialised tables is authoritative: it can be dropped and rebuilt.

**Migrations are append-only steps, and `migration1` is frozen.** It was edited in place once (ops
keyed by `(device, seq)` became ops keyed by `id`), which left every database created before that
change in the old shape: `CREATE TABLE IF NOT EXISTS` has nothing to do, so writes failed with
`table op has no column named id` for ever, and purging did not help because a purge deletes rows,
not tables. `migration5` repairs those databases by rebuilding `op`, `todo_item_op` and `op_seen`
with the derived ids `device-seq`, keeping the `pushed` flags. Real changes to a shipped shape go in
a new step — step functions may inspect `PRAGMA table_info`, and `migrate` runs them inside the same
transaction it bumps `user_version` in.

### Tags

A tag is body text, never an op of its own: the last line of a body, and only when that line is
nothing but tags (`#work #urgent`) names them. `note_tag` is an **index over the body**, written by
both paths that write one — a local `note_snapshot` and a pulled one — so a note re-derives the same
way whichever device wrote it, and deleting the line is untagging. `tag` is the name table the
palette lists.

`#dashboard` is indexed like any other tag; nothing is special about it in the data model, only in
how a client chooses to render the note. Bodies written before the index existed are scanned once on
open, flagged in `meta(tags_indexed)`.

`note_meta` still carries a `tags[]` field and its replay writes `note_tag` too. Nothing on the
client sets it any more: it is the shape an older peer sends, and the next body snapshot of that
note overwrites it with what the body says.

## Note history

`version.parent_id` makes the history of a note a tree.

- **Heads** are the leaves: `SELECT … WHERE id NOT IN (SELECT parent_id FROM version WHERE parent_id
IS NOT NULL)`. One indexed query, no recursion.
- **Current body** is the head with the highest `(lamport, device)`. With two heads, the lower one
  stays reachable in history and the note view says so.
- **Reading history writes nothing.** The tree lists ids and times only; a selected version is
  fetched with the body it was written from (`versionPair`), one small query that feeds both the
  text and a line diff against its parent — never one body per row.
- **There is no resolve action.** A second head appears when another device wrote from the same
  version (design/003); the tree shows it, and the user resolves it by editing or by copying text out
  of the preview. No merge op exists, none is planned, and nothing tracks "which branch I have seen":
  the log is the whole record, and an old version can always be brought back by editing.
- **Branches are permanent.** A branch head stays a head until someone writes on top of it; there is
  no order in which they collapse, and the note shows the head with the highest `(lamport, device)`.

## Todo history

Each item change is an op, so a `work` list that has run for years keeps its ops small and its item
history complete. Materialisation is per field: a field takes the value of the highest-lamport op
that set it, so concurrent check-off and rename do not fight.

- `deleted` is a tombstone: the item disappears from the list, its ops stay.
- `ordering` is a fractional value; inserting between neighbours uses the midpoint, with no renumbering.
- Done items are hidden by default in the UI, not deleted.

## Dashboards

A dashboard is a `note`, not a kind: no schema change, no new op kind, nothing the server could
care about. What makes it one is its body.

```
# Work

{"note":"a3f…","w":2,"h":1}
{"note":"9b1…","w":1,"h":1}

#dashboard
```

- The first line is the title heading, so `titleFromBody` and therefore the note list keep working.
- One tile per line, `{note, w, h}` with the note id and two shares, each 1–3: the width is that
  many columns of the board's three, the height a third, a half or all of the room left under the
  board header. One line per tile is what makes a layout change one changed line in
  the version tree below, so the history pane shows arrangement diffs for free — and restoring a
  layout is copying an old version, like any other note.
- The last line is the tag line: the tag `dashboard` is what the client reads to render a board
  instead of text (D7). It is content, not metadata: press Backspace once too often and the note is
  a text note holding some JSON, which is recoverable by retyping it.
- Reading is tolerant (`lib/board.ts`): lines that do not parse are dropped and a body that was
  hand-edited or half-synced opens as a board with the tiles it can read. Duplicated ids keep one
  tile, out-of-range sizes are clamped, a board inside a board is refused.
- Writing a layout is a `note_snapshot` op, so two devices arranging the same board at once fork two
  versions like any other text edit: last writer wins the body, the other arrangement stays in the
  tree. A tile op, or merge, would cost a schema and an op kind for a gesture nobody repeats often.
- A tile only points at a note. Deleting a board deletes no note; deleting a note leaves a tile that
  says so rather than silently shrinking the layout.

## Sizes

Whole-body snapshots are the deliberate cost of D3: a 4 KB note edited 30 times a day costs ~45 KB a
day compressed on the server, and about twice that on the device — the body is stored both in
`op.payload` and in `version.body`. Todo ops are ~100 bytes.

### Chunked bodies: decided, not built

Deferred until measured growth says so (`PLAN.md`): months of real use, then the two numbers —
`navigator.storage.estimate()` locally and "X of Y MB used" in the sync panel.

- A new kind `note_chunked` beside `note_snapshot`, which stays for tiny bodies and whenever the
  chunked payload is not smaller. Never a payload change to `note_snapshot`: an old client knows that
  kind, would read `body` as `undefined`, and skipping unknown kinds cannot save it.
- Payload `{version_id, parent_version_id, chunks[], blobs{hash: text}}`. `chunks` is the complete,
  ordered manifest of that version's body; `blobs` carries only chunks not already in the parent's
  manifest. Complete manifest plus sparse blobs is what keeps the log self-describing — any version
  rebuilds from its own ancestry, so another implementation may skip the store and walk the chain
  instead. Sending only the changed *slots* would put a reading algorithm back in the code path,
  which is what rules out `note_patch`.
- Local materialisation: `chunk(hash, text)` and `version_chunk(version_id, ord, hash)`, both
  rebuildable; `version.body` retires and `versionBody` becomes one ordered join. The store is an
  index, not the truth.
- Wire dedupe reaches no further than the note's own ancestry; the local store still dedupes across
  all notes, which is where the storage win is. Global wire dedupe saves little and lets one lost op
  break versions in other notes.
- Keyframes: every ~20 versions of a note, and at any child of a fork, `blobs` carries the whole
  manifest, so a hole costs at most 20 versions of one note.
- The hash is frozen forever (manifests reference it). The chunker is not: a different one costs
  dedupe, never correctness.

What it cannot do: shrink what the server already holds. The log is append-only and the service
cannot tell a redundant op from a needed one, so old full-body ops stay and every fresh device
re-pulls them fat. A device can compact retroactively — rewrite old `op.payload` into manifests,
dedupe the texts, same op ids, nothing re-pushed — which is why shipping the writer early is worth it.
Shrinking the server log needs its own decision: a prune with a client-declared watermark (which
rewrites D6, bootstrap and eviction recovery), or a rebase onto a new account, which is what
export/import would make safe. Neither is planned.

A diff view needs none of this: it is a function of two bodies, both available today.
