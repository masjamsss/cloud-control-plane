"""normalize.py — scaffold/split/guard/check, tested against generated fixtures (needs python-hcl2)."""
import os
import shutil
import tempfile
import unittest

from kitpaths import NORMALIZE, SERVICES, GENERATED_FIXTURE, SECRET_FIXTURE, run_py

FIX_SUB = "00000000-0000-0000-0000-000000000000"
FIX_TENANT = "11111111-1111-1111-1111-111111111111"


class Scaffold(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "env")

    def tearDown(self):
        self.tmp.cleanup()

    def scaffold(self, *extra):
        return run_py(NORMALIZE, ["scaffold", "--env-dir", self.env, "--env-name", "prod",
                                  "--location", "southeastasia", "--subscription-id", FIX_SUB,
                                  "--tenant-id", FIX_TENANT, *extra])

    def test_writes_and_replaces_tokens(self):
        r = self.scaffold("--state-storage-account", "sttfstate", "--state-container", "tfstate",
                          "--state-resource-group", "rg-state")
        self.assertEqual(r.returncode, 0, r.stderr)
        for f in ["versions.tf", "providers.tf", "variables.tf", "main.tf", "backend.tf", "terraform.tfvars"]:
            self.assertTrue(os.path.exists(os.path.join(self.env, f)), f)
        backend = open(os.path.join(self.env, "backend.tf")).read()
        self.assertIn("sttfstate", backend)
        self.assertNotIn("REPLACE_", backend)
        tfvars = open(os.path.join(self.env, "terraform.tfvars")).read()
        self.assertIn("southeastasia", tfvars)
        self.assertIn(FIX_SUB, tfvars)

    def test_idempotent(self):
        args = ("--state-storage-account", "s", "--state-container", "c", "--state-resource-group", "g")
        self.scaffold(*args)
        r = self.scaffold(*args)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unchanged", r.stdout)

    def test_different_existing_refuses(self):
        args = ("--state-storage-account", "s", "--state-container", "c", "--state-resource-group", "g")
        self.scaffold(*args)
        with open(os.path.join(self.env, "versions.tf"), "w") as fh:
            fh.write("changed\n")
        r = self.scaffold(*args)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE EXISTS", r.stderr)


class SplitGuardCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "env")
        os.makedirs(self.env)
        self.gen = os.path.join(self.tmp.name, "generated.tf")
        shutil.copy(GENERATED_FIXTURE, self.gen)

    def tearDown(self):
        self.tmp.cleanup()

    def split(self):
        return run_py(NORMALIZE, ["split", "--generated", self.gen, "--env-dir", self.env, "--services", SERVICES])

    def test_split_per_service_and_unclassified(self):
        r = self.split()
        self.assertEqual(r.returncode, 0, r.stderr)
        for f in ["network.tf", "storage.tf", "monitor.tf", "unclassified.tf"]:
            self.assertTrue(os.path.exists(os.path.join(self.env, f)), f)
        self.assertIn("unclassified", r.stderr.lower())
        # the brace-in-a-string block survived intact into the right service file
        monitor = open(os.path.join(self.env, "monitor.tf")).read()
        self.assertIn("azurerm_log_analytics_workspace", monitor)

    def test_guard_adds_prevent_destroy_to_stateful_only(self):
        self.split()
        r = run_py(NORMALIZE, ["guard", "--env-dir", self.env, "--services", SERVICES])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("prevent_destroy = true", open(os.path.join(self.env, "storage.tf")).read())
        self.assertNotIn("prevent_destroy", open(os.path.join(self.env, "network.tf")).read())
        # idempotent re-run adds nothing
        r2 = run_py(NORMALIZE, ["guard", "--env-dir", self.env, "--services", SERVICES])
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("added prevent_destroy to 0", r2.stdout)

    def test_check_clean_passes(self):
        self.split()
        r = run_py(NORMALIZE, ["check", "--env-dir", self.env])
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("check: clean", r.stdout)

    def test_check_refuses_azure_secret_literal(self):
        shutil.copy(SECRET_FIXTURE, os.path.join(self.env, "database.tf"))
        r = run_py(NORMALIZE, ["check", "--env-dir", self.env])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE SECRET_LITERAL", r.stderr)
        self.assertIn("administrator_login_password", r.stderr)


if __name__ == "__main__":
    unittest.main()
