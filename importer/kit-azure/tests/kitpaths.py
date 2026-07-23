"""Shared paths + subprocess helpers for the Azure kit's tests.

Mirrors importer/kit/tests/kitpaths.py. Tests drive every kit script as a SUBPROCESS against
the recorded fixtures — never by import, never against environments/** or real Azure. The
environment passed to scripts strips AWS_*/TF_TOKEN_*/GOOGLE_*/ARM_*/AZURE_* variables and pins
AZ_BIN/TF_BIN/AZTFEXPORT_BIN to the stubs, so even a regression in a script cannot reach a real
CLI or real credentials. (ARM_* and AZURE_* are the Azure/azurerm credential env vars — stripped
here exactly as the AWS kit strips AWS_*.)
"""
import os
import subprocess
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
KIT_DIR = os.path.dirname(TESTS_DIR)
TESTDATA = os.path.join(KIT_DIR, "testdata")
STUB_AZ = os.path.join(TESTDATA, "stub-bin", "az")
STUB_TF = os.path.join(TESTDATA, "stub-bin", "terraform")
STUB_AZTFEXPORT = os.path.join(TESTDATA, "stub-bin", "aztfexport")

DISCOVER_PY = os.path.join(KIT_DIR, "discover.py")
GEN_IMPORTS = os.path.join(KIT_DIR, "gen-imports.py")
NORMALIZE = os.path.join(KIT_DIR, "normalize.py")
RECONCILE = os.path.join(KIT_DIR, "reconcile.py")
DISCOVER_SH = os.path.join(KIT_DIR, "discover.sh")
VERIFY_SH = os.path.join(KIT_DIR, "verify.sh")
RUN_AZTFEXPORT = os.path.join(KIT_DIR, "run-aztfexport.sh")
SERVICES = os.path.join(KIT_DIR, "azure-services.json")

HAPPY = os.path.join(TESTDATA, "capture-happy")
UNKNOWN = os.path.join(TESTDATA, "capture-unknown")
MALFORMED = os.path.join(TESTDATA, "capture-malformed")
COVERAGE_MALFORMED = os.path.join(TESTDATA, "capture-coverage-malformed")
PAGED = os.path.join(TESTDATA, "capture-paged")
GENERATED_FIXTURE = os.path.join(TESTDATA, "generated", "generated.tf.fixture")
SECRET_FIXTURE = os.path.join(TESTDATA, "generated", "generated-secret.tf.fixture")
MAPPING_FIXTURE = os.path.join(TESTDATA, "aztfexport", "aztfexportResourceMapping.json")
SUBSCRIPTIONS_FIXTURE = os.path.join(TESTDATA, "subscriptions.json")

# The synthetic fixture identity. A leak guard in the tests asserts the kit never emits a REAL
# subscription id; fixtures use these all-zero / all-one GUIDs so any real id would stand out.
FIXTURE_SUBSCRIPTION = "00000000-0000-0000-0000-000000000000"
FIXTURE_TENANT = "11111111-1111-1111-1111-111111111111"


def clean_env(**extra):
    """Subprocess env with every AWS_*/TF_TOKEN_*/GOOGLE_*/ARM_*/AZURE_* variable stripped (no
    ambient cloud credentials can ever reach a test subprocess) plus the stub bins."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("AWS_", "TF_TOKEN_", "GOOGLE_", "ARM_", "AZURE_"))
    }
    env["AZ_BIN"] = STUB_AZ
    env["TF_BIN"] = STUB_TF
    env["AZTFEXPORT_BIN"] = STUB_AZTFEXPORT
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
