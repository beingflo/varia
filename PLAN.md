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
- [x] tests: 38 vitest unit/component tests on the real schema, 7 Playwright flows covering
      persistence across reload, search, tags, restore, the todo lifecycle and two tabs — passing on
      Chromium and Firefox (`VARIA_E2E_BROWSERS=firefox`); Playwright's WebKit build has no working
      OPFS, so iOS stays a manual check on device

Testing is part of every phase from here on: the worker/handler split means the same code that runs
in the browser is what the component and data tests exercise, and `data-db="ready"` on `<html>` is
the readiness marker the browser tests wait on.

## Phase 2: Sync

- [ ] service: signup, tokens, `/api/sync`, cap, rate limits, WAL, headers
- [ ] client: key + enrolment code (text + download), device id, outbox, cursors, triggers
- [ ] conflict policy as decided: highest lamport head wins, both branches retained
- [ ] single binary serving the bundled UI, deployed like acta

## Phase 3: Mobile polish

- [ ] iOS install flow and first-run guidance
- [ ] sync status line and manual sync
- [ ] eviction recovery: token present + empty database → full re-pull from cursor 0
- [ ] measure cold-start replay and decide whether checkpoints are needed

## Phase 4: Advanced, unordered

- [ ] version tree view: browse the tree, open a note at any node, edit an old version, mark resolved
- [ ] rich reading view for Markdown
- [ ] quick capture: `…/?q=work buy milk` opens the `work` todo list with a new item appended
- [ ] tag timeline: all notes under a tag as one time-ordered stream (journal-style capture)
- [ ] export: zip of `*.md`, todo JSON and the raw op log; import that restores an account
- [ ] warn when changes have been unsynced for days
- [ ] token revocation and multiple tokens per account
- [ ] todo reminders
- [ ] `note_patch` ops and content-addressed chunk dedupe, when snapshot volume hurts
- [ ] `checkpoint` ops for fast fresh-device bootstrap

## Not planned

Collaboration, sharing, folders, server-side search (impossible under E2EE), CRDT merge, native apps,
end-to-end encryption of the local OPFS database.
