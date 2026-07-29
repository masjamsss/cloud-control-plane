#!/usr/bin/env bash
# =============================================================================
# Regression test for OPS-1 — the fresh-install bootstrap deadlock.
#
# The api refuses `CCP_BOOTSTRAP=1` whenever the store file already exists, so the
# install must decide whether this is a first install BEFORE anything creates that
# file. The old flow could not: it upped without bootstrap, polled /readyz, and only
# then re-upped with CCP_BOOTSTRAP=1 — by which point the first boot had created the
# store and the api exited 1 into a `restart: unless-stopped` crash loop.
#
# This runs the ACTUAL shipped install.sh (not a copy) with `docker`, `curl` and the
# sibling setup scripts stubbed, and asserts the decision it makes:
#
#   store absent  -> CCP_BOOTSTRAP=1 IS set on the FIRST `up`
#   store present -> CCP_BOOTSTRAP is never set on any `up`
#
# It fails against the pre-fix install.sh, which is the point: there the first `up`
# carried no bootstrap and the second one did.
#
# Exit codes: 0 all assertions pass · 1 an assertion failed.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$(cd "$SCRIPT_DIR/.." && pwd)/install.sh"
[ -f "$INSTALL_SH" ] || { echo "cannot find install.sh at $INSTALL_SH" >&2; exit 1; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }

# install.sh hard-requires a persistent disk at /data — a real prerequisite, not an
# incidental one, so it is not stubbed away. If the directory is absent and cannot be
# created, skip rather than report a failure the fix is not responsible for.
if [ ! -d /data ]; then
  if ! mkdir -p /data 2>/dev/null; then
    echo "install-bootstrap-decision: SKIP — /data is absent and not creatable here"
    echo "  (install.sh requires it; run as a user that can create it to exercise this test)"
    exit 0
  fi
  echo "  note: created /data — install.sh requires it as a prerequisite"
fi

# Builds a sandbox: stub bin dir on PATH, a fake /data, and a log of every
# `docker compose` invocation with the CCP_BOOTSTRAP value it carried.
run_install() {
  local store_state="$1" work; work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/store" "$work/ccp/scripts"

  # `docker`: records each compose call and whether bootstrap was in its environment.
  cat >"$work/bin/docker" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "compose" ]; then
  shift
  # 'compose version' is a capability probe, not part of the install journey
  if [ "\${1:-}" = "version" ]; then echo "Docker Compose version v2.0.0"; exit 0; fi
  if [ "\${1:-}" = "up" ]; then
    echo "up bootstrap=\${CCP_BOOTSTRAP:-<unset>}" >>"$work/calls.log"
    exit 0
  fi
  if [ "\${1:-}" = "logs" ]; then echo "one-time password: stub-otp-value"; exit 0; fi
fi
exit 0
EOF

  # `curl`: install.sh only uses it for readyz_code, which reads the HTTP status.
  # Always 200 so the readiness polls terminate immediately.
  cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "200"
exit 0
EOF

  # setup.sh / nginx-vhost.sh are separate concerns with their own behaviour; stub
  # them so this test is about the bootstrap decision alone.
  printf '#!/usr/bin/env bash\nexit 0\n' >"$work/ccp/scripts/setup.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$work/ccp/scripts/nginx-vhost.sh"
  cp "$INSTALL_SH" "$work/ccp/scripts/install.sh"
  chmod +x "$work/bin/docker" "$work/bin/curl" "$work/ccp/scripts/"*.sh

  # docker-compose.yml is only ever passed to the stub, but install.sh cd's to CCP_DIR.
  : >"$work/ccp/docker-compose.yml"

  local store="$work/store/ccp.json"
  [ "$store_state" = "present" ] && echo '{}' >"$store"

  # /data must exist for install.sh's prerequisite check; the store path itself is
  # injected, which is the seam that makes this testable at all.
  mkdir -p "$work/data"
  PATH="$work/bin:$PATH" CCP_STORE_FILE="$store" \
    bash "$work/ccp/scripts/install.sh" --host test.example.com >"$work/out.log" 2>&1
  INSTALL_RC=$?
  CALLS="$(cat "$work/calls.log" 2>/dev/null || true)"
  OUT="$(cat "$work/out.log")"
  WORKDIR="$work"
}

echo "OPS-1 — install.sh decides bootstrap before the first up"

# --- fresh host: no store file --------------------------------------------------
run_install absent
first_call="$(printf '%s\n' "$CALLS" | head -1)"
if [ -z "$CALLS" ]; then
  fail "fresh: an up happens at all" "no 'docker compose up' was recorded; install output:
$(printf '%s' "$OUT" | tail -5)"
elif printf '%s' "$first_call" | grep -q 'bootstrap=1'; then
  pass "fresh: CCP_BOOTSTRAP=1 is set on the FIRST up"
else
  fail "fresh: CCP_BOOTSTRAP=1 is set on the FIRST up" \
    "first up was '$first_call' — this is the OPS-1 deadlock: the store file gets created
     without an admin, and every later bootstrap is refused"
fi

# The bootstrap env must not persist: a later up clears it.
if [ "$(printf '%s\n' "$CALLS" | wc -l)" -ge 2 ] \
   && printf '%s\n' "$CALLS" | tail -1 | grep -q 'bootstrap=<unset>'; then
  pass "fresh: a later up recreates WITHOUT the bootstrap env"
else
  fail "fresh: a later up recreates WITHOUT the bootstrap env" \
    "calls were:
$CALLS"
fi

# --- rebuild/update: store already present --------------------------------------
run_install present
if [ -n "$CALLS" ] && ! printf '%s' "$CALLS" | grep -q 'bootstrap=1'; then
  pass "existing store: no up ever carries CCP_BOOTSTRAP"
else
  fail "existing store: no up ever carries CCP_BOOTSTRAP" \
    "an up carried bootstrap over an initialized store — that is a re-provision over a
     live audit chain. Calls were:
$CALLS"
fi

if [ "$fails" -eq 0 ]; then
  echo "install-bootstrap-decision: PASS"
  exit 0
fi
echo "install-bootstrap-decision: FAIL — $fails assertion(s)"
exit 1
