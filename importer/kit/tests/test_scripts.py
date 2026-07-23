"""discover.sh / verify.sh — the SHELL scripts' logic, tested with stub
binaries (testdata/stub-bin) so zero AWS and zero real terraform are ever
touched. clean_env() additionally strips every AWS_*/TF_TOKEN_* variable from
the subprocess environment — ambient credentials cannot reach these tests."""
import json
import os
import subprocess
import tempfile
import unittest

from kitpaths import DISCOVER_SH, VERIFY_SH, run_sh


class ShellSyntax(unittest.TestCase):
    def test_bash_n_clean(self):
        for script in (DISCOVER_SH, VERIFY_SH):
            r = subprocess.run(["bash", "-n", script], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{script}: {r.stderr}")


class DiscoverSh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "cap")

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_prints_commands_and_writes_nothing(self):
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out, "--dry-run"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("aws ec2 describe-instances --output json --region ap-southeast-5", r.stdout)
        self.assertFalse(os.path.exists(self.out), "dry-run must not create the capture dir")

    def test_dry_run_includes_the_coverage_sweep(self):
        # Gap 1: the account-wide coverage sweep goes through the exact same
        # --dry-run preview as every allowlisted capture (it is appended to
        # the same plan, not a separate code path).
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out, "--dry-run"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(
            "aws resourcegroupstaggingapi get-resources --output json --region ap-southeast-5"
            f"  ->  {self.out}/coverage-resources.json",
            r.stdout,
        )

    def test_stub_live_path_records_captures_meta_and_manifest(self):
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out],
                   extra_env={"STUB_ACCOUNT": "111111111111"})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        with open(os.path.join(self.out, "capture-meta.json")) as fh:
            meta = json.load(fh)
        self.assertEqual(meta["account"], "111111111111")
        self.assertEqual(meta["region"], "ap-southeast-5")
        with open(os.path.join(self.out, "discovery-manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertEqual(manifest["resources"], [])  # stub returns {} everywhere
        self.assertTrue(os.path.exists(os.path.join(self.out, "ec2-instances.json")))
        # the coverage sweep captured too (same stub, same loop) — {} in, honest zero out
        self.assertTrue(os.path.exists(os.path.join(self.out, "coverage-resources.json")))
        self.assertTrue(manifest["coverage"]["captured"])
        self.assertEqual(manifest["coverage"]["totalSwept"], 0)

    def test_coverage_sweep_failure_is_a_partial_capture_like_any_other(self):
        # The sweep shares the allowlisted captures' AWS_BIN seam and failure
        # accounting exactly — a failed `resourcegroupstaggingapi` call is not
        # special-cased away, it refuses PARTIAL_CAPTURE like an rds/ec2 miss.
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out],
                   extra_env={"STUB_ACCOUNT": "111111111111", "STUB_FAIL_SERVICE": "resourcegroupstaggingapi"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE PARTIAL_CAPTURE", r.stderr)
        self.assertIn("coverage-resources", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.out, "coverage-resources.json")))
        with open(os.path.join(self.out, "discovery-manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertFalse(manifest["coverage"]["captured"])  # the gap is IN the artifact too

    def test_account_mismatch_refuses_before_any_capture(self):
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out],
                   extra_env={"STUB_ACCOUNT": "222222222222"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE ACCOUNT_MISMATCH", r.stderr)
        self.assertFalse(os.path.exists(self.out), "nothing may be captured for the wrong account")

    def test_partial_capture_fails_loudly_but_keeps_evidence(self):
        r = run_sh(DISCOVER_SH, ["--region", "ap-southeast-5", "--account", "111111111111",
                                 "--out", self.out],
                   extra_env={"STUB_ACCOUNT": "111111111111", "STUB_FAIL_SERVICE": "rds"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE PARTIAL_CAPTURE", r.stderr)
        self.assertIn("rds-db-instances", r.stderr)
        with open(os.path.join(self.out, "discovery-manifest.json")) as fh:
            manifest = json.load(fh)
        missing = {m["capture"] for m in manifest["missing_captures"]}
        self.assertIn("rds-db-instances", missing)  # the gap is IN the artifact too

    def test_non_numeric_account_refuses(self):
        r = run_sh(DISCOVER_SH, ["--region", "r", "--account", "not-an-account", "--out", self.out])
        self.assertEqual(r.returncode, 2)
        self.assertIn("12-digit", r.stderr)


class VerifySh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env_dir = os.path.join(self.tmp.name, "envroot")
        os.makedirs(self.env_dir)
        with open(os.path.join(self.env_dir, "main.tf"), "w") as fh:
            fh.write("# placeholder\n")
        self.plan = os.path.join(self.tmp.name, "plan.txt")

    def tearDown(self):
        self.tmp.cleanup()

    def write_plan(self, text):
        with open(self.plan, "w") as fh:
            fh.write(text)

    def verify(self, phase, extra_env=None):
        return run_sh(VERIFY_SH, ["--env-dir", self.env_dir, "--phase", phase],
                      extra_env=extra_env or {})

    def test_import_phase_passes_on_import_only_plan(self):
        self.write_plan("Plan: 17 to import, 0 to add, 0 to change, 0 to destroy.\n")
        r = self.verify("import", {"STUB_PLAN_FILE": self.plan})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("VERIFY PASS", r.stdout)

    def test_import_phase_fails_when_plan_mutates(self):
        self.write_plan("Plan: 17 to import, 0 to add, 2 to change, 0 to destroy.\n")
        r = self.verify("import", {"STUB_PLAN_FILE": self.plan})
        self.assertEqual(r.returncode, 2)
        self.assertIn("NOT import-only", r.stderr)

    def test_import_phase_fails_when_no_import_blocks_present(self):
        self.write_plan("No changes. Your infrastructure matches the configuration.\n")
        r = self.verify("import", {"STUB_PLAN_FILE": self.plan})
        self.assertEqual(r.returncode, 2)
        self.assertIn("import blocks are missing", r.stderr)

    def test_steady_phase_passes_on_noop_and_fails_on_drift(self):
        self.write_plan("No changes. Your infrastructure matches the configuration.\n")
        r = self.verify("steady", {"STUB_PLAN_FILE": self.plan, "STUB_PLAN_EXIT": "0"})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.write_plan("Plan: 0 to import, 1 to add, 0 to change, 0 to destroy.\n")
        r = self.verify("steady", {"STUB_PLAN_FILE": self.plan, "STUB_PLAN_EXIT": "2"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("not a no-op", r.stderr)

    def test_fmt_gate_fails_first(self):
        r = self.verify("import", {"STUB_FMT_EXIT": "3"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("VERIFY FAIL [fmt]", r.stderr)

    def test_skip_plan_stops_after_validate_and_says_so(self):
        r = run_sh(VERIFY_SH, ["--env-dir", self.env_dir, "--skip-plan"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("NOT the full acceptance bar", r.stdout)


if __name__ == "__main__":
    unittest.main()
