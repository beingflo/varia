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
- Future kinds slot in next to these: `note_patch` (diff against a base version), `checkpoint`
  (materialised state up to a `server_seq`) for fast bootstrap.

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

## Note history

`version.parent_id` makes the history of a note a tree.

- **Heads** are the leaves: `SELECT … WHERE id NOT IN (SELECT parent_id FROM version WHERE parent_id
IS NOT NULL)`. One indexed query, no recursion.
- **Current body** is the head with the highest `(lamport, device)`. With two heads, the lower one
  stays reachable in history and the note view says so.
- **Reading history writes nothing.** The tree lists ids and times only; a version's body is fetched
  when it is selected (`versionBody`), so a long history costs one small query, not one body per row.
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

## Sizes

Whole-body snapshots are the deliberate cost of D3: a 4 KB note edited 30 times a day costs ~45 KB a
day compressed. Todo ops are ~100 bytes. `note_patch` and content-addressed chunking are the known
upgrade paths, and both are additive — existing ops never change.
