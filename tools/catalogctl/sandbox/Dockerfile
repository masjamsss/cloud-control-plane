# Committed sandbox contract for `catalogctl onboard`'s schema-extraction step
# (spec §6.3). Paper-verified: docker is NOT required to be installed here — the
# acceptance is that this file mounts no credentials, runs as a non-root user,
# and hands control to the fail-closed wrapper.
#
# The pinned terraform version MUST match the ForceNew/provider audit tag a
# project's ops are enabled against (0007 C1).
FROM hashicorp/terraform:1.15.7

# Non-root user — the container never needs privilege to read a repo and hit the
# public registry.
RUN addgroup -S onboard && adduser -S -G onboard onboard

COPY run.sh /usr/local/bin/run.sh
RUN chmod 0555 /usr/local/bin/run.sh

USER onboard
WORKDIR /workspace

# REQUIRED run-time invariants (enforced by the caller, documented here):
#   docker run --rm \
#     --network onboarding-registry-only \   # egress limited to registry.terraform.io + releases.hashicorp.com
#     --read-only \                           # the clone is bind-mounted read-only
#     -v "$CLONE":/workspace:ro \
#     onboard-sandbox /workspace
# No AWS_/GOOGLE_/ARM_/TF_TOKEN_ variables may be passed; the wrapper exits 1 if any exist.
ENTRYPOINT ["/usr/local/bin/run.sh"]
