# syntax=docker/dockerfile:1
#
# ccp-api — the governance backend (durable identity, per-project hash-chained
# audit, dual-control config surface).
#
# RUNTIME MODEL: the api runs its TypeScript directly via tsx (no emit/bundle
# step) — exactly like `npm run start` in dev. server.ts runs a fail-closed
# production PREFLIGHT (src/deploy.ts) BEFORE it opens the store or binds a port.
#
# TLS: this process speaks PLAIN HTTP behind an EXTERNAL reverse proxy that
# terminates HTTPS (see ../docker-compose.yml and ../docs/go-live.md). The Secure
# session-cookie flag is env-driven (CCP_SECURE_COOKIES), never an in-process
# certificate.
#
# BUILD CONTEXT = ccp/ (the api+app repo root), NOT ccp/api. Why: the api
# resolves a small, VERIFIED slice of the SPA at runtime — the @app-lib/* VALUE
# imports app/src/lib/{policy,permissions,dependsOn,projectScope,riskOverrides}.ts
# and the service manifests it reads off disk (app/src/data/manifests/*.json).
# tsx resolves the @app-lib/* and @/* aliases via api/tsconfig.json `paths` against
# a SIBLING app/ directory, so the image reproduces that layout. None of those app
# files import a third-party package, so NO app node_modules is needed — only the
# api's own. Build from the repo root:
#     docker build -f api/Dockerfile -t ccp-api .
# (docker-compose.yml wires this up for you.)

# ---- deps: lockfile-exact install (frozen). Pulls in tsx (the TS runtime) and the
#      linux @node-rs/argon2 prebuild for THIS image's platform. Manifests copied
#      first so the slow install layer caches across source edits.
FROM node:22-bookworm-slim AS deps
WORKDIR /srv/ccp/api
COPY api/package.json api/package-lock.json ./
RUN npm ci

# ---- runtime
FROM node:22-bookworm-slim AS runtime

# ---- pinned static docker CLI (client only) — see rationale + USER-node note below.
# Lets armed-lane operator commands (docker run …) execute FROM INSIDE this
# container; inert until the docker-compose.armed.yml overlay grants the socket
# (see that file's SECURITY comment). A static client sidesteps every host-CLI-
# mount glibc/musl/snap compatibility trap.
# Provenance: docker-29.6.2 static build, pinned 2026-07-21 — Docker publishes no
# signed sums file for the static CLI, so this hash is TOFU (trust-on-first-use)
# at authoring time; every build thereafter re-verifies the download against it
# (sha256sum -c).
ARG DOCKER_CLI_VERSION=29.6.2
ARG DOCKER_CLI_SHA256_AMD64=d6204aea92238e2453d5445c885b9d2e5eb8f82915568ec50edf9dbe12a3ac74
ARG DOCKER_CLI_SHA256_ARM64=8d16d8b3b158c132a9fb9963d4b4345746f925e287e154c9ed880ac257baf292
ARG TARGETARCH

ENV NODE_ENV=production \
    PORT=8787 \
    CCP_DATA_DIR=/var/lib/ccp
WORKDIR /srv/ccp/api

# Installed deps (with tsx + the linux argon2 binding).
COPY --from=deps /srv/ccp/api/node_modules ./node_modules
# api runtime source + tsconfig (its `paths` map @app-lib/* → ../app/src/lib/*).
COPY api/package.json api/tsconfig.json ./
COPY api/src ./src
COPY api/scripts ./scripts
# The SPA slice the api resolves at runtime (see header). The whole app/src tree is
# vendored (source only, no node_modules) so alias + on-disk-manifest resolution is
# robust; files outside the api's import graph are never loaded.
COPY app/src /srv/ccp/app/src

# The durable store lives on a MOUNTED volume, owned by the unprivileged runtime
# user so a first-boot bootstrap can write it. node:bookworm-slim ships a `node`
# user (uid 1000).
RUN mkdir -p "$CCP_DATA_DIR" \
 && chown -R node:node "$CCP_DATA_DIR" /srv/ccp

# docker CLI (client-only, static, pinned+verified — ARGs declared above).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) DOCKER_ARCH=x86_64;  DOCKER_CLI_SHA256="$DOCKER_CLI_SHA256_AMD64" ;; \
      arm64) DOCKER_ARCH=aarch64; DOCKER_CLI_SHA256="$DOCKER_CLI_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
      && rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker-cli.tgz; \
    echo "${DOCKER_CLI_SHA256}  /tmp/docker-cli.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker-cli.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker-cli.tgz /tmp/docker

USER node

EXPOSE 8787

# READINESS (not liveness): 200 only once the store loaded, holds >=1 account, and
# every audit chain verifies — i.e. AFTER first-boot bootstrap. A fresh, un-bootstrapped
# store is correctly 503 here, which the start-period tolerates. Uses Node's global
# fetch (>=18) so the image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/readyz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

# npm run start === tsx src/server.ts (preflight → open store → [bootstrap] → serve).
CMD ["npm", "run", "start"]
