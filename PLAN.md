# Plan

Each phase is shippable on its own. Later phases must not force a change to the decisions in
`design/`; if one does, fix the doc first.

## Phase 0: Spike the two unknowns

Prove or kill the client foundation before writing the app around it.

- [ ] sqlite-wasm `opfs` VFS in a worker: write, reload, and a second tab reading and writing the same
      database — in an installed iOS PWA
- [ ] a non-extractable `CryptoKey` stored in IndexedDB survives an app restart on iOS
- [ ] app shell loads and works offline under COOP/COEP with the service worker

Exit criteria: a hardcoded note survives restarts on iOS and desktop Firefox, and two tabs both see
each other's writes. If the `opfs` VFS fails on iOS, stop and reconsider D4 before building anything.

## Phase 1: Local-only MVP

A usable offline notebook. No server, no accounts, no encryption.

- [ ] ops + materialisation, schema and migrations
- [ ] notes: list, create, edit Markdown, delete, tag
- [ ] todos: item list, check/uncheck, append, hide-done toggle, show-done
- [ ] history: version list per note with restore; per-item history for todos
- [ ] search over note bodies and todo items
- [ ] PWA: installable, offline shell, persistence request

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
