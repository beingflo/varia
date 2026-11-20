# Plan

Each phase is shippable on its own. Later phases must not force a change to the decisions in
`design/`; if one does, fix the doc first.

## Phase 0: Spike the two unknowns

Prove or kill the client foundation before writing the app around it.

- [x] sqlite-wasm `opfs` VFS in a worker: write, reload, and a second tab reading and writing the same
      database — in an installed iOS PWA
- [x] desktop Firefox: `opfs` VFS works (3.54.1), the database survives a browser restart with
      writes from two sessions visible, and a non-extractable `CryptoKey` in IndexedDB still decrypts
      a ciphertext written before the restart
- [x] the same two checks on an installed iOS PWA
- [x] app shell loads and works offline under COOP/COEP with the service worker

Findings: the `opfs` VFS, multi-tab writes and non-extractable key persistence all hold on iOS 17+
(installed PWA included). A home-screen app gets separate storage from Safari, so a fresh install
starts empty — expected, and the reason sync recovery matters. Firefox refuses `exportKey('raw')`
on HKDF keys, which is why the root key is generated as bytes rather than as an exportable key.

Exit criteria: a hardcoded note survives restarts on iOS and desktop Firefox, and two tabs both see
each other's writes. If the `opfs` VFS fails on iOS, stop and reconsider D4 before building anything.

## Phase 1: Local-only MVP

A usable offline notebook. No server, no accounts, no encryption.

- [x] ops + materialisation, schema and migrations
- [x] notes: list, create, edit Markdown, delete, tag
- [x] todos: item list, check/uncheck, append, hide-done toggle, show-done
- [x] history: version list per note with restore
- [x] search over note bodies and todo items
- [x] PWA: installable, offline shell, persistence request (best effort)
- [x] debug overlay: every table incl. the op log, row detail, `⌘/Ctrl+Shift+D` or `?debug`, isolated in
      its own chunk, shadow root and error boundary

Testing is part of every phase from here on: the worker/handler split means the same code that runs
in the browser is what the component and data tests exercise, and `data-db="ready"` on `<html>` is
the readiness marker the browser tests wait on.

## Phase 2: Sync

- [x] service: signup, tokens, `/api/sync`, cap, rate limits, WAL, headers (`server/`, 10 tests)
- [x] client: key, envelope, enrolment code, outbox, cursors (`ui/src/sync/`, 11 tests + one guarded
      test against a live service)
- [x] client: triggers (push on write, start, foreground, 60 s timer, hidden flush), enrolment
      overlay (`⌘⇧S`: paste a code or create an account), sync status and manual sync
- [ ] conflict policy as decided: highest lamport head wins, both branches retained
- [x] single binary serving the bundled UI: Containerfile (~108 MB, verified by running it locally),
      quadlet unit, `mise run deploy` modelled on acta's (no secrets to ship), `mise run dev|test|test:e2e`

## Phase 3: Finalize

- [x] favicon and install icons: `ui/public` (svg, ico, apple-touch, 192/512, maskable)
- [x] landing page at `/landing`: features and the shortcut table (read from `BINDINGS`, so the page
      cannot drift from the keys that work). `/` is the landing until `varia:entered` is set by
      "use now" or by the app itself, then the app; a deep link or `/app` (the installed `start_url`)
      goes straight to the app. The app is a dynamic import, so the landing never loads the worker.
- [ ] iOS install flow and first-run guidance
- [ ] inline sync status next to the note stamp (the `⌘⇧S` overlay already shows it)
- [ ] eviction recovery: token present + empty database → full re-pull from cursor 0
- [ ] measure cold-start replay and decide whether checkpoints are needed
- [ ] Backup mechanism

## Phase 4: Advanced, unordered

- [ ] observability in acta
- [x] version tree view: git-style lanes from `parent_id`, read-only body pane, no resolve action
- [ ] compare two heads side by side (a diff, not a preview): the tree shows divergence, it cannot
      yet show what differs
- [ ] vim mode for the note editor (pick the implementation then; the editor is behind one component)
- [ ] quick capture: `…/?q=work buy milk` opens the `work` todo list with a new item appended
- [ ] tags: derive them from the note body (e.g. `#tag` lines) instead of an input field
- [ ] tag timeline: all notes under a tag as one time-ordered stream (journal-style capture)
- [ ] export: zip of `*.md`, todo JSON and the raw op log; import that restores an account
- [ ] warn when changes have been unsynced for days
- [ ] token revocation and multiple tokens per account
- [ ] todo reminders
- [ ] landing copy: rewrite the feature text and settle the section order
- [ ] drag and drop for list items, with the bullet as the grab handle: pointer-based (no library),
      y picks the target row, x picks the depth, edge autoscroll, plus ⌥↑/⌥↓ to move and ⌥→/⌥← to
      nest for keyboard parity. A move is one existing `todo_item` op carrying `ordering` and
      `depth`, so it syncs as it is; `between` needs a gap check with an occasional renumber of the
      siblings, since dragging can exhaust the midpoint precision (~50 times in the same gap).
      A library only earns its place if dragging must work on a phone, where long-press versus
      scroll and autoscroll are the expensive parts.
- [ ] `note_patch` ops and content-addressed chunk dedupe, when snapshot volume hurts
- [ ] `checkpoint` ops for fast fresh-device bootstrap

## Not planned

Collaboration, sharing, folders, server-side search (impossible under E2EE), CRDT merge, native apps,
end-to-end encryption of the local OPFS database.
