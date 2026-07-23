#!/usr/bin/env python3
"""Tests for build-inventory.py's 0014 fix#4 CLI (--root/--out/--imports).

build-inventory.py is a flat top-to-bottom script (no `if __name__ ==
"__main__":` guard) that writes real output the moment it is imported, so
these tests drive it exclusively as a SUBPROCESS against small fixture
directories under a temp dir — never by importing the module, and never
against the real environments/prod (that invariant is asserted implicitly:
every invocation below passes an explicit --root/--out into a tempdir).

Run: python3 -m unittest ccp/app/scripts/test_build_inventory.py -v
(No new test framework dependency — unittest is Python's standard library;
python-hcl2 is already a hard requirement of the script itself.)
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "build-inventory.py")


def run_script(args, cwd=None):
    return subprocess.run(
        [sys.executable, SCRIPT] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=60,
    )


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


class BuildInventoryCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        os.makedirs(self.root)
        self.out = os.path.join(self.tmp.name, "inventory.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write_tf(self, name, content):
        with open(os.path.join(self.root, name), "w") as fh:
            fh.write(content)

    # ── --help ──────────────────────────────────────────────────────────
    def test_help_flag_documents_root_out_imports_manifests_summary(self):
        r = run_script(["--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        for flag in ("--root", "--out", "--imports", "--manifests", "--summary"):
            self.assertIn(flag, r.stdout, f"{flag} missing from --help output")

    # ── --root / --out basic extraction ────────────────────────────────
    def test_extracts_managed_resource_type_from_a_foreign_root(self):
        # aws_instance is definitely covered by the real Cloud Control Plane manifest
        # catalog (ccp/app/src/data/manifests/ec2.json), so this proves
        # a genuinely foreign --root (no environments/prod, no imports.tf)
        # gets a real, non-empty inventory — the exact gap the 0014/5 audit
        # found: "no such flag exists ... hand-authored inventory.json ...
        # instead".
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n'
            '  instance_type = "t3.micro"\n'
            '  ami           = "ami-0abcdef1234567890"\n'
            '  subnet_id     = "subnet-0123456789abcdef0"\n'
            "  tags = {\n"
            '    Name = "web-server"\n'
            "  }\n"
            "}\n",
        )

        r = run_script(["--root", self.root, "--out", self.out, "--imports", os.path.join(self.root, "none.tf")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WROTE 1 resources", r.stdout)

        data = load_json(self.out)
        self.assertEqual(len(data["resources"]), 1)
        res = data["resources"][0]
        self.assertEqual(res["address"], "aws_instance.web")
        self.assertEqual(res["name"], "web-server")
        self.assertEqual(res["attributes"]["instance_type"], "t3.micro")

    def test_unmanaged_resource_type_is_excluded(self):
        # A resource type no Cloud Control Plane manifest covers must not appear —
        # "managed" filtering is unaffected by the CLI change.
        self.write_tf(
            "queue.tf",
            'resource "aws_sqs_queue" "jobs" {\n  name = "jobs"\n}\n',
        )
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        data = load_json(self.out)
        self.assertEqual(data["resources"], [])

    # ── --imports: optional, graceful ──────────────────────────────────
    def test_missing_imports_file_warns_and_still_writes_output(self):
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n',
        )
        missing = os.path.join(self.tmp.name, "does-not-exist-imports.tf")
        r = run_script(["--root", self.root, "--out", self.out, "--imports", missing])

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WARN", r.stderr)
        self.assertIn("imports file not found", r.stderr)
        self.assertTrue(os.path.exists(self.out))
        data = load_json(self.out)
        self.assertEqual(len(data["resources"]), 1)

    def test_present_imports_file_enriches_instance_az_via_subnet_join(self):
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n'
            '  instance_type = "t3.micro"\n'
            '  subnet_id     = "subnet-0123456789abcdef0"\n'
            "}\n"
            'resource "aws_subnet" "web_subnet" {\n'
            '  availability_zone = "ap-southeast-5a"\n'
            "}\n",
        )
        imports_path = os.path.join(self.tmp.name, "imports.tf")
        with open(imports_path, "w") as fh:
            fh.write(
                'import {\n  to = aws_subnet.web_subnet\n  id = "subnet-0123456789abcdef0@ap-southeast-5"\n}\n'
            )

        r = run_script(["--root", self.root, "--out", self.out, "--imports", imports_path])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("WARN: imports file not found", r.stderr)

        data = load_json(self.out)
        instance = next(x for x in data["resources"] if x["address"] == "aws_instance.web")
        self.assertEqual(instance["attributes"].get("az"), "ap-southeast-5a")

    # ── "source" provenance accuracy (0014 fix#4) ──────────────────────
    def test_source_field_does_not_claim_this_estate_for_a_foreign_root(self):
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n',
        )
        r = run_script(["--root", self.root, "--out", self.out, "--imports", os.path.join(self.root, "none.tf")])
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        self.assertNotIn("environments/prod", data["source"])
        self.assertNotIn("123456789012", data["source"])

    # ── deterministic reruns: resources payload is byte-identical ─────
    # (generatedAt/sourceCommit are git-derived — 0027 §2.5 — and excluded
    # here, EXACTLY the fields the portal-data-freshness CI/gate.sh diff
    # excludes: `del(.generatedAt, .source, .sourceCommit)`. Same rule, both
    # sides, so this test and the freshness gate agree on what "stale" means.)
    VINTAGE_FIELDS = ("generatedAt", "source", "sourceCommit")

    def test_rerun_is_byte_identical(self):
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n  tags = { Name = "w" }\n}\n'
            'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n',
        )
        out2 = os.path.join(self.tmp.name, "inventory2.json")
        r1 = run_script(["--root", self.root, "--out", self.out, "--imports", os.path.join(self.root, "none.tf")])
        r2 = run_script(["--root", self.root, "--out", out2, "--imports", os.path.join(self.root, "none.tf")])
        self.assertEqual(r1.returncode, 0, r1.stderr)
        self.assertEqual(r2.returncode, 0, r2.stderr)

        # This fixture root carries no .git, so both runs currently fall
        # back to the same null vintage anyway (see
        # test_non_git_root_gets_null_vintage_and_warns below) — normalizing
        # here keeps the assertion meaningful regardless of that
        # implementation detail, rather than relying on the fallback's
        # incidental determinism.
        data1 = load_json(self.out)
        data2 = load_json(out2)
        for k in self.VINTAGE_FIELDS:
            data1.pop(k, None)
            data2.pop(k, None)
        self.assertEqual(data1, data2)

    # ── generatedAt/sourceCommit: git-derived vintage (0027 §2.5) ──────
    def test_git_derived_vintage_for_a_real_git_root(self):
        # Prove the git-derived path end to end against a REAL commit: a
        # fresh repo seeded in self.root, one commit, then sourceCommit must
        # be that commit's SHA and generatedAt its committer date.
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n',
        )

        def run_git(*args):
            return subprocess.run(
                ["git", *args], cwd=self.root, capture_output=True, text=True, check=True
            )

        run_git("init", "-q")
        run_git("config", "user.email", "test@example.com")
        run_git("config", "user.name", "Test")
        run_git("add", ".")
        run_git("commit", "-q", "-m", "seed")
        want_sha = run_git("rev-parse", "HEAD").stdout.strip()
        want_date = run_git("log", "-1", "--format=%cI").stdout.strip()

        r = run_script(["--root", self.root, "--out", self.out, "--imports", os.path.join(self.root, "none.tf")])
        self.assertEqual(r.returncode, 0, r.stderr)
        # (the --imports path is deliberately missing above — its own
        # unrelated WARN is expected; only the git-lookup WARN must be absent)
        self.assertNotIn("not inside a git work tree", r.stderr)

        data = load_json(self.out)
        self.assertEqual(data["sourceCommit"], want_sha)
        self.assertEqual(data["generatedAt"], want_date)

    def test_non_git_root_gets_null_vintage_and_warns(self):
        # self.root here is the plain tempdir from setUp — never git-init'd,
        # the "foreign root with no repo at all" case (also every OTHER test
        # in this file, implicitly — this one asserts the fallback by name).
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n',
        )
        r = run_script(["--root", self.root, "--out", self.out, "--imports", os.path.join(self.root, "none.tf")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WARN", r.stderr)
        self.assertIn("not inside a git work tree", r.stderr)

        data = load_json(self.out)
        self.assertIsNone(data["generatedAt"])
        self.assertIsNone(data["sourceCommit"])

    # ── B4: resources in generically-named files must not be silently lost ──
    def test_resources_in_main_tf_are_scanned_with_manifest_service(self):
        # Foreign repos overwhelmingly keep resources in main.tf. The pre-B4
        # scanner skipped main.tf wholesale (a filename-based naming heuristic), so a
        # foreign --root produced "WROTE 0 resources" with exit 0 — silent
        # total data loss. Service must come from the manifests (aws_s3_bucket
        # -> s3), not the meaningless filename.
        self.write_tf(
            "main.tf",
            'resource "aws_s3_bucket" "logs" {\n'
            '  bucket = "foreign-logs-bucket"\n'
            "  tags = {\n"
            '    Name = "logs"\n'
            "  }\n"
            "}\n",
        )
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        inv = load_json(self.out)
        addrs = {x["address"]: x for x in inv["resources"]}
        self.assertIn("aws_s3_bucket.logs", addrs, r.stdout)
        self.assertEqual(addrs["aws_s3_bucket.logs"]["service"], "s3")

    def test_tf_json_resources_are_scanned(self):
        # CDK-TF / generated roots use JSON syntax, typically main.tf.json.
        # Asserts the *.tf.json glob, the JSON single-mapping "resource"
        # shape normalization, and manifest-derived service for the generic
        # filename (aws_dynamodb_table -> dynamodb).
        with open(os.path.join(self.root, "main.tf.json"), "w") as fh:
            json.dump(
                {
                    "resource": {
                        "aws_dynamodb_table": {
                            "sessions": {
                                "name": "foreign-sessions",
                                "hash_key": "id",
                                "billing_mode": "PAY_PER_REQUEST",
                            }
                        }
                    }
                },
                fh,
            )
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        inv = load_json(self.out)
        addrs = {x["address"]: x for x in inv["resources"]}
        self.assertIn("aws_dynamodb_table.sessions", addrs, r.stdout)
        self.assertEqual(addrs["aws_dynamodb_table.sessions"]["service"], "dynamodb")

    def test_zero_resource_run_warns_on_stderr(self):
        # The silent-0 failure mode must never be silent again: exit 0 is
        # fine (an empty root is legal) but stderr must carry the signal.
        self.write_tf("providers.tf", 'provider "aws" {\n  region = "ap-southeast-5"\n}\n')
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("0 resources", r.stderr)

    # ── --manifests: the managed-type catalog is pointable, not hardcoded ──
    def test_manifests_flag_points_at_another_catalog(self):
        # A one-manifest dir that manages ONLY aws_instance: the bucket below
        # must disappear (proving the flag is honored, not the default dir)
        # and the instance's service must come from THIS catalog's manifest.
        manifests_dir = os.path.join(self.tmp.name, "manifests")
        os.makedirs(manifests_dir)
        with open(os.path.join(manifests_dir, "compute-only.json"), "w") as fh:
            json.dump({"service": "customsvc", "resourceTypes": ["aws_instance"]}, fh)
        self.write_tf(
            "main.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n'
            'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n',
        )

        r = run_script(["--root", self.root, "--out", self.out, "--manifests", manifests_dir])
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        addrs = {x["address"]: x for x in data["resources"]}
        self.assertEqual(sorted(addrs), ["aws_instance.web"])
        self.assertEqual(addrs["aws_instance.web"]["service"], "customsvc")

    # ── local modules: unique call → module.<name>. prefixed addresses ─────
    def test_uniquely_called_local_module_gets_prefixed_addresses(self):
        self.write_tf("main.tf", 'module "vpc" {\n  source = "./modules/vpc"\n}\n')
        mod_dir = os.path.join(self.root, "modules", "vpc")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
            fh.write(
                'resource "aws_instance" "web" {\n'
                '  instance_type = "t3.micro"\n'
                "  tags = {\n"
                '    Name = "module-web"\n'
                "  }\n"
                "}\n"
            )

        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        addrs = {x["address"]: x for x in data["resources"]}
        self.assertIn("module.vpc.aws_instance.web", addrs, r.stdout)
        self.assertNotIn("aws_instance.web", addrs)  # never the bare address
        entry = addrs["module.vpc.aws_instance.web"]
        self.assertEqual(entry["name"], "module-web")
        # Generic filename inside the module -> service from the manifests,
        # same rule as root files.
        self.assertEqual(entry["service"], "ec2")

    def test_module_rerun_is_byte_identical(self):
        self.write_tf("main.tf", 'module "vpc" {\n  source = "./modules/vpc"\n}\n')
        mod_dir = os.path.join(self.root, "modules", "vpc")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
            fh.write('resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n')
        out2 = os.path.join(self.tmp.name, "inventory2.json")

        r1 = run_script(["--root", self.root, "--out", self.out])
        r2 = run_script(["--root", self.root, "--out", out2])
        self.assertEqual(r1.returncode, 0, r1.stderr)
        self.assertEqual(r2.returncode, 0, r2.stderr)

        data1, data2 = load_json(self.out), load_json(out2)
        for k in self.VINTAGE_FIELDS:
            data1.pop(k, None)
            data2.pop(k, None)
        self.assertEqual(data1, data2)

    # ── local modules: anything ambiguous is EXCLUDED loudly, never guessed ──
    def test_same_module_dir_called_twice_is_excluded_and_warned(self):
        self.write_tf(
            "main.tf",
            'module "vpc_a" {\n  source = "./modules/vpc"\n}\n'
            'module "vpc_b" {\n  source = "./modules/vpc"\n}\n',
        )
        mod_dir = os.path.join(self.root, "modules", "vpc")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
            fh.write('resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n')

        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)

        # Loud: the warning names the directory AND every call site.
        self.assertIn("EXCLUDED from inventory", r.stderr)
        self.assertIn("ambiguous instantiation", r.stderr)
        self.assertIn(os.path.join("modules", "vpc"), r.stderr)
        self.assertIn('"vpc_a"', r.stderr)
        self.assertIn('"vpc_b"', r.stderr)
        # Counted: the warning carries the number of resources it dropped.
        self.assertIn("1 resource(s)", r.stderr)

        data = load_json(self.out)
        addrs = [x["address"] for x in data["resources"]]
        self.assertEqual(addrs, [])  # neither bare nor either prefixed guess

    def test_count_or_for_each_on_the_call_is_excluded_and_warned(self):
        self.write_tf(
            "main.tf", 'module "vpc" {\n  source = "./modules/vpc"\n  count  = 2\n}\n'
        )
        mod_dir = os.path.join(self.root, "modules", "vpc")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
            fh.write('resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n')

        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ambiguous instantiation", r.stderr)
        self.assertEqual(load_json(self.out)["resources"], [])

    def test_nested_module_call_inside_the_dir_is_excluded_and_warned(self):
        self.write_tf("main.tf", 'module "vpc" {\n  source = "./modules/vpc"\n}\n')
        mod_dir = os.path.join(self.root, "modules", "vpc")
        os.makedirs(mod_dir)
        with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
            fh.write(
                'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n'
                'module "inner" {\n  source = "./inner"\n}\n'
            )

        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ambiguous instantiation", r.stderr)
        self.assertEqual(load_json(self.out)["resources"], [])

    def test_non_local_module_source_is_ignored_root_files_unaffected(self):
        self.write_tf(
            "main.tf",
            'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n'
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n',
        )
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("EXCLUDED", r.stderr)
        addrs = [x["address"] for x in load_json(self.out)["resources"]]
        self.assertEqual(addrs, ["aws_instance.web"])

    # ── --summary: machine-readable run metadata ────────────────────────
    def test_summary_file_carries_counts_warnings_and_provider_pins(self):
        self.write_tf(
            "versions.tf",
            "terraform {\n"
            "  required_providers {\n"
            "    aws = {\n"
            '      source  = "hashicorp/aws"\n'
            '      version = "6.53.0"\n'
            "    }\n"
            "  }\n"
            "}\n",
        )
        self.write_tf(
            "compute.tf",
            'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n'
            'module "twice_a" {\n  source = "./modules/x"\n}\n'
            'module "twice_b" {\n  source = "./modules/x"\n}\n'
            'module "solo" {\n  source = "./modules/solo"\n}\n',
        )
        for d, body in (
            ("x", 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n'),
            ("solo", 'resource "aws_s3_bucket" "kept" {\n  bucket = "kept"\n}\n'),
        ):
            mod_dir = os.path.join(self.root, "modules", d)
            os.makedirs(mod_dir)
            with open(os.path.join(mod_dir, "main.tf"), "w") as fh:
                fh.write(body)
        summary_path = os.path.join(self.tmp.name, "summary.json")

        r = run_script(["--root", self.root, "--out", self.out, "--summary", summary_path])
        self.assertEqual(r.returncode, 0, r.stderr)

        summary = load_json(summary_path)
        self.assertEqual(summary["resourceCount"], 2)  # web + module.solo bucket
        self.assertEqual(summary["byType"]["aws_instance"], 1)
        self.assertEqual(summary["byType"]["aws_s3_bucket"], 1)
        self.assertEqual(
            summary["providerPins"]["aws"], {"source": "hashicorp/aws", "version": "6.53.0"}
        )
        self.assertEqual(
            summary["modulesIncluded"],
            [{"instance": "solo", "dir": os.path.join("modules", "solo"), "resources": 1}],
        )
        self.assertEqual(len(summary["modulesExcluded"]), 1)
        self.assertEqual(summary["modulesExcluded"][0]["calledAs"], ["twice_a", "twice_b"])
        self.assertEqual(summary["modulesExcluded"][0]["reason"], "ambiguous instantiation")
        # Every stderr WARN of the run is machine-readable too.
        self.assertTrue(any("ambiguous instantiation" in w for w in summary["warnings"]))

    def test_no_summary_flag_writes_no_summary_and_keeps_stdout_shape(self):
        self.write_tf(
            "compute.tf", 'resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n'
        )
        r = run_script(["--root", self.root, "--out", self.out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("run summary", r.stdout)
        self.assertIn("WROTE 1 resources", r.stdout)


# ── azurerm PRIORITY/NAME_ATTR display config (0039 S1 lane L) ─────────────
# No real azure manifest is authored by this lane (parallel lanes own those —
# see the azure-fixture project's empty manifests/ dir), so these tests prove
# the PRIORITY/NAME_ATTR entries the same way test_manifests_flag_points_at_
# another_catalog above proves a custom aws-only catalog: a synthetic
# --manifests dir declaring the resourceType as managed, + a synthetic
# azurerm HCL fixture. The moment a real azure manifest lands, these entries
# light up identically for it — inert until referenced, same contract as
# every other type in PRIORITY/NAME_ATTR.
class BuildInventoryAzurermTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        os.makedirs(self.root)
        self.out = os.path.join(self.tmp.name, "inventory.json")
        self.manifests_dir = os.path.join(self.tmp.name, "manifests")
        os.makedirs(self.manifests_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def write_tf(self, name, content):
        with open(os.path.join(self.root, name), "w") as fh:
            fh.write(content)

    def write_manifest(self, filename, service, resource_types):
        with open(os.path.join(self.manifests_dir, filename), "w") as fh:
            json.dump({"service": service, "resourceTypes": resource_types}, fh)

    def run_with_manifests(self):
        return run_script(
            ["--root", self.root, "--out", self.out, "--manifests", self.manifests_dir]
        )

    def test_linux_virtual_machine_priority_attrs_and_real_azurerm_name(self):
        self.write_manifest(
            "azure-compute.json", "azure-compute", ["azurerm_linux_virtual_machine"]
        )
        self.write_tf(
            "main.tf",
            'resource "azurerm_linux_virtual_machine" "web" {\n'
            '  name                = "prod-web01"\n'
            '  resource_group_name = "prod-rg"\n'
            '  location            = "southeastasia"\n'
            '  size                = "Standard_D2s_v5"\n'
            '  admin_username      = "azureuser"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        addrs = {x["address"]: x for x in data["resources"]}
        self.assertIn("azurerm_linux_virtual_machine.web", addrs, r.stdout)
        entry = addrs["azurerm_linux_virtual_machine.web"]
        self.assertEqual(entry["service"], "azure-compute")
        # NAME_ATTR: azure has no tags.Name convention — the real azurerm
        # `name` attribute ("prod-web01") becomes the display name, not the
        # bare tf label ("web").
        self.assertEqual(entry["name"], "prod-web01")
        # PRIORITY: real tf attribute names surface as chips.
        self.assertEqual(entry["attributes"]["size"], "Standard_D2s_v5")
        self.assertEqual(entry["attributes"]["admin_username"], "azureuser")
        # `name` is the row title, never duplicated as a chip.
        self.assertNotIn("name", entry["attributes"])

    def test_storage_account_priority_hits_the_eight_attr_cap_in_priority_order(self):
        self.write_manifest("azure-storage.json", "azure-storage", ["azurerm_storage_account"])
        self.write_tf(
            "main.tf",
            'resource "azurerm_storage_account" "logs" {\n'
            '  name                           = "prodlogsacct"\n'
            '  resource_group_name            = "prod-rg"\n'
            '  location                       = "southeastasia"\n'
            '  account_tier                   = "Standard"\n'
            '  account_replication_type       = "GRS"\n'
            '  account_kind                   = "StorageV2"\n'
            '  access_tier                    = "Hot"\n'
            '  min_tls_version                = "TLS1_2"\n'
            "  https_traffic_only_enabled     = true\n"
            "  public_network_access_enabled  = false\n"
            "  is_hns_enabled                 = true\n"
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(x for x in data["resources"] if x["address"] == "azurerm_storage_account.logs")
        self.assertEqual(entry["name"], "prodlogsacct")
        # PRIORITY declares exactly these 8 (of the 10 non-name attrs the
        # fixture sets) — the MAX_ATTRS=8 cap keeps exactly the priority set,
        # in PRIORITY's own order, ahead of the 2 non-priority extras
        # (resource_group_name, location).
        self.assertEqual(
            list(entry["attributes"].keys()),
            [
                "account_tier",
                "account_replication_type",
                "account_kind",
                "access_tier",
                "min_tls_version",
                "https_traffic_only_enabled",
                "public_network_access_enabled",
                "is_hns_enabled",
            ],
        )
        self.assertEqual(entry["attributes"]["account_tier"], "Standard")
        self.assertIs(entry["attributes"]["https_traffic_only_enabled"], True)
        self.assertIs(entry["attributes"]["public_network_access_enabled"], False)

    def test_key_vault_secret_never_surfaces_a_referenced_secret_value(self):
        # `value` is the SECRET MATERIAL itself — real Terraform never
        # hardcodes it (that would be a plaintext secret in source control);
        # it is always a REFERENCE to a generated/fetched value, e.g.
        # random_password.x.result. python-hcl2 represents any such
        # reference as an interpolation string ("${...}"), which is_expr()
        # already excludes for every type — the same rule that already keeps
        # e.g. a `password = random_password.db.result` off any AWS
        # resource's chips today. `value` is deliberately NOT in the global
        # SKIP set (it collides with aws_ssm_parameter's real, legitimate,
        # non-secret String config document — see the SKIP comment), so this
        # test pins the is_expr() path as the actual guard for the
        # real-world (referenced, not hardcoded) authoring shape.
        self.write_manifest(
            "azure-keyvault.json", "azure-keyvault", ["azurerm_key_vault_secret"]
        )
        self.write_tf(
            "main.tf",
            'resource "random_password" "db" {\n  length = 20\n}\n'
            'resource "azurerm_key_vault_secret" "db_password" {\n'
            "  name         = \"db-password\"\n"
            "  value        = random_password.db.result\n"
            '  key_vault_id = "kv-id"\n'
            '  content_type = "text/plain"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(
            x for x in data["resources"] if x["address"] == "azurerm_key_vault_secret.db_password"
        )
        self.assertEqual(entry["name"], "db-password")
        self.assertEqual(entry["attributes"]["content_type"], "text/plain")
        self.assertNotIn("value", entry["attributes"])

    def test_key_vault_secret_value_wo_is_always_skipped(self):
        # value_wo (Terraform's newer write-only secret-rotation attribute)
        # IS a safe, unambiguous global SKIP entry — unlike bare `value`, no
        # committed AWS resource anywhere uses this name, so excluding it
        # outright (regardless of literal vs. reference) is a clean, narrow
        # win with no collision risk.
        self.write_manifest(
            "azure-keyvault.json", "azure-keyvault", ["azurerm_key_vault_secret"]
        )
        self.write_tf(
            "main.tf",
            'resource "azurerm_key_vault_secret" "db_password" {\n'
            '  name         = "db-password"\n'
            '  value_wo     = "hardcoded-literal-value"\n'
            '  key_vault_id = "kv-id"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(
            x for x in data["resources"] if x["address"] == "azurerm_key_vault_secret.db_password"
        )
        self.assertNotIn("value_wo", entry["attributes"])
        self.assertNotIn("hardcoded-literal-value", json.dumps(entry["attributes"]))

    def test_virtual_machine_admin_password_never_surfaces(self):
        self.write_manifest(
            "azure-compute.json", "azure-compute", ["azurerm_linux_virtual_machine"]
        )
        self.write_tf(
            "main.tf",
            'resource "azurerm_linux_virtual_machine" "web" {\n'
            '  name           = "prod-web01"\n'
            '  size           = "Standard_D2s_v5"\n'
            '  admin_username = "azureuser"\n'
            '  admin_password = "hardcoded-literal-password"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(
            x for x in data["resources"] if x["address"] == "azurerm_linux_virtual_machine.web"
        )
        self.assertNotIn("admin_password", entry["attributes"])
        self.assertNotIn("hardcoded-literal-password", json.dumps(entry["attributes"]))

    def test_mssql_server_administrator_login_password_never_surfaces(self):
        self.write_manifest("azure-database.json", "azure-database", ["azurerm_mssql_server"])
        self.write_tf(
            "main.tf",
            'resource "azurerm_mssql_server" "prod" {\n'
            '  name                         = "prod-sql"\n'
            '  version                      = "12.0"\n'
            '  administrator_login          = "sqladmin"\n'
            '  administrator_login_password = "hardcoded-literal-password"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(x for x in data["resources"] if x["address"] == "azurerm_mssql_server.prod")
        self.assertEqual(entry["attributes"]["version"], "12.0")
        self.assertEqual(entry["attributes"]["administrator_login"], "sqladmin")
        self.assertNotIn("administrator_login_password", entry["attributes"])
        self.assertNotIn("hardcoded-literal-password", json.dumps(entry["attributes"]))

    def test_resource_group_uses_real_name_attribute_and_location_priority(self):
        self.write_manifest("azure-core.json", "azure-core", ["azurerm_resource_group"])
        self.write_tf(
            "main.tf",
            'resource "azurerm_resource_group" "prod" {\n'
            '  name     = "prod-rg"\n'
            '  location = "southeastasia"\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(x for x in data["resources"] if x["address"] == "azurerm_resource_group.prod")
        # The tf LABEL is "prod"; the real azurerm `name` ("prod-rg") is the
        # operator-meaningful identity — NAME_ATTR must prefer it.
        self.assertEqual(entry["name"], "prod-rg")
        self.assertEqual(entry["attributes"]["location"], "southeastasia")

    def test_kubernetes_cluster_priority_attrs(self):
        self.write_manifest(
            "azure-containers.json", "azure-containers", ["azurerm_kubernetes_cluster"]
        )
        self.write_tf(
            "main.tf",
            'resource "azurerm_kubernetes_cluster" "prod" {\n'
            '  name                              = "prod-aks"\n'
            '  sku_tier                          = "Standard"\n'
            '  private_cluster_enabled           = true\n'
            '  role_based_access_control_enabled = true\n'
            "}\n",
        )

        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)

        data = load_json(self.out)
        entry = next(
            x for x in data["resources"] if x["address"] == "azurerm_kubernetes_cluster.prod"
        )
        self.assertEqual(entry["name"], "prod-aks")
        self.assertEqual(entry["attributes"]["sku_tier"], "Standard")
        self.assertIs(entry["attributes"]["private_cluster_enabled"], True)
        self.assertIs(entry["attributes"]["role_based_access_control_enabled"], True)

    def test_a_type_with_no_azure_manifest_reference_stays_unmanaged(self):
        # PRIORITY/NAME_ATTR entries are inert until a manifest's
        # resourceTypes actually names the type — same "managed" gate every
        # aws type already goes through (test_unmanaged_resource_type_is_
        # excluded above). Proves the azure additions did not accidentally
        # widen `managed` on their own.
        self.write_manifest(
            "azure-compute.json", "azure-compute", ["azurerm_linux_virtual_machine"]
        )
        self.write_tf(
            "main.tf",
            'resource "azurerm_storage_account" "logs" {\n  name = "logs"\n}\n',
        )
        r = self.run_with_manifests()
        self.assertEqual(r.returncode, 0, r.stderr)
        data = load_json(self.out)
        self.assertEqual(data["resources"], [])


if __name__ == "__main__":
    unittest.main()
