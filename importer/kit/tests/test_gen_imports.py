"""gen-imports.py — fixture-driven tests (offline, stdlib-only, subprocess style)."""
import json
import os
import re
import tempfile
import unittest

from kitpaths import DISCOVER_PY, GEN_IMPORTS, HAPPY, run_py


class GenImportsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manifest = os.path.join(self.tmp.name, "manifest.json")
        r = run_py(DISCOVER_PY, ["build", "--capture-dir", HAPPY, "--out", self.manifest])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.out = os.path.join(self.tmp.name, "imports.tf")

    def tearDown(self):
        self.tmp.cleanup()

    def gen(self, extra=None):
        return run_py(GEN_IMPORTS, ["--manifest", self.manifest, "--out", self.out] + (extra or []))

    def read(self):
        with open(self.out) as fh:
            return fh.read()

    def edit_manifest(self, fn):
        with open(self.manifest) as fh:
            m = json.load(fh)
        fn(m)
        with open(self.manifest, "w") as fh:
            json.dump(m, fh, indent=2)

    # ── happy path: prod-archive conventions ────────────────────────────────
    def test_blocks_match_the_prod_archive_shape_and_are_sorted(self):
        r = self.gen()
        self.assertEqual(r.returncode, 0, r.stderr)
        text = self.read()
        blocks = re.findall(r'^import \{\n  to = ([^\n]+)\n  id = "([^"]+)"\n\}$', text, re.M)
        self.assertEqual(len(blocks), 17, "one block per import-disposition resource")
        addrs = [b[0] for b in blocks]
        self.assertEqual(addrs, sorted(addrs), "address-sorted like the original prod generation")
        self.assertIn(("aws_volume_attachment.dev_sdb",
                       "/dev/sdb:vol-0c0c0c0c0c0c0c001:i-0a0a0a0a0a0a0a001"), blocks)

    def test_header_carries_provenance_and_no_real_estate_values(self):
        self.gen()
        text = self.read()
        self.assertIn("Account 111111111111, region ap-southeast-5", text)
        self.assertIn("sha256", text)
        self.assertIn("NOT YET APPLIED", text)
        # Only the synthetic sample account id may appear in generated output —
        # proves no real estate account id leaks, without naming one in public source.
        self.assertLessEqual(set(re.findall(r"\b\d{12}\b", text)), {"111111111111"})

    def test_rerun_is_byte_identical(self):
        self.gen()
        first = self.read()
        self.gen()
        self.assertEqual(first, self.read())

    def test_phase_filter_batches_the_import(self):
        r = self.gen(["--phase", "5"])
        self.assertEqual(r.returncode, 0, r.stderr)
        text = self.read()
        self.assertEqual(text.count("import {"), 3)  # db_instance, dynamodb_table, s3_bucket
        self.assertIn("aws_db_instance.appdb_postgres", text)
        self.assertNotIn("aws_instance.", text)

    def test_region_suffix_applies_to_non_arn_ids(self):
        r = self.gen(["--id-region-suffix", "ap-southeast-1"])
        self.assertEqual(r.returncode, 0, r.stderr)
        text = self.read()
        # the archive's DR convention: "vpc-...@ap-southeast-1"
        self.assertIn('id = "vol-0c0c0c0c0c0c0c001@ap-southeast-1"', text)

    def test_non_import_dispositions_are_excluded_and_counted(self):
        self.edit_manifest(lambda m: m["resources"][0].__setitem__("disposition", "deprecate"))
        r = self.gen()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read().count("import {"), 16)
        self.assertIn("excluded 1 row(s) with disposition 'deprecate'", r.stdout)

    # ── refusal paths ────────────────────────────────────────────────────────
    def test_missing_id_refuses_malformed_row(self):
        def strip_id(m):
            del m["resources"][0]["id"]
        self.edit_manifest(strip_id)
        r = self.gen()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE MALFORMED_ROW", r.stderr)

    def test_invalid_label_refuses(self):
        self.edit_manifest(lambda m: m["resources"][0].__setitem__("label", "9bad-label"))
        r = self.gen()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_LABEL", r.stderr)

    def test_duplicate_address_refuses(self):
        def dup(m):
            m["resources"][1]["type"] = m["resources"][0]["type"]
            m["resources"][1]["label"] = m["resources"][0]["label"]
        self.edit_manifest(dup)
        r = self.gen()
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE DUPLICATE_ADDRESS", r.stderr)


if __name__ == "__main__":
    unittest.main()
