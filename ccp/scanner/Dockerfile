# syntax=docker/dockerfile:1
#
# ccp-scanner — the isolated repository scanner (ADR-0033). This is the ONLY
# image in the stack that fetches and reads code the operator has not yet
# trusted, so everything about it is subtractive:
#
#   NO TERRAFORM. Deliberately, and checked at runtime: `catalogctl scan-worker`
#   refuses to start if terraform is on PATH (internal/scanworker Preflight).
#   The scan is static HCL parsing — the exact prescan step `catalogctl onboard`
#   runs BEFORE any trust decision exists — so an executor in this image would
#   be capability the process has no use for and an attacker would.
#   This is why it is NOT built from ccp-toolbox, which ships terraform for the
#   armed lanes: same binary, opposite posture.
#
#   NO CLOUD CREDENTIALS. None baked, none expected; the worker refuses to start
#   if it finds AWS_*/GOOGLE_*/ARM_*/TF_TOKEN_* in its environment (the same
#   guard as the sandbox contract, onboard.AssertNoCloudCreds). Compose passes
#   it exactly two things: the control-plane URL and CCP_SCANNER_KEY.
#
#   NO DOCKER SOCKET, NO PORTS, NO VOLUMES. It dials OUT to the control plane
#   and to the forge; nothing dials in. Its workspace is a tmpfs sized in
#   compose, which is also what bounds how much disk a hostile repository can
#   make it consume — and it means no checkout survives a restart.
#
#   NON-ROOT, READ-ONLY ROOTFS (set in compose). Only git and the CA bundle are
#   installed; there is no shell tooling for a compromised clone to reach for.
#
# BUILD CONTEXT = repo root (docker-compose.yml: `context: ..`,
# `dockerfile: ccp/scanner/Dockerfile`) so this stage can COPY tools/catalogctl.

# CROSS-COMPILED, not emulated. This image is published multi-arch
# (.github/workflows/release-images.yml), and running the Go compiler under QEMU
# for the non-native arch is minutes-vs-seconds slower for no benefit — the
# binary is static (CGO off), so the toolchain can simply target the other
# platform from the builder's own.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY tools/catalogctl /src
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -o /out/catalogctl ./cmd/catalogctl

FROM debian:bookworm-slim

# git for the shallow clone; ca-certificates so https to the forge verifies.
# Nothing else — no curl, no jq, no unzip, no bash.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Prove the defining property of this image at BUILD time, so a future edit that
# adds terraform (or bases this on ccp-toolbox) fails here rather than shipping a
# scanner that can execute what it scans.
RUN if command -v terraform >/dev/null 2>&1; then \
      echo "ccp-scanner must not contain terraform" >&2; exit 1; \
    fi

COPY --from=build /out/catalogctl /usr/local/bin/catalogctl

# The workspace each job's throwaway checkout lands under. Compose mounts a
# tmpfs here; the directory exists so the image also works with `docker run`.
RUN install -d -o 1000 -g 1000 -m 0700 /workspace
WORKDIR /workspace
USER 1000

ENTRYPOINT ["catalogctl", "scan-worker"]
CMD ["--workdir", "/workspace"]
