# Plan

Each phase is shippable on its own. Later phases must not force a change to the decisions in
`design/`; if one does, fix the doc first. Tests come with every change.

## Phase 0: Spike the two unknowns

- [x] sqlite-wasm `opfs` VFS in a worker: write, reload, and a second tab writing the same database
- [x] desktop Firefox: survives a restart, two sessions see each other, a non-extractable key in
      IndexedDB still decrypts
- [x] the same two checks on an installed iOS PWA
- [x] app shell loads and works offline under COOP/COEP with the service worker

## Phase 1: Local-only MVP

- [x] ops + materialisation, schema and migrations
- [x] notes: list, create, edit Markdown, delete, tag
- [x] todos: item list, check/uncheck, append, hide-done toggle, show-done
- [x] history: versions of a note
- [x] search over note bodies and todo items: an FTS5 index, every word of the query matched as a
      prefix and all of them required (`design/002`, `design/004`)
- [x] PWA: installable, offline shell, persistence request (best effort)
- [x] debug overlay: every table incl. the op log, `⌘⇧D` or `?debug`, own chunk and error boundary,
      plus a search probe: documents vs notes, duplicates, the query plan and how long a search took

## Phase 2: Sync

- [x] service: signup, tokens, `/api/sync`, cap, rate limits, WAL, headers
- [x] client: key, envelope, enrolment code, outbox, cursors
- [x] client: triggers, enrolment overlay (`⌘⇧S`), sync status and manual sync
- [x] conflict policy: highest lamport head wins, both branches retained
- [x] single binary serving the bundled UI: container image, quadlet unit, `mise run deploy`

## Phase 3: Finalize

- [x] favicon and install icons
- [x] landing page at `/landing`, `/` routes by the `varia:entered` flag, `/app` for installed windows
- [x] sync state dot in the bottom-right corner on every screen
- [x] eviction recovery: an empty database reads its cursor as 0, so the whole log replays
- [x] measure cold-start replay and decide whether checkpoints are needed: 1k/5k/20k ops replay in
      0.17/0.9/2.8 s (sqlite-wasm, real crypto), never blocking the UI. Past the burst it is the
      service's request bucket that sets the wall clock, not the replay, so `pull_limit` went from
      500 to 2,000 ops per page: a full 20,000-op replay is now 11 requests instead of 41
- [ ] Backup mechanism

## Phase 4: Advanced, unordered

- [ ] observability in acta
- [x] dashboards: a note whose body holds the layout — one JSON line per tile, the last line the tag
      `#dashboard` — opened as a page of editable tiles (the note and list views, `embedded`), sized
      in thirds of the board, ruled in the gaps, saved on every action (`design/002`, `design/004`)
- [x] version tree view: lanes, fork markers, read-only body pane, diff against the parent
- [ ] vim mode for the note editor (the editor is behind one component)
- [ ] quick capture: `…/?q=work buy milk` opens the `work` todo list with a new item appended
- [x] tags: the last line of a body names them (`#work #urgent`, nothing else on the line), derived
      into `note_tag` on every body write on every device, backfilled once for older notes; search
      splits notes from log entries by their first line and lists tags, a note shows its tags as
      chips (`design/002`)
- [x] tag stream: `/tag/<name>` lists the notes under a tag newest first, whole bodies, a timestamp
      rail, `⌘J` files an entry tagged with the stream's tag (`design/004`)
- [ ] export: zip of `*.md`, todo JSON and the raw op log; import that restores an account
- [ ] token revocation and multiple tokens per account
- [ ] todo reminders
- [ ] screen showing deleted notes for recovery
- [ ] landing copy: rewrite the feature text and settle the section order
- [ ] drag and drop for list items: pointer-based with the bullet as the handle, `ordering` and `depth`
      in one `todo_item` op, `⌥↑`/`⌥↓` to move and `⌥→`/`⌥←` to nest
- [ ] `note_chunked` bodies with content-addressed chunks, once measured storage says so (`design/002`)
- [ ] `checkpoint` ops for fast fresh-device bootstrap, only if a real account passes ~5k ops

## Not planned

Collaboration, sharing, folders, server-side search (impossible under E2EE), CRDT merge, native apps,
end-to-end encryption of the local OPFS database.
