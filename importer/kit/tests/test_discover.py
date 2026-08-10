"""discover.py — fixture-driven tests (offline, stdlib-only, subprocess style).

Run: python3 -m unittest discover -s importer/kit/tests -v
"""
import json
import re
import os
import shutil
import tempfile
import unittest

from kitpaths import (
    COVERAGE_MALFORMED,
    COVERAGE_WARN,
    DEFAULT_SERVICES,
    DISCOVER_PY,
    HAPPY,
    MALFORMED,
    REPO_ROOT,
    UNKNOWN,
    run_py,
)


def build(capture_dir, out, extra=None):
    return run_py(DISCOVER_PY, ["build", "--capture-dir", capture_dir, "--out", out] + (extra or []))


class BuildHappyPath(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "manifest.json")
        r = build(HAPPY, self.out, ["--require-account", "111111111111"])
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as fh:
            self.manifest = json.load(fh)
        self.addrs = {f"{x['type']}.{x['label']}": x for x in self.manifest["resources"]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_expected_resources_extracted(self):
        self.assertEqual(len(self.manifest["resources"]), 17)
        for addr in (
            "aws_instance.app_server_1",
            "aws_instance.dbserver2",          # STOPPED instance MUST import (prod PR #8 lesson)
            "aws_ebs_volume.app_data",
            "aws_volume_attachment.dev_sdb",   # derived from Attachments[]
            "aws_vpc.vpc_main",
            "aws_s3_bucket.example_app_logs",
            "aws_iam_role.app_runtime",
            "aws_kms_key.alias_app_data",
            "aws_kms_alias.alias_app_data",
            "aws_db_instance.appdb_postgres",
            "aws_dynamodb_table.sessions_table",  # scalar-string records
        ):
            self.assertIn(addr, self.addrs)

    def test_volume_attachment_id_matches_prod_convention(self):
        att = self.addrs["aws_volume_attachment.dev_sdb"]
        # device:volume:instance — the exact shape importer/prod/imports.tf used
        self.assertEqual(att["id"], "/dev/sdb:vol-0c0c0c0c0c0c0c001:i-0a0a0a0a0a0a0a001")

    def test_duplicate_names_get_numbered_labels(self):
        self.assertIn("aws_security_group.web_sg", self.addrs)
        self.assertIn("aws_security_group.web_sg_2", self.addrs)
        # deterministic order: lower id wins the bare label
        self.assertEqual(self.addrs["aws_security_group.web_sg"]["id"], "sg-0e0e0e0e0e0e0e001")

    def test_skipped_records_are_ignored_with_reasons_never_dropped(self):
        ignored = {(x["type"], x["id"]): x["reason"] for x in self.manifest["ignored"]}
        self.assertIn(("aws_instance", "i-0a0a0a0a0a0a0a003"), ignored)  # terminated
        self.assertIn(("aws_iam_role", "AWSServiceRoleForSupport"), ignored)  # service-linked
        self.assertIn(("aws_security_group", "sg-0e0e0e0e0e0e0e003"), ignored)  # default SG
        self.assertIn(("aws_kms_alias", "alias/aws/s3"), ignored)  # AWS-managed alias
        for reason in ignored.values():
            self.assertTrue(reason.strip(), "every ignore must carry a reason")

    def test_missing_captures_are_listed_loudly(self):
        missing = {m["capture"] for m in self.manifest["missing_captures"]}
        self.assertIn("rds-db-subnet-groups", missing)
        self.assertIn("elbv2-load-balancers", missing)
        for m in self.manifest["missing_captures"]:
            self.assertTrue(m["cli"].startswith("aws "), "each gap names the command that closes it")

    def test_manual_followup_travels_in_the_manifest(self):
        groups = self.manifest["manual_followup"]
        self.assertTrue(groups, "services.json manual section must reach the manifest")
        all_types = [t for g in groups for t in g["types"]]
        self.assertIn("aws_lb_listener_rule", all_types)
        self.assertIn("aws_s3_bucket_versioning", all_types)

    def test_stateful_and_phase_metadata(self):
        self.assertTrue(self.addrs["aws_db_instance.appdb_postgres"]["stateful"])
        self.assertEqual(self.addrs["aws_db_instance.appdb_postgres"]["phase"], 5)
        self.assertFalse(self.addrs["aws_instance.app_server_1"]["stateful"])
        self.assertEqual(self.addrs["aws_vpc.vpc_main"]["phase"], 3)

    def test_rerun_is_byte_identical(self):
        out2 = os.path.join(self.tmp.name, "manifest2.json")
        r = build(HAPPY, out2)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as a, open(out2) as b:
            self.assertEqual(a.read(), b.read())

    def test_no_real_estate_values(self):
        blob = json.dumps(self.manifest)
        # Only the synthetic require-account id may appear — no real account id leaks.
        self.assertLessEqual(set(re.findall(r"\b\d{12}\b", blob)), {"111111111111"})
        # Region literals come from the untracked estate denylist (ESTATE_DENYLIST_FILE
        # env, else repo-root .estate-denylist.json) — never a hardcoded literal here (O6).
        # A missing/empty list passes trivially: the public checkout is inert, while the
        # private CI supplies the real region and this proves a generated discovery
        # manifest never embeds it.
        denylist_file = os.environ.get(
            "ESTATE_DENYLIST_FILE", os.path.join(REPO_ROOT, ".estate-denylist.json")
        )
        regions = []
        try:
            with open(denylist_file) as fh:
                regions = json.load(fh).get("region", [])
        except (OSError, ValueError):
            regions = []
        for region in regions:
            self.assertNotIn(region, blob)

    def test_coverage_sweep_all_recognized(self):
        # capture-happy/coverage-resources.json: 11 swept ARNs, all in families
        # services.json already accounts for (5 types-covered, 1 manual) — the
        # "happy: all recognized" coverage-sweep case, exercised end-to-end
        # alongside a full discovery rather than in isolation.
        coverage = self.manifest["coverage"]
        self.assertEqual(coverage["method"], "resourcegroupstaggingapi (taggable resources only)")
        self.assertTrue(coverage["captured"])
        self.assertEqual(coverage["totalSwept"], 11)
        self.assertEqual(coverage["unrecognizedArnFamilies"], [])
        covered = {f["family"]: f["count"] for f in coverage["coveredTypes"]}
        self.assertEqual(covered.get("ec2"), 2)
        self.assertEqual(covered.get("s3"), 1)
        self.assertEqual(covered.get("iam"), 1)
        self.assertEqual(covered.get("kms"), 4)
        manual = {f["family"]: f["count"] for f in coverage["manualTypes"]}
        self.assertEqual(manual.get("sagemaker"), 1)


# ── IMP-15: a covered family can still hide an undiscoverable type ──────────

class ShadowedTypeCoverageTests(unittest.TestCase):
    """`aws_kms_key` is discovered ONLY through `kms list-aliases`, so a
    customer key with no alias is invisible — while its swept ARN lands in
    family `kms`, which the sweep calls covered. The one mechanism built to
    catch discovery gaps reported this gap as covered."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        out = os.path.join(cls.tmp.name, "manifest.json")
        r = build(HAPPY, out)
        assert r.returncode == 0, r.stderr
        cls.stderr = r.stderr
        with open(out) as fh:
            cls.manifest = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @property
    def shadow(self):
        """The aws_kms_key shadow row. Resolved per-test rather than in
        setUpClass so that its ABSENCE fails each assertion with its own
        message — a setUpClass that raises collapses the whole class into one
        error and tells you nothing about which property broke."""
        rows = self.manifest["coverage"].get("shadowedTypes", [])
        row = next((s for s in rows if s.get("type") == "aws_kms_key"), None)
        self.assertIsNotNone(
            row,
            "coverage must report aws_kms_key as a shadowed type: its only lister is "
            "kms list-aliases, so family 'kms' being 'covered' is not the same as this type "
            "being discoverable (IMP-15)",
        )
        return row

    def test_the_fixture_really_contains_an_undiscoverable_key(self):
        # L-1: every assertion below is vacuous if the fixture stopped
        # containing an unaliased key, or if discovery started finding it.
        # Both halves are pinned here, read from the fixture and the manifest.
        with open(os.path.join(HAPPY, "coverage-resources.json")) as fh:
            swept = [i["ResourceARN"] for i in json.load(fh)["ResourceTagMappingList"]]
        key_arns = [a for a in swept if ":key/" in a]
        self.assertEqual(len(key_arns), 3, "the sweep must see 3 KMS key ARNs")
        with open(os.path.join(HAPPY, "kms-aliases.json")) as fh:
            aliased = {a["TargetKeyId"] for a in json.load(fh)["Aliases"]}
        unaliased = [a for a in key_arns if a.rsplit("/", 1)[1] not in aliased]
        self.assertEqual(len(unaliased), 1,
                          "exactly one swept key must have NO alias — that is the shadow")
        self.assertEqual(self.shadow["sweptCount"], 3)
        self.assertTrue(self.shadow["mappingMatched"],
                        "the declared arnResourceType must actually match this provider's ARNs — "
                        "a mapping that matches nothing makes every count below meaningless")

    def test_the_unaliased_key_is_named_not_swallowed_by_a_covered_family(self):
        self.assertEqual(self.shadow["undiscoveredCount"], 1)
        self.assertEqual(self.shadow["undiscoveredIds"], ["99999999-eeee-ffff-0000-111111111111"])
        self.assertEqual(self.shadow["family"], "kms")
        self.assertTrue(self.shadow["reason"].strip(), "a shadow must say why it exists")

    def test_the_covered_row_no_longer_claims_a_coverage_it_does_not_have(self):
        kms = next(f for f in self.manifest["coverage"]["coveredTypes"] if f["family"] == "kms")
        self.assertEqual(kms["undiscovered"], 1,
                          "the covered row itself must carry the shortfall — a separate section "
                          "is too easy to read past, which is how this stayed invisible")

    def test_the_gap_is_loud_on_stderr(self):
        self.assertIn("were swept but NOT discovered", self.stderr)
        self.assertIn("99999999-eeee-ffff-0000-111111111111", self.stderr)

    def test_a_deliberately_ignored_record_is_not_a_shadow(self):
        # alias/aws/s3's target key is skipped WITH a reason (AWS-managed).
        # It is accounted for in manifest["ignored"], which is the opposite of
        # invisible — counting it undiscovered would be a false positive this
        # check manufactured for itself.
        aws_managed = "11111111-aaaa-bbbb-cccc-dddddddddddd"
        ignored_ids = {r["id"] for r in self.manifest["ignored"] if r["type"] == "aws_kms_key"}
        self.assertIn(aws_managed, ignored_ids, "precondition: the fixture skips the AWS-managed key")
        self.assertNotIn(aws_managed, self.shadow["undiscoveredIds"])

    def test_the_alias_arn_does_not_count_as_a_key(self):
        # Family `kms` covers both `key/…` and `alias/…` ARNs. If the token
        # were ignored the alias would inflate sweptCount to 4 and the diff
        # would report a phantom undiscovered key.
        self.assertEqual(self.shadow["arnResourceType"], "key")
        self.assertEqual(self.shadow["sweptCount"], 3)

    def test_every_declared_shadow_is_shaped_and_reachable(self):
        # The rule, not the list (L-25): whatever set of types declares a
        # shadow, each must be reportable — named field, non-empty reason, and
        # present in the computed coverage block.
        with open(DEFAULT_SERVICES) as fh:
            types = json.load(fh)["types"]
        declared = {t: s["shadow"] for t, s in types.items() if "shadow" in s}
        self.assertTrue(declared, "precondition: at least one type declares a shadow")
        reported = {s["type"] for s in self.manifest["coverage"]["shadowedTypes"]}
        for rtype, shadow in declared.items():
            self.assertTrue(shadow.get("arnResourceType"), f"{rtype} shadow needs arnResourceType")
            self.assertTrue(shadow.get("reason", "").strip(), f"{rtype} shadow needs a reason")
            self.assertIn(rtype, reported, f"{rtype} declares a shadow but coverage never reports it")

    def test_an_incomplete_shadow_declaration_refuses(self):
        with open(DEFAULT_SERVICES) as fh:
            services = json.load(fh)
        services["types"]["aws_kms_key"]["shadow"] = {"arnResourceType": "key"}
        bad = os.path.join(self.tmp.name, "services-no-reason.json")
        with open(bad, "w") as fh:
            json.dump(services, fh)
        out = os.path.join(self.tmp.name, "refused.json")
        r = run_py(DISCOVER_PY, ["build", "--capture-dir", HAPPY, "--out", out, "--services", bad])
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertIn("REFUSE BAD_SERVICES", r.stderr)
        self.assertIn("reason", r.stderr)


class RefusalAndWarnPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "manifest.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_unmapped_capture_is_reported_not_silently_dropped(self):
        r = build(UNKNOWN, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as fh:
            manifest = json.load(fh)
        unmapped = [u["capture"] for u in manifest["unmapped_captures"]]
        self.assertEqual(unmapped, ["sqs-queues.json"])
        self.assertIn("sqs-queues.json", r.stderr)  # loud on stderr too
        self.assertIn("NOT imported", manifest["unmapped_captures"][0]["reason"])

    def test_record_without_id_refuses_malformed_record(self):
        r = build(MALFORMED, self.out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE MALFORMED_RECORD", r.stderr)
        self.assertFalse(os.path.exists(self.out), "no manifest may be written on refusal")

    def test_corrupt_capture_json_refuses(self):
        cap = os.path.join(self.tmp.name, "cap")
        shutil.copytree(HAPPY, cap)
        with open(os.path.join(cap, "ec2-vpcs.json"), "w") as fh:
            fh.write("{ this is not json")
        r = build(cap, self.out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_CAPTURE", r.stderr)

    def test_wrong_account_refuses(self):
        r = build(HAPPY, self.out, ["--require-account", "222222222222"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE ACCOUNT_MISMATCH", r.stderr)

    def test_classification_overrides_change_disposition(self):
        cls = os.path.join(self.tmp.name, "classify.json")
        with open(cls, "w") as fh:
            json.dump({"by_id": {"i-0a0a0a0a0a0a0a002": "deprecate"}}, fh)
        r = build(HAPPY, self.out, ["--classify", cls])
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as fh:
            manifest = json.load(fh)
        row = next(x for x in manifest["resources"] if x["id"] == "i-0a0a0a0a0a0a0a002")
        self.assertEqual(row["disposition"], "deprecate")

    def test_bad_disposition_refuses(self):
        cls = os.path.join(self.tmp.name, "classify.json")
        with open(cls, "w") as fh:
            json.dump({"by_id": {"i-0a0a0a0a0a0a0a002": "delete-it"}}, fh)
        r = build(HAPPY, self.out, ["--classify", cls])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_CLASSIFY", r.stderr)


class CoverageSweep(unittest.TestCase):
    """The account-wide coverage sweep (Gap 1): coverage-resources.json (an
    `aws resourcegroupstaggingapi get-resources` capture) -> manifest["coverage"].
    Happy-all-recognized lives on BuildHappyPath.test_coverage_sweep_all_recognized
    (capture-happy carries a coverage-resources.json too); this class covers the
    warn/refuse/absent/idempotent paths with minimal dedicated fixtures (only
    capture-meta.json + coverage-resources.json — every other type shows up as
    missing_captures, which is expected and irrelevant here)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "manifest.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_warn_on_unrecognized_families_but_does_not_fail_the_build(self):
        r = build(COVERAGE_WARN, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)  # a report, not a gate
        self.assertIn(
            'WARN: 3 resource(s) in 2 unrecognized ARN families — NOT imported, extend services.json',
            r.stderr,
        )
        with open(self.out) as fh:
            manifest = json.load(fh)
        coverage = manifest["coverage"]
        self.assertEqual(coverage["totalSwept"], 4)
        families = {f["family"]: f for f in coverage["unrecognizedArnFamilies"]}
        self.assertEqual(set(families), {"kinesis", "elasticache"})
        self.assertEqual(families["kinesis"]["count"], 2)
        self.assertEqual(families["elasticache"]["count"], 1)
        # sample ARNs are account-redacted, never the live account id
        for fam in families.values():
            self.assertNotIn("111111111111", fam["sampleArn"])
            self.assertIn("REDACTED", fam["sampleArn"])
        covered = {f["family"]: f["count"] for f in coverage["coveredTypes"]}
        self.assertEqual(covered, {"ec2": 1})

    def test_malformed_arn_refuses_bad_capture(self):
        r = build(COVERAGE_MALFORMED, self.out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_CAPTURE", r.stderr)
        self.assertIn("not-an-arn-at-all", r.stderr)
        self.assertFalse(os.path.exists(self.out), "no manifest may be written on refusal")

    def test_absent_coverage_capture_is_honest_not_fatal(self):
        # UNKNOWN has no coverage-resources.json at all (predates this feature,
        # like every other pre-existing fixture) — the sweep must degrade to an
        # honest "not captured", never a crash or a guess.
        r = build(UNKNOWN, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as fh:
            manifest = json.load(fh)
        coverage = manifest["coverage"]
        self.assertFalse(coverage["captured"])
        self.assertEqual(coverage["totalSwept"], 0)
        self.assertEqual(coverage["coveredTypes"], [])
        self.assertEqual(coverage["manualTypes"], [])
        self.assertEqual(coverage["unrecognizedArnFamilies"], [])

    def test_rerun_is_byte_identical(self):
        out2 = os.path.join(self.tmp.name, "manifest2.json")
        r1 = build(COVERAGE_WARN, self.out)
        r2 = build(COVERAGE_WARN, out2)
        self.assertEqual(r1.returncode, 0, r1.stderr)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        with open(self.out) as a, open(out2) as b:
            self.assertEqual(a.read(), b.read())


class PlanCommands(unittest.TestCase):
    def test_lines_are_capture_tab_aws_command(self):
        r = run_py(DISCOVER_PY, ["plan-commands", "--region", "ap-southeast-5"])
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.splitlines() if l]
        self.assertGreater(len(lines), 30)
        for line in lines:
            capture, cmd = line.split("\t")
            self.assertTrue(cmd.startswith("aws "), line)
            self.assertIn("--region ap-southeast-5", cmd)
        captures = [l.split("\t")[0] for l in lines]
        self.assertEqual(captures, sorted(captures))
        self.assertEqual(len(captures), len(set(captures)), "captures listed once each")


if __name__ == "__main__":
    unittest.main()
