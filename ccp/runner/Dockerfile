# syntax=docker/dockerfile:1
#
# ccp-runner — self-hosted GitHub Actions runner for this repo's CI. Brings
# workflows onto `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` at zero
# workflow-file cost: register this container with label `ccp`, then set the
# repo variable CI_RUNNER=ccp (rollback: delete the variable). See
# ccp/docs/go-live.md → "CI runner" for the one manual registration step.
#
# State + the runner distribution live TOGETHER under the /data/runner bind (see
# ../docker-compose.yml) — NOT baked into the image. entrypoint.sh extracts the
# staged tarball into /runner (the mounted bind) on first boot / version bump, so
# registration (.runner/.credentials) survives both container recreation AND
# image upgrades. No sudo in the image; no job toolchains are baked in either —
# workflows provision Node/Go/Terraform/Python via their own setup-* actions,
# whose caches persist on /data/runner (downloads happen once per version, not
# once per job).
#
# BUILD CONTEXT = ccp/runner/ (docker-compose.yml: `build: { context: ./runner }`).

FROM debian:bookworm-slim

# actions/runner release pin. GitHub does not publish a signed checksums file for
# these tarballs, so this hash is TOFU (trust-on-first-use) at authoring time —
# pinned 2026-07-21 against actions/runner v2.336.0's published SHA-256s; every
# build thereafter re-verifies the download against it (sha256sum -c).
ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256_AMD64=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
ARG RUNNER_SHA256_ARM64=58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1
ARG TARGETARCH
# Promote the build-time pin to a runtime ENV so entrypoint.sh's upgrade check
# (compare against /runner/.dist-version) knows what THIS image is pinned to,
# without depending on any compose-supplied env.
ENV RUNNER_VERSION=${RUNNER_VERSION}

# The .NET runner's runtime deps + what checkout/upload actions need. Nothing
# else — see header re: job toolchains.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq tar gzip unzip xz-utils procps \
      libicu72 libkrb5-3 zlib1g libssl3 \
 && rm -rf /var/lib/apt/lists/*

# Stage the runner tarball — verified, NOT extracted. entrypoint.sh extracts it
# into the /data/runner bind on first boot so binaries + state live together.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RUNNER_ARCH=x64;   RUNNER_SHA256="$RUNNER_SHA256_AMD64" ;; \
      arm64) RUNNER_ARCH=arm64; RUNNER_SHA256="$RUNNER_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/runner-dist; \
    curl -fsSL -o /opt/runner-dist/runner.tgz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"; \
    echo "${RUNNER_SHA256}  /opt/runner-dist/runner.tgz" | sha256sum -c -

RUN useradd -m -u 1001 runner \
 && chown -R runner:runner /opt/runner-dist

COPY --chmod=0755 entrypoint.sh /entrypoint.sh

USER runner
WORKDIR /runner

ENTRYPOINT ["/entrypoint.sh"]
