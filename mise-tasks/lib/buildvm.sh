# Shared by the deploy tasks. Sourced, never executed (no executable bit, so
# mise does not expose it as a task). Needs lib/env.sh sourced first.
#
#   buildvm_up      create (if needed) and start the build machine
#   in_buildvm      run a command in it, in /src (the repo, read-only)
#   buildvm_stop    stop it; its disk, and so the layer cache, is kept
#
# The name is always passed explicitly: mise.toml points SMOLVM_MACHINE_NAME at
# the dev machine, and the build must never run there.

BUILDVM="${VARIA_BUILD_MACHINE:-varia-build}"

in_buildvm() { smolvm machine exec --name "$BUILDVM" -w /src -- "$@"; }

buildvm_up() {
    command -v smolvm >/dev/null || die "smolvm is not installed (brew install smol-machines/tap/smolvm)"
    in_buildvm true >/dev/null 2>&1 && return 0
    if ! smolvm machine start --name "$BUILDVM" 2>/dev/null; then
        note "creating build machine '$BUILDVM' from Smolfile.build"
        smolvm machine create --name "$BUILDVM" -s Smolfile.build
        smolvm machine start --name "$BUILDVM"
    fi
    in_buildvm podman info >/dev/null || die "podman does not work in '$BUILDVM' (try: mise run deploy:reset)"
}

buildvm_stop() { smolvm machine stop --name "$BUILDVM" >/dev/null 2>&1 || true; }

# build_image <image>: build the repo's Containerfile in the build machine.
# Host networking, so the build needs no container network set up in the guest.
build_image() {
    in_buildvm podman build --network=host -t "$1" /src
}
