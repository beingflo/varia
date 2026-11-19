# Client

SolidJS + Vite PWA, local-first: the UI is never blocked on the network and only needs it for sync.

## Structure

```
ui/src/db/       sqlite-wasm worker, schema/migrations, materialiser, repo functions
ui/src/sync/     key handling, enrolment code, push/pull loop, triggers
ui/src/views/    Notes, Note, Todo, History, Search, Account
ui/src/components/  editor, checklist, tag bar, sync status, version list
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

## Editing

- **Notes**: a plain `<textarea>` with the Markdown source. A rendered reading view is a later
  feature and must not change the storage format.
- **Snapshotting**: after ~1.5 s idle, plus on blur, on navigate away and on `visibilitychange →
  hidden`. If the body equals the parent version's body, no op is written.
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

## PWA

`vite-plugin-pwa` precaches the app shell, including the sqlite wasm and worker chunks; there is no
runtime caching of API responses because sync is application logic, not an HTTP concern.

- Installed iOS PWA is the primary mobile target; the shell must work offline from the first launch
  after install.
- `navigator.storage.persist()` is requested once and its refusal ignored — it does not stop the
  iOS 7-day deletion rule.
- Sync triggers on start/foreground/hidden plus a 60 s timer while visible; anything missed is caught
  up on next open.

## Tests

- Data layer and components run under vitest against `node:sqlite` (same SQLite version as the wasm
  build) through `db/inProcess.ts`, which exposes the identical handler surface the worker serves.
- The views are tested with `@solidjs/testing-library` against that repo, not a mock, so a test that
  clicks "restore" reads the same rows the app would.
- Flow-level behaviour (persistence across reload, two tabs, the todo lifecycle) runs in Playwright
  against a real server, because cross-origin isolation, OPFS and BroadcastChannel only exist there.
  The app sets `data-db="ready"` on `<html>` once the database answered; browser tests wait on that
  instead of on view-specific markup.
- Engines: Chromium by default, Firefox via `VARIA_E2E_BROWSERS=firefox`, both passing. Playwright's
  WebKit cannot run these tests — its OPFS is broken in that build — so iOS is verified on a device
  instead. Tests assert observable database effects (a title appearing, a label changing after the
  view re-reads) rather than sleeping, since a save is asynchronous by design.

## UI rules

One column, no chrome, no dashboards. Keyboard-first: `Cmd/Ctrl-K` search, `Cmd/Ctrl-N` new note,
`Esc` back to the list. Tags are chips above the list and above the note. Everything tappable is
keyboard-reachable, checkboxes are real checkboxes with labels, and motion respects
`prefers-reduced-motion`.
