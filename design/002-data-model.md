# Data model

Everything the client shows is materialised from an append-only log. The client owns the schema;
the server stores the same log encrypted and without a schema of its own (`003-sync.md`).

## Ops

An op is one immutable change, identified by `(device, seq)` — the device's own monotonic counter.
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
op(device, seq, kind, note_id, payload, created, pushed)   -- PK(device, seq)
op_seen(device, seq)              -- idempotency on pull
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
  stays reachable in history; the version tree view is the feature that surfaces both.
- **Restore** (or editing an old version) is a normal op: a new snapshot whose parent is the chosen
  version. It becomes current by lamport like any other write.
- A conflict badge later is just "more than one head"; marking it resolved needs stored state and is
  not designed yet.

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
