# Varia

Varia is a note-taking app: a SolidJS PWA with a local SQLite database, and an optional Rust
backend that stores an end-to-end encrypted history of everything the client has ever written.

### Use cases

Personal notes, todo lists and lab-notebook-style capture, used daily on a phone and on a desktop
browser. Colleagues may run their own account on the same instance; they never see your notes.
Local use requires no account, no network and no server.

### Shape

- **Local-first.** The client's OPFS SQLite database is the truth while you work. Every change is
  an immutable op in an append-only log; the visible notes are materialised from it.
- **Two note types.** `note` is Markdown text, edited as text. `todo` is a list of items with stable
  ids and a done state, changed by item-level ops. Journal-style capture is ordinary notes plus
  tags, not a type.
- **Fine-grained history, kept forever.** Debounced whole-body snapshots for notes (parented, so the
  history of a note is a tree), one op per checklist item change for todos. Nothing is pruned.
- **Encrypted sync.** Ops are compressed, then AES-GCM encrypted on the client with a key the server
  never sees, and pushed to a Rust service that stores only ciphertext plus an opaque envelope. A
  second device is enrolled by pasting one string.
- **Search is client-side**, because the server cannot read the notes.
- **Targets**: installed PWA on iOS/iPadOS, tabs on current Firefox and Chromium.

### Operation

A single Rust binary serves both the API and the bundled frontend on one origin, so COOP/COEP
headers, the service worker and the sync endpoint all line up. State is one SQLite file on a
volume. Deployment mirrors `../acta`: container, Quadlet unit, Caddy terminating TLS in front.

### Layout

```
design/     these documents
PLAN.md     phases
service/    axum + SQLite (server)
ui/         SolidJS + Vite PWA (client)
```

### Decisions

D1 Owner-scoped accounts, no collaboration or sharing. Conflicts only ever happen between your own
devices.
D2 Two note types; text notes are Markdown, never a rich-text document model. The source is shown
with syntax highlighting rather than rendered into a separate view. No `journal` type.
D3 History is an append-only op log, kept forever; snapshots only when the body changed; concurrent
text edits stay as sibling branches.
D4 Client is SQLite (WASM) over OPFS in a dedicated worker, using the `opfs` VFS so SQLite's own
locking makes multi-tab safe. Requires COOP/COEP and Safari 17+.
D5 Server is axum + SQLite: an encrypted op log with auth, no note schema, no migrations of your
data model.
D6 Local storage is best-effort — iOS deletes script-writable storage for unused origins after ~7
days. The log on the server (or an export) is the real copy.
D7 Flat notes, tags, client-side FTS5 search; no folders.
D8 End-to-end encryption with a client-generated root key, HKDF subkeys, non-extractable at rest.
Losing every device and the enrolment code loses the data permanently.
D9 One op log for all note types, one push/pull cursor protocol, client-side materialisation.
D10 Todos are item ops, never whole-list snapshots.

Detail and rationale per area:

- `002-data-model.md` — client tables, op kinds, materialisation, history and tree semantics.
- `003-sync.md` — accounts, encryption, endpoints, cursors, limits, conflict policy.
- `004-client.md` — frontend structure, worker boundary, editors, PWA behaviour.
- `005-service.md` — server, deployment, backups, operations.

### Open questions

- Local data at rest is unencrypted; only the server copy is. Rely on device encryption, or add a
  passphrase to unlock OPFS later?
- "Mark conflict resolved" cannot be derived from the tree, so it needs stored state when the
  version tree view is built — op kind or client-only flag?
- Rate limits and the 500 MB cap are first guesses; tune against real sync volume.
