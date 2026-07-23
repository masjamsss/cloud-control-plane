"""normalize.py — fixture-driven tests (subprocess style; the script itself
needs python-hcl2, already a repo dependency via build-inventory.py)."""
import os
import shutil
import tempfile
import unittest

from kitpaths import GENERATED_FIXTURE, NORMALIZE, SECRET_FIXTURE, run_py


class ScaffoldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "envroot")

    def tearDown(self):
        self.tmp.cleanup()

    def scaffold(self):
        return run_py(NORMALIZE, [
            "scaffold", "--env-dir", self.env, "--env-name", "staging",
            "--region", "ap-southeast-5", "--owner", "platform-team",
            "--state-bucket", "example-state-bucket",
        ])

    def test_writes_prod_pinned_root_files_with_tokens_replaced(self):
        r = self.scaffold()
        self.assertEqual(r.returncode, 0, r.stderr)
        files = sorted(os.listdir(self.env))
        self.assertEqual(files, sorted(
            ["versions.tf", "providers.tf", "variables.tf", "main.tf", "backend.tf", "terraform.tfvars"]))
        versions = open(os.path.join(self.env, "versions.tf")).read()
        self.assertIn('required_version = "~> 1.10"', versions)   # same pins as environments/prod
        self.assertIn('version = "6.53.0"', versions)
        backend = open(os.path.join(self.env, "backend.tf")).read()
        self.assertIn('bucket = "example-state-bucket"', backend)
        self.assertIn('key    = "Terraform/staging/terraform.tfstate"', backend)
        self.assertIn('region = "ap-southeast-5"', backend)
        self.assertNotIn("REPLACE_", backend)
        tfvars = open(os.path.join(self.env, "terraform.tfvars")).read()
        self.assertIn('region = "ap-southeast-5"', tfvars)
        self.assertIn('owner  = "platform-team"', tfvars)

    def test_rerun_is_idempotent_and_conflict_refuses(self):
        self.assertEqual(self.scaffold().returncode, 0)
        r = self.scaffold()  # identical re-run: fine
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unchanged", r.stdout)
        with open(os.path.join(self.env, "backend.tf"), "a") as fh:
            fh.write("# human edit\n")
        r = self.scaffold()  # now a conflicting file: refuse, never clobber
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE EXISTS", r.stderr)


class SplitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "envroot")
        os.makedirs(self.env)
        self.generated = os.path.join(self.tmp.name, "generated.tf")
        shutil.copy(GENERATED_FIXTURE, self.generated)

    def tearDown(self):
        self.tmp.cleanup()

    def split(self, extra=None):
        return run_py(NORMALIZE, ["split", "--generated", self.generated, "--env-dir", self.env] + (extra or []))

    def test_splits_into_prod_style_service_files(self):
        r = self.split()
        self.assertEqual(r.returncode, 0, r.stderr)
        files = sorted(f for f in os.listdir(self.env) if f.endswith(".tf"))
        self.assertEqual(files, ["ebs.tf", "ec2.tf", "rds.tf", "s3.tf", "unclassified.tf"])
        ec2 = open(os.path.join(self.env, "ec2.tf")).read()
        # verbatim bytes: heredoc with its decoy brace survives; provenance comment kept
        self.assertIn('echo "heredoc with a decoy { brace', ec2)
        self.assertIn('# __generated__ by Terraform from "i-0a0a0a0a0a0a0a001"', ec2)

    def test_unknown_type_goes_to_unclassified_loudly(self):
        r = self.split()
        self.assertIn("aws_gamelift_fleet", r.stderr)
        self.assertIn("NOT dropped", r.stderr)
        uncls = open(os.path.join(self.env, "unclassified.tf")).read()
        self.assertIn('resource "aws_gamelift_fleet" "unmapped_type_example"', uncls)
        self.assertIn("NEVER to be merged as-is", uncls)

    def test_rerun_is_idempotent_and_divergence_refuses_without_force(self):
        self.assertEqual(self.split().returncode, 0)
        r = self.split()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unchanged", r.stdout)
        with open(os.path.join(self.env, "ec2.tf"), "a") as fh:
            fh.write("# human refactor\n")
        r = self.split()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE EXISTS", r.stderr)
        self.assertEqual(self.split(["--force"]).returncode, 0)

    def test_tf_json_input_refuses(self):
        j = os.path.join(self.tmp.name, "generated.tf.json")
        with open(j, "w") as fh:
            fh.write("{}")
        r = run_py(NORMALIZE, ["split", "--generated", j, "--env-dir", self.env])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE TF_JSON_UNSUPPORTED", r.stderr)

    def test_zero_resource_input_refuses_empty_generated(self):
        with open(self.generated, "w") as fh:
            fh.write('provider "aws" {\n  region = "ap-southeast-5"\n}\n')
        r = self.split()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE EMPTY_GENERATED", r.stderr)


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "envroot")
        os.makedirs(self.env)
        generated = os.path.join(self.tmp.name, "generated.tf")
        shutil.copy(GENERATED_FIXTURE, generated)
        r = run_py(NORMALIZE, ["split", "--generated", generated, "--env-dir", self.env])
        self.assertEqual(r.returncode, 0, r.stderr)

    def tearDown(self):
        self.tmp.cleanup()

    def guard(self):
        return run_py(NORMALIZE, ["guard", "--env-dir", self.env])

    def test_stateful_resources_get_prevent_destroy(self):
        r = self.guard()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("added prevent_destroy to 3 stateful resource(s)", r.stdout)
        for fname in ("ebs.tf", "rds.tf", "s3.tf"):
            content = open(os.path.join(self.env, fname)).read()
            self.assertIn("prevent_destroy = true", content, fname)
        # non-stateful files untouched
        self.assertNotIn("prevent_destroy", open(os.path.join(self.env, "ec2.tf")).read())

    def test_rerun_adds_nothing(self):
        self.guard()
        r = self.guard()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("added prevent_destroy to 0 stateful resource(s)", r.stdout)

    def test_existing_lifecycle_block_is_skipped_with_warning_not_corrupted(self):
        path = os.path.join(self.env, "efs.tf")
        original = (
            'resource "aws_efs_file_system" "shared" {\n'
            '  creation_token = "shared"\n'
            "  lifecycle {\n"
            '    ignore_changes = [tags["ExternalAutomation"]]\n'
            "  }\n"
            "}\n"
        )
        with open(path, "w") as fh:
            fh.write(original)
        r = self.guard()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("merge by hand", r.stderr)
        self.assertEqual(open(path).read(), original, "refuse-don't-corrupt: file untouched")


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.path.join(self.tmp.name, "envroot")
        os.makedirs(self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, extra=None):
        return run_py(NORMALIZE, ["check", "--env-dir", self.env] + (extra or []))

    def test_clean_root_passes(self):
        with open(os.path.join(self.env, "ec2.tf"), "w") as fh:
            fh.write('resource "aws_instance" "a" {\n  instance_type = "t3.micro"\n}\n')
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("check: clean", r.stdout)

    def test_secret_literal_refuses_with_file_line_and_remediation(self):
        shutil.copy(SECRET_FIXTURE, os.path.join(self.env, "rds.tf"))
        r = self.check()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE SECRET_LITERAL", r.stderr)
        self.assertIn("rds.tf:10", r.stderr)
        self.assertIn("gitignored", r.stderr)  # remediation text present

    def test_allowlisted_value_prefixes_are_not_flagged(self):
        # canonical rules allowlist arn:/https:// values even under secret-ish names
        with open(os.path.join(self.env, "iam.tf"), "w") as fh:
            fh.write('resource "aws_iam_role" "r" {\n  secret = "arn:aws:iam::111111111111:role/x"\n}\n')
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_missing_rules_file_fails_closed(self):
        with open(os.path.join(self.env, "a.tf"), "w") as fh:
            fh.write('resource "aws_instance" "a" {\n}\n')
        r = self.check(["--rules", os.path.join(self.tmp.name, "nope.json")])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_RULES", r.stderr)

    def test_null_noise_and_unclassified_are_reported(self):
        with open(os.path.join(self.env, "unclassified.tf"), "w") as fh:
            fh.write('resource "aws_gamelift_fleet" "x" {\n  fleet_type = null\n}\n')
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unclassified.tf present", r.stderr)
        self.assertIn("1 `= null`", r.stdout)


if __name__ == "__main__":
    unittest.main()
