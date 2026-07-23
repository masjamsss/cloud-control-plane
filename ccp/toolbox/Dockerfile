# syntax=docker/dockerfile:1
#
# ccp-toolbox — pinned Terraform + the built catalogctl, for the armed-lane
# operator commands run FROM INSIDE the api container (see
# ../docker-compose.armed.yml and ccp/docs/go-live.md → "Toolbox + armed
# lanes"). A run-on-demand image, NOT a daemon (profile: toolbox, restart: "no"
# in docker-compose.yml) — never `up`:
#     docker compose --profile toolbox build toolbox
#     docker compose run --rm toolbox …
#     docker run --rm ccp-toolbox:local …
# No AWS credentials baked in, no entrypoint magic — default CMD is
# toolbox-selfcheck, a plain build-proof/health script.
#
# BUILD CONTEXT = repo root (docker-compose.yml: `context: ..`, `dockerfile:
# ccp/toolbox/Dockerfile`) so this stage can COPY tools/catalogctl.

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY tools/catalogctl /src
RUN CGO_ENABLED=0 go build -trimpath -o /out/catalogctl ./cmd/catalogctl

FROM debian:bookworm-slim

# Terraform pin — matches CI (.github/workflows/terraform.yml TF_VERSION) and
# scripts/setup.sh's TF_VERSION default. Verified against HashiCorp's published
# SHA256SUMS — the same flow scripts/setup.sh's install_terraform() uses; never
# a hand-pinned hash for Terraform.
ARG TF_VERSION=1.15.7
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git jq curl unzip bash \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) TF_ARCH=amd64 ;; \
      arm64) TF_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    zip="terraform_${TF_VERSION}_linux_${TF_ARCH}.zip"; \
    sums="terraform_${TF_VERSION}_SHA256SUMS"; \
    base="https://releases.hashicorp.com/terraform/${TF_VERSION}"; \
    curl -fsSL "${base}/${zip}"  -o "${tmp}/${zip}"; \
    curl -fsSL "${base}/${sums}" -o "${tmp}/${sums}"; \
    ( cd "$tmp" && grep " ${zip}\$" "${sums}" | sha256sum -c - ); \
    unzip -o "${tmp}/${zip}" terraform -d /usr/local/bin; \
    chmod +x /usr/local/bin/terraform; \
    rm -rf "$tmp"

COPY --from=build /out/catalogctl /usr/local/bin/catalogctl
COPY --chmod=0755 ccp/toolbox/toolbox-selfcheck /usr/local/bin/toolbox-selfcheck

# Files this image writes into the armed overlay's /data/scratch bind stay
# api-owned (api runs as uid 1000 — see ../api/Dockerfile).
USER 1000

CMD ["toolbox-selfcheck"]
