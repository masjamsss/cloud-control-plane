"""Shared paths + subprocess helpers for the kit's tests.

Tests drive every kit script as a SUBPROCESS against the recorded fixtures
(mirroring ccp/app/scripts/test_build_inventory.py) — never by import,
never against environments/** or real AWS. The environment passed to shell
scripts strips AWS_* variables and pins AWS_BIN/TF_BIN to the stubs, so even
a regression in a script cannot reach a real CLI or real credentials.
"""
import os
import subprocess
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
KIT_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.abspath(os.path.join(KIT_DIR, "..", ".."))
TESTDATA = os.path.join(KIT_DIR, "testdata")
FIXTURES = os.path.join(TESTS_DIR, "fixtures")
STUB_AWS = os.path.join(TESTDATA, "stub-bin", "aws")
STUB_TF = os.path.join(TESTDATA, "stub-bin", "terraform")

DISCOVER_PY = os.path.join(KIT_DIR, "discover.py")
GEN_IMPORTS = os.path.join(KIT_DIR, "gen-imports.py")
NORMALIZE = os.path.join(KIT_DIR, "normalize.py")
STATEDIFF = os.path.join(KIT_DIR, "statediff.py")
PAYLOADS = os.path.join(KIT_DIR, "payloads.py")
DISCOVER_SH = os.path.join(KIT_DIR, "discover.sh")
VERIFY_SH = os.path.join(KIT_DIR, "verify.sh")
DEFAULT_SERVICES = os.path.join(KIT_DIR, "services.json")

HAPPY = os.path.join(TESTDATA, "capture-happy")
UNKNOWN = os.path.join(TESTDATA, "capture-unknown")
MALFORMED = os.path.join(TESTDATA, "capture-malformed")
COVERAGE_WARN = os.path.join(TESTDATA, "capture-coverage-warn")
COVERAGE_MALFORMED = os.path.join(TESTDATA, "capture-coverage-malformed")
GENERATED_FIXTURE = os.path.join(TESTDATA, "generated", "generated.tf.fixture")
SECRET_FIXTURE = os.path.join(TESTDATA, "generated", "generated-secret.tf.fixture")

# statediff.py / payloads.py (docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md)
REAL_SWEEP_IGNORE = os.path.join(REPO_ROOT, "scripts", "drift", "sweep-ignore.json")
REAL_SECURITY_WATCHLIST = os.path.join(REPO_ROOT, "scripts", "drift", "security-watchlist.json")
REAL_REDACTION_RULES = os.path.join(REPO_ROOT, "catalog", "redaction-rules.json")
SWEEP_HAPPY = os.path.join(FIXTURES, "sweep-happy")
SWEEP_CAP = os.path.join(FIXTURES, "sweep-cap")
SWEEP_IGNORE_TEST = os.path.join(FIXTURES, "sweep-ignore-test.json")
WATCHLIST_TEST = os.path.join(FIXTURES, "security-watchlist-test.json")
PLAN_EMPTY = os.path.join(FIXTURES, "plan-empty.json")
PLAN_SWEEP_HAPPY = os.path.join(FIXTURES, "plan-sweep-happy.json")
GENERATED_AMBIGUOUS = os.path.join(FIXTURES, "generated-ambiguous.tf.fixture")


def clean_env(**extra):
    """Subprocess env with every AWS_* / TF_TOKEN_* variable stripped (no
    ambient credentials can ever reach a test subprocess) plus stub bins."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("AWS_", "TF_TOKEN_", "GOOGLE_", "ARM_"))
    }
    env["AWS_BIN"] = STUB_AWS
    env["TF_BIN"] = STUB_TF
    env.update(extra)
    return env


def run_py(script, args, **kw):
    return subprocess.run(
        [sys.executable, script] + args,
        capture_output=True, text=True, timeout=60, env=clean_env(), **kw
    )


def run_sh(script, args, extra_env=None, **kw):
    return subprocess.run(
        ["bash", script] + args,
        capture_output=True, text=True, timeout=60,
        env=clean_env(**(extra_env or {})), **kw
    )
