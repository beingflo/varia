# Client

SolidJS + Vite PWA, local-first: the UI is never blocked on the network and only needs it for sync.

## Structure

```
ui/src/db/       sqlite-wasm worker, schema/migrations, materialiser, repo functions
ui/src/sync/     key handling, enrolment code, push/pull loop, triggers
ui/src/views/    Notes, Note, Todo, Dashboard, Tag, History, Search, Account
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

The open view is in the address bar as `/note/<id>` or `/tag/<name>` and reopened on load, so a
reload or a bookmark lands on the same place. Written with `replaceState`: moving between views is
not a history trail.
The path form needs the host to serve `index.html` for unknown paths — the single-binary service
does; a static host needs the SPA fallback configured.

## Tag streams

A tag is a stream, not a note type: `/tag/<name>` lists the text notes whose tag line names it, whole
bodies, newest first (`created`, never `updated` — fixing a typo in last week's entry must not move
it). Nothing is stored for the view.

- **The stream is dumb on purpose.** No CodeMirror: entries are the body as text, in the app's font
  with `pre-wrap`. Markdown is not interpreted, so an entry's first line keeps its `#`. Editing
  happens in the note view, one click away through the timestamp.
- **The tag line closes each entry**, on its own line, hugging the text, muted and a point smaller —
  the same line the editor draws muted. Repeating it is the point: it is the entry's own record of
  which streams it belongs to, in a `log` stream that mixes `#work` and `#urgent`.
- **The timestamp is a real link** to `note/<id>`, right-aligned and top-aligned with the entry, so
  ⌘-click opens a tab. Under 60rem it moves above the entry: a rail would take a quarter of the
  column.
- **The stream is a column, not the screen**: 88rem (1408px) centred, the timestamp in its right
  gutter, the entry text taking what is left. On a phone it is the screen minus its padding.
- **`created` is the writer's clock.** Ordering across two devices therefore assumes roughly correct
  clocks; within a note, the version tree is the causal record.
- **25 entries a page**, then a `load older` button. No virtualisation: the render is text, not
  editors, and the `log` stream is the only one that gets long.
- **Boards are named, not dumped.** A body that is a board would render as JSON tile lines, so it
  renders as `title — ▦ 3 tiles`. That makes the `dashboard` tag a working index of boards.
- Todo notes do not appear (their text lives in `todo_item`, so a text render would be empty).

The header is the tag's name on the left, in ink and without its `#` — the stream is already the
tag, so the hash would be a second label for the same thing. In the far corner, how many entries it
holds (`3 entries`), small. The view has no button.

Writing an entry: `⌘J` (on a phone, the bar's `new entry` then `save`) opens one editable draft at the
top. The note on disk is the draft's text plus a tag line (`#log` and the stream's tag), written on
every save of that draft's session; the **document never holds that line**, so the caret cannot land
after it and a `⌘↓` before typing cannot quietly cost the entry its tag. Only `⌘S` ends the draft, and
only after the flush, so the entry is on disk before it turns read-only; a background flush (sync,
tab hidden) saves silently and leaves you writing. Nothing typed, nothing created. Once the entry
exists, editing it is ordinary note editing — the tag line is in the body then, and keeping it last
is the writer's business: no editor fence, no normalising on save.

The palette is three sections in that order: notes, log entries, tags. Notes and logs both answer the
query — the note section excluding `log`, the log section limited to a few rows plus a count — and
the tags sit below them, since a stream is a shortcut, not a result: listed before anything is typed,
prefix match, and a leading `#` asks for tags only. The cursor walks the same order it shows. The
note list itself hides `log` notes: the default screen stays notes.
A note shows its tags where they are written: the last line is drawn muted in the editor, so the
footer reads as a footer. No chip row on the note, in a tile or in the stream — the palette is how
you get to a stream.

## Dashboards

A dashboard is a note whose body holds a tile layout (`002-data-model.md`), opened as a page over
the whole viewport — no `--measure` page box, its own container, the tiles carry the reading column.
The note list marks one with `▦`, and `⌘⇧B` makes one.

- **Tiles are the ordinary views.** A tile mounts `NoteView` or `TodoView` with `embedded`, which
  drops the page frame, the caret grab, the history overlay and the view-level commands; everything
  below that (flush queue, `edits`, per-item writes, undo history) is per instance and unaffected.
  Several CodeMirror instances are cheap: measured on this editor, 12 mounted editors cost 6 ms of
  mount time and 0.2 ms per keystroke.
- **The board is ruled, and only where there is a gap.** Two repeating gradients on `.board-grid`
  draw a hairline down the middle of every column and of every third of the height — a tile is 2, 4
  or 6 sixths tall, so a rule per sixth would cut one where it can never end. A tile is filled with
  the page colour, so it covers those rules and they appear only in the empty space: a continuous
  line down a column nobody occupies, a short crossing where a row rule passes it. The ink is `--rule`
  (40% of `--fg`, darker than `--line`: it is the only structure there is). No title bar: the note's
  own first line names it, and the controls (open, move up/down, width, height, remove) are inset in
  the top right corner, showing on hover or focus and always on a coarse pointer, where there is no
  hover. Under 60rem the rules are off, because nothing is shared there anyway.
- **A tile's note fills it.** `.tile-body` grows to the tile and the note's wrapper with it, so the
  empty space below a one-line note is still a click target: clicking there focuses the editor at
  the end of the text, the same contract the full-page editor has where its wrapper fills the
  viewport. The reading measure (`--measure`) is dropped inside a tile: the tile's width is the
  measure, chosen per tile with the width number.
- **A board writes on every action.** Adding, moving, resizing or removing a tile is one click and
  one `note_snapshot` of the whole layout — no debounce, no dirty state, and `saveBody` writes nothing
  when the body is unchanged. The title is the only typed field, so it is registered as a flush:
  committed on blur, on ⌘S, before a sync, and before a command leaves the view.
- **Sizes are shares of the board.** Width is 1–3 columns of a three-column grid; height is 2, 3 or
  6 sixths of the room left under the board header, that is a third, a half or all of it. The grid
  places the tiles itself, so a full-height tile keeps its column and the next tiles stack beside it,
  and a tile that no longer fits moves to the next free place instead of being squeezed in. Nothing
  is in pixels, so a board reflows, and three short tiles fill the viewport exactly. Under 60rem
  there is no sharing at all: every tile is full width and the width number stops mattering, so a
  phone gets one stacked column whatever the board says.
- **A tile keeps its size.** It never changes size under the pointer: it scrolls its own content,
  and the caret stays visible because CodeMirror scrolls the nearest scrolling ancestor (measured: a
  60-line note in a third-height tile scrolls the tile, not the board).
- **One view's commands for many views.** `save` is broadcast to every registered flush, because a
  board has several views and no single one to pick. Everything else stays the one view that owns
  it: `delete` deletes the board itself (never the notes it points at), and a board registers no
  `history`, so versions are off there — those act on one note, and a board is many.
- **Grid, not canvas.** No absolute positions, no drag: order and two numbers, edited from the
  tile's corner. It reflows, it is reachable by keyboard and touch, and it needs no pointer maths.

## Editing

- **Notes**: a CodeMirror 6 editor over the Markdown source. Highlighting, list continuation
  (Enter continues `-`/`1.`, enters increment, an empty item exits the list), Tab nesting and fenced
  code highlighting all live in the editor; the document is still plain text, so the log, history and
  sync see exactly what a textarea would have written. Links (markdown links, autolinks and bare
  `http(s)` URLs) are underlined and open with ⌘/Ctrl-click, never a plain one: a URL is still text
  to put a caret in. ⌘/Ctrl+F is the editor's own search, not the browser's find: CodeMirror renders
  only the viewport, so the browser's find can neither see nor scroll to text further down a long
  note. The syntax highlighting is the reading aid: a separate rendered view is not planned. Vim mode is a possible later addition (`PLAN.md`), the reason
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
- **History is read-only**: the version tree for a note, drawn git-style from `parent_id`, beside the
  selected version's body and a line diff of it against its parent (`lib/diff.ts`, one read of the
  pair), plus per-item history for a todo item. Rows carry id, time
  and state only — no body, no snippet — and a version's body is fetched when it is selected, so a
  long history is one small query. Nothing on this screen writes; restoring means copying text or
  editing it in. Divergence has no UI state: the tree shows the fork, the note view says nothing.
  Everything reads off the local log, so it works offline; todo lists have no versions.

### Touch screens

A coarse pointer or a window under 700px has no keyboard, so the same commands are buttons in a bar
across the top (never the bottom: that is the iPhone's curve and pull-up gesture): notes, new note,
new list, versions — a list gets the show-done toggle instead — and sync.
`viewport-fit=cover` and `env(safe-area-inset-*)` keep the bar and the close buttons clear of the
status bar, the sync dot clear of the home indicator. Overlays get a visible close, a todo row's bullet is its checkbox, and the history tree stacks
above the preview instead of sitting beside it. The bar only dispatches the ordinary commands, so no
behaviour differs between the two.

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
recovery path after iOS evicts storage, so it must feel like a first-run load. Measured with the
sqlite-wasm build, real envelopes, 500-op pages: 1k ops 0.17 s, 5k 0.9 s, 20k 2.8 s — about 0.15 ms
per op, CPU-bound, with file I/O adding less than that. The pull runs behind `data-db="ready"`, so
notes stream in while the app is usable. The wall clock past the burst is the service's limiter
(10 burst, 30 per minute) rather than the replay, so `pull_limit` was raised from 500 to 2,000 —
20,000 ops in 11 requests instead of 41 — which is the lever to reach for before a `checkpoint` op
kind (`PLAN.md`).

## Sync

`ui/src/sync/` holds the whole client side: `crypto.ts` (envelope and enrolment code), `client.ts`
(one push-then-pull round trip), `engine.ts` (triggers, status, account) and `keystore.ts`
(IndexedDB). The engine is created once in `App` and handed down through `SyncProvider`, so the
overlay in `components/Sync.tsx` is testable against a fake engine.

The view shows only what the engine's status says: `synced now · nothing pending`, `3 pending`,
`sync failed — 429 rate_limited`, usage against the cap, how old the last sync is, a count of
changes too large to travel, and the enrolment token only. The same status is a dot in the
bottom-right corner on every screen
(`components/SyncDot.tsx`): green after a good sync, a slow pulse while one runs, a hollow grey ring
when the last attempt failed, and nothing at all when sync is off.

Enrolment validates the key against the account before the first push — a pull probe, and a join
refused when every sampled op fails to open — because a wrong key would poison the log with
ciphertext nobody can decrypt. Signup and enrolment also rewind the outbox and adopt the
provenance of pulled notes, and account switches wait for a sync already in flight; every trigger
re-reads the keystore, so a switch made in one tab is picked up by the others. Not enrolled, the panel takes the token and the key in two fields with a filled primary
button under them (`join this device`, disabled until both are pasted; Enter does the same) and,
below a rule, a separate quiet button for `create a new account` — joining and starting fresh are
different actions and never share a control. Signup answers with both strings on a screen that says
the key is shown once and cannot be recovered; dismissing it leaves the enrolled view.

`unlink this device` sits below the token, behind a second click, and does two things: forgets the
token and the derived key in IndexedDB, and turns the local op log back into an outbox
(`pushed = 0`, cursor `0`, remote-dedup rows dropped). Notes are never touched, so unlinking and
creating a new account uploads the entire local history to the new one.

`purge local data` is the other direction, in red and behind a second click: pending flushes are
allowed to land, then flushing is sealed off, the account is forgotten, and every table but `meta`
is emptied — the device id stays, so this is the same installation, emptied. The page reloads into a
draft. The server's log is untouched, so signing in again brings every note back: it wipes the
device, not the account. It deletes **rows, not the schema**: a database whose tables came from an
older build stays old-shaped, which is what `migration5` (`002-data-model.md`) repairs on open.

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
`Esc` back to the list. A tag is a line at the end of a body, drawn muted. Everything tappable is
keyboard-reachable, checkboxes are real checkboxes with labels, and motion respects
`prefers-reduced-motion`.
