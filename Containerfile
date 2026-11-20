# --- frontend ---------------------------------------------------------------
FROM node:23-bookworm AS ui-builder
WORKDIR /usr/src/varia/ui

COPY ui/package.json ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/usr/src/varia/ui/node_modules \
    npm ci

COPY ./ui/ ./
RUN --mount=type=cache,target=/usr/src/varia/ui/node_modules \
    npm run build

# --- backend ----------------------------------------------------------------
FROM rust:bookworm AS builder
WORKDIR /usr/src/varia/server

COPY server/Cargo.toml server/Cargo.lock ./
# Prime the dependency layer with a throwaway binary, so a source-only change does
# not rebuild sqlite, axum and friends.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/usr/src/varia/server/target \
    mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY server/src ./src
# The `touch` is load-bearing: COPY keeps the context's mtimes, which are older
# than the fingerprints the priming build recorded, so cargo would treat the
# package as fresh and leave the throwaway binary in place. The size check fails
# the build loudly if that ever happens again.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/usr/src/varia/server/target \
    find src -exec touch {} + \
    && cargo build --release \
    && cp target/release/varia /tmp/varia \
    && test "$(stat -c %s /tmp/varia)" -gt 1000000

# --- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# One static binary, the built UI and a volume. No shell tools: nothing here
# needs curl, and the health check runs from the host against the loopback port.
WORKDIR /usr/src/app
COPY --from=builder /tmp/varia /usr/local/bin/varia
COPY --from=ui-builder /usr/src/varia/ui/dist ./ui/dist
# Owned by the uid the container runs as: a named volume inherits the image
# directory's ownership, so without this the service cannot create its database.
RUN mkdir -p /data && chown 1000:1000 /data

ENV VARIA_ADDR=0.0.0.0:8080 \
    VARIA_DB=/data/varia.sqlite \
    VARIA_UI_DIR=/usr/src/app/ui/dist \
    HOME=/tmp

# Numeric on purpose: the quadlet runs with `UserNS=keep-id:uid=1000,gid=1000`, so
# uid 1000 is the deploying user on the host, who owns the data volume.
USER 1000:1000

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/varia"]
