# Client

SolidJS + Vite PWA, local-first: the UI is never blocked on the network and only needs it for sync.

## Structure

```
ui/src/db/       sqlite-wasm worker, schema/migrations, materialiser, repo functions
ui/src/sync/     key handling, enrolment code, push/pull loop, triggers
ui/src/views/    Notes, Note, Todo, History, Search, Account
ui/src/editor/    CodeMirror wrapper (see below)
ui/src/components/  history, sync status
```

The worker owns the only SQLite connection. Views never send SQL: they call functions in
`db/repo.ts` (`createNote`, `saveBody`, `addItem`, `toggleItem`, `history`, `search`), which post a
request to the worker and resolve with plain data. One boundary, easy to test, no query strings
scattered through components.

## State

Solid stores hold the current note list, the open note and the sync status. Anything derivable from
the database is not kept in memory beyond the open view; a change re-reads the affected rows.

Two tabs share the database through the `opfs` VFS, so SQLite handles the locking. A tab that writes
pings `BroadcastChannel` so other tabs re-read instead of showing stale notes — a notification, never
a write path.

## Known issue: writes landing on disk

The `opfs` VFS lands writes asynchronously, so a page that reloads or closes within tens of
milliseconds of a write can lose that write, even though SQLite committed it and the row was already
on screen. Measured on Firefox: a reload 0 ms after a save loses the write, 50 ms loses the last op,
100 ms and beyond is safe. Chromium persists more eagerly and did not show it.

Not the durability pragmas: `journal_mode=DELETE` and `synchronous=FULL` produce identical results,
so it is the VFS write path, not commit syncing. What is not lost is anything the user did before
that window, and commits are only made on blur, `⌘S` or leaving the view, so the exposure is the
last edit rather than the last keystroke.

Mitigation, if it ever bites in practice: flush at `pagehide` inside the worker (close and reopen the
connection, or hold the unload for a settle delay). Not done: the fix costs a DB lifecycle change for
a window no user hits on purpose, and it should be measured again against the real worker first.

## Deep links

The open note is in the address bar as `/note/<id>` and reopened on load, so a reload or a bookmark
lands on the same note. Written with `replaceState`: moving between notes is not a history trail.
The path form needs the host to serve `index.html` for unknown paths — the single-binary service
does; a static host needs the SPA fallback configured.

## Editing

- **Notes**: a CodeMirror 6 editor over the Markdown source. Highlighting, list continuation
  (Enter continues `-`/`1.`, enters increment, an empty item exits the list), Tab nesting and fenced
  code highlighting all live in the editor; the document is still plain text, so the log, history and
  sync see exactly what a textarea would have written. The syntax highlighting is the reading aid: a
  separate rendered view is not planned. Vim mode is a possible later addition (`PLAN.md`), the reason
  CodeMirror was chosen over a hand-rolled editor or a WYSIWYG model.
- **Snapshotting**: typing writes nothing. A snapshot op is committed when the editor loses focus,
  on `⌘S`, before the note list or another note is opened, before history opens, on `⌘D`/`⌘E`/`⌘⇧E`,
  and on `visibilitychange → hidden`. There is no idle timer: a note that is typed and never blurred,
  saved or left is not written. If the body equals the current one, no op is written.
- **Todos**: rows of checkbox + text, an always-present empty row at the bottom for appending,
  "show done" toggle (default off). Checking an item writes one `todo_item` op.
- **History**: the version list for a note with a "restore this version" action, and per-item history
  for a todo item. Both read straight off the local log, so they work offline.

## Sync UX

The account view holds one thing: the enrolment string, to copy out or paste in. Sync status is a
single line — "synced 2 min ago", "4 changes pending", "sync off" — and the manual "sync now" lives
next to it. No progress bars, no conflict dialogs in v1.

A device that has a token but an empty database pulls from cursor 0 and replays; this is also the
recovery path after iOS evicts storage, so it must be fast enough to feel like a first-run load
rather than a restore.

## Sync

`ui/src/sync/` holds the whole client side: `crypto.ts` (envelope and enrolment code), `client.ts`
(one push-then-pull round trip), `engine.ts` (triggers, status, account) and `keystore.ts`
(IndexedDB). The engine is created once in `App` and handed down through `SyncProvider`, so the
overlay in `components/Sync.tsx` is testable against a fake engine.

The view shows only what the engine's status says: `synced now · nothing pending`, `3 pending`,
`sync failed — 429 rate_limited`, usage against the cap, and how old the last sync is. The inline
status line next to the note stamp is still open (`PLAN.md` phase 3).

## PWA

`vite-plugin-pwa` precaches the app shell, including the sqlite wasm and worker chunks; there is no
runtime caching of API responses because sync is application logic, not an HTTP concern.

- Installed iOS PWA is the primary mobile target; the shell must work offline from the first launch
  after install.
- `navigator.storage.persist()` is requested once and its refusal ignored — it does not stop the
  iOS 7-day deletion rule.
- Sync triggers on start/foreground/hidden plus a 60 s timer while visible; anything missed is caught
  up on next open.

## Debug overlay

`⌘/Ctrl+Shift+D` (or `?debug` in the URL, which is the only way on a phone) opens a read-only view of
the local SQLite database: every table with its row count, the rows themselves, the op log included,
and the selected row as pretty JSON.

It is built to be unable to hurt the app:

- loaded through a dynamic `import()` in its own chunk, so it costs the app nothing until opened;
- mounted into a shadow root with its own stylesheet, so neither side's CSS can reach the other;
- wrapped in an `ErrorBoundary` that renders a one-line failure inside the overlay;
- the parent never reads a failed resource (that throws in Solid), it shows the error as text instead;
- reads go through a whitelisted `debugTables`/`debugRows` handler — no arbitrary SQL from the UI — and
  a failure there rejects that one call only.

## Tests

- Data layer and components run under vitest against `node:sqlite` (same SQLite version as the wasm
  build) through `db/inProcess.ts`, which exposes the identical handler surface the worker serves.
  CodeMirror needs layout, so component tests substitute `editor/TextareaDouble` — same props, plain
  textarea — while the real editor's behaviour (continuation, nesting, highlighting) is covered by
  the browser tests.
- The views are tested with `@solidjs/testing-library` against that repo, not a mock, so a test that
  clicks "restore" reads the same rows the app would.
- Flow-level behaviour (persistence across reload, two tabs, the todo lifecycle) runs in Playwright
  against a real server, because cross-origin isolation, OPFS and BroadcastChannel only exist there.
  The app sets `data-db="ready"` on `<html>` once the database answered; browser tests wait on that
  instead of on view-specific markup. The debug overlay has its own flow test: it opens, reads the op
  log, and closing it leaves the editor's contents untouched.
- Engines: Chromium by default, Firefox via `VARIA_E2E_BROWSERS=firefox`, both passing. Playwright's
  WebKit cannot run these tests — its OPFS is broken in that build — so iOS is verified on a device
  instead. Tests assert observable database effects (a title appearing, a label changing after the
  view re-reads) rather than sleeping, since a save is asynchronous by design.

## UI rules

One column, no chrome, no dashboards. Keyboard-first: `Cmd/Ctrl-K` search, `Cmd/Ctrl-N` new note,
`Esc` back to the list. Tags are chips above the list and above the note. Everything tappable is
keyboard-reachable, checkboxes are real checkboxes with labels, and motion respects
`prefers-reduced-motion`.
