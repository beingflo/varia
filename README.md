# varia

Local-first notes and todos: an encrypted op log in the browser, synced by a
small Rust service. `PLAN.md` and `design/` describe the system.

## Where things run

Development happens in a smolvm machine described by `Smolfile`; the Mac keeps
the editor, git/jj and the deploy. The machine is a debian bookworm VM with the
repo at `/workspace`, `node`/`rust` from `mise.toml`, and no access to the LAN.

One alias runs a task in the machine: `m <task>` = `mise run <task>` there.

| Command                 | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `mise run vm:up`        | create the machine if needed, start it, install tools and dependencies |
| `m dev`                 | the service and the Vite dev server, together                          |
| `m test`                | typecheck, vitest and `cargo test`                                     |
| `mise run test:e2e`     | Playwright against the built app, Chromium and Firefox                 |
| `m shell`               | a shell in `/workspace`                                                |
| `m pi`                  | Pi in the machine, with the project's `.pi` settings and web tools     |
| `mise run deploy:build` | build the image in the `varia-build` machine, nothing else             |
| `mise run deploy`       | build, ship to `$VARIA_HOST`, restart the quadlet unit                 |
| `mise run vm:down`      | stop the machine, keeping its disk and Pi's sessions                   |
| `mise run vm:destroy`   | save Pi's sessions to the Mac, then delete the machine                 |
| `mise run vm:recreate`  | destroy, then up: re-reads the Smolfile and rebuilds everything        |

`deploy` and `deploy:build` stay on the Mac: the build runs in its own machine
(`Smolfile.build`) and only the finished image leaves it, so no SSH key or agent
ever enters a VM.

## State

- `ui/node_modules`, `server/target` and `.pi/npm` are volumes on the machine's
  own disk, emptied whenever `vm:up` creates the machine.
- Pi's sessions live in the machine and survive `vm:down`; `vm:destroy` copies
  them to `~/.local/state/smolvm/varia/pi-sessions`, which the next create
  restores.
- The dev database is `/var/lib/varia/dev.sqlite` inside the machine and dies
  with it. `.varia-dev.sqlite` on the Mac is only used by a Mac-side service.
- `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` never enter the machine: `vm:up`
  reads them from 1Password, and the `Smolfile` bindings only release them to
  their own API host.
- Vite (5173) and the service (8099) are published from `Smolfile`; inside the
  machine both therefore listen on all interfaces.

## Editing

`Smolfile` is read when the machine is created. After changing it:
`mise run vm:recreate`.

The whole repo is mounted read-write, so the agent in the machine can change
code, docs, `PLAN.md`, `mise.toml`, the task files and the container files. Only
`.git` and `.jj` are read-only: no agent or `postinstall` script in there can
rewrite history. `ui/node_modules`, `server/target` and `.pi/npm` are volumes on
the machine's own disk instead. Verify the boundary after a create with
`findmnt -T /workspace/.git` (expect the `.git` share) and
`touch /workspace/.git/probe` (expect "Read-only file system").
