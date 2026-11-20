#!/usr/bin/env bash
# Shared by the mise tasks. Sourced, never executed (no executable bit, so mise
# does not expose it as a task).
#
#   die, note        one-line failure and progress output
#   load_deploy_env  sources the committed, non-secret configuration
#
# varia has no server-side secrets: the op log is encrypted on the client, so the
# deployment needs nothing but a host name. Against acta's deploy that is the
# whole difference: no podman secrets, no sops, nothing to rotate.

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

# Non-secret configuration: VARIA_HOST, VARIA_DOMAIN, VARIA_PORT.
load_deploy_env() {
    [[ -f .deploy.env ]] || return 0
    # shellcheck disable=SC1091
    source .deploy.env
}
