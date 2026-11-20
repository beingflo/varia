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
- **Pulled versions**: a flush on a clean editor is not an edit. When the text on screen equals the
  last saved text, the flush takes the database's body instead of re-committing the old one, so a
  pull cannot be turned into a local version by the next blur or sync.
- **The sync overlay** claims Enter in the capture phase, so the key cannot open a new line in the
  note that still has focus behind it.
- **Snapshotting**: typing writes nothing. A snapshot op is committed when the editor loses focus,
  on `⌘S`, before the note list or another note is opened, before history opens, on `⌘D`/`⌘E`/`⌘⇧E`,
  and on `visibilitychange → hidden`. There is no idle timer: a note that is typed and never blurred,
  saved or left is not written. If the body equals the current one, no op is written.
- **Todos**: rows of checkbox + text, an always-present empty row at the bottom for appending,
  "show done" toggle (default off). Checking an item writes one `todo_item` op.
- **History**: the version tree for a note, drawn git-style from `parent_id` (lanes, forks, closed
  branches dimmed), read-only in a pane beside it, with per-item history for a todo item. Rows carry
  id, time and state only; a version's body is fetched when it is selected, so a long history is one
  small query. `keep this version` is the only write: it makes the text current and acknowledges the
  other branches. Everything reads off the local log, so it works offline; todo lists have no versions.
- **Divergence**: the note view names any head the user has not acknowledged yet and offers
  `compare`. Dismissing is per branch and lives on the branch itself in the tree, so the user picks
  which one to keep hearing about. The note view refreshes on `repo.onChange` — a pull can bring a
  branch while the note is open — but never touches the document being typed into.

### Todo lists

What is being typed lives in state (`edits`: row id → text), not in the input, and every write is
followed by a read of the list. So a row can be rebuilt at any moment — indent, remote op, reload —
without losing a keystroke, and there is one commit path (`writeText`) for blur, Enter, Tab, Backspace
and ⌘S. The typed text is only handed over once the reload carries it, and the add field is only
cleared if nothing else was typed in the meantime.

Two narrow exceptions to "the database is what is on screen", both because a keystroke can arrive
before a write could finish:
- A blank row created by Enter is on screen at once (`localRows`) and stays put across reloads until
  its own write lands, so typing can start immediately in the middle of a list.
- A draft already queued from the add field counts as "a row below" when Enter decides whether this
  row is the last one, since the list on screen is a write behind.

Writes go through one serial queue, so a check-off, an indent and a text edit cannot interleave.

Every sync flushes before it pushes, so a write of the row being typed into can start mid-word. A
write therefore only hands the input's text back if the input still holds exactly what it wrote;
anything typed after the write began stays an edit and is written next.

That pre-push flush is marked `background`: it saves the rows but never the add field's draft, since
turning a half-typed item into an item would park a copy above the field the caret is still in. A
flush on leaving the view does save the draft. When an item is created from the field, only the
submitted text is taken out of it — anything typed during the write stays as the next draft, rather
than riding along and repeating the item on the next Enter.

A new list starts with the caret in its title; reopening an existing one starts at the item field.
A list with no `id` is a draft, like the note editor: nothing is written until an item or a title
exists, so ⌘⇧E followed by ⌘E leaves no row behind. The first write creates the note (`ensureNote`,
guarded by an in-flight promise so two concurrent writes cannot create two notes) and the view tells
`App` its id afterwards.

⌘S commits whatever is being edited: a half-typed item in the add field (as Enter would), then the
focused item's text, then the title. Tab and Enter commit through the same path before they change
anything, so indenting a row never loses what was typed into it.

Enter on the **last** item moves the caret into the placeholder below the list, at that item's depth,
instead of creating a blank item: there is only ever one empty row on screen. Enter in the middle of a
list creates a row at once, because there is no placeholder there to carry the caret; if it is left
blank, the next insert drops it.

Backspace on an empty row removes it and puts the caret on the nearest row above that still exists
(not simply the previous one: a fast run of backspaces can drop two rows before either write lands),
then on the last row there is, then in the new-item field. The caret is never left on the body.

A row left empty and untouched is a placeholder, not an item: adding another item anywhere drops it,
so blank rows cannot pile up; an empty row that parents nested rows is kept. Empty rows are otherwise
left alone while the list is open, because an empty nested item is the step-out target.

## Sync UX

The account view holds the token, to copy out or paste in. Sync status is a
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
`sync failed — 429 rate_limited`, usage against the cap, how old the last sync is, and the enrolment
token only. Not enrolled, the panel takes the token and the key in two fields with a filled primary
button under them (`join this device`, disabled until both are pasted; Enter does the same) and,
below a rule, a separate quiet button for `create a new account` — joining and starting fresh are
different actions and never share a control. Signup answers with both strings on a screen that says
the key is shown once and cannot be recovered; dismissing it leaves the enrolled view.

`unlink this device` sits below the token, behind a second click, and does two things: forgets the
token and the derived key in IndexedDB, and turns the local op log back into an outbox
(`pushed = 0`, cursor `0`, remote-dedup rows dropped). Notes are never touched, so unlinking and
creating a new account uploads the entire local history to the new one. The inline
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
