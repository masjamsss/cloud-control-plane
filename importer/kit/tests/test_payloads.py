"""payloads.py — fixture-driven tests (offline, stdlib-only, subprocess
style, mirroring test_gen_imports.py / test_normalize.py).

Run: python3 -m unittest discover -s importer/kit/tests -v

Reuses the EXISTING kit golden fixtures rather than duplicating them:
  testdata/generated/generated.tf.fixture         happy skeletons (incl. the
                                                    decoy-brace heredoc, and a
                                                    stateful aws_db_instance
                                                    whose `password = null`
                                                    must NOT false-positive
                                                    the secret battery)
  testdata/generated/generated-secret.tf.fixture   a literal secret that MUST
                                                    withhold the payload
  fixtures/generated-ambiguous.tf.fixture                  a new fixture (this spec's
                                                    own): an unterminated
                                                    resource block between two
                                                    clean ones

imports-probe.tf inputs are produced by the REAL gen-imports.py (never
hand-typed) so these tests also prove the §2.6 "verbatim reuse, zero new
HCL-emission code" contract end to end.
"""
import json
import os
import shutil
import tempfile
import unittest

from kitpaths import (
    GEN_IMPORTS,
    GENERATED_AMBIGUOUS,
    GENERATED_FIXTURE,
    PAYLOADS,
    REAL_REDACTION_RULES,
    SECRET_FIXTURE,
    run_py,
)

REGION = "ap-southeast-9"
ACCOUNT = "333333333333"


def write_json(path, doc):
    with open(path, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


def candidate_row(rtype, rid, label, name, service="ec2", stateful=False, phase=4):
    return {
        "type": rtype, "id": rid, "label": label, "name": name,
        "service": service, "phase": phase, "stateful": stateful,
        "disposition": "import",
    }


def finding_row(rtype, rid, name, service="ec2", stateful=False, arn=None):
    return {
        "class": "unmanaged_resource", "arn": arn, "tfType": rtype, "liveId": rid,
        "name": name, "service": service, "stateful": stateful, "region": REGION,
        "securityFamily": False, "actor": None, "importPayload": None,
        "payloadWithheldReason": None,
    }


def write_candidates(path, rows):
    write_json(path, {
        "schema": 1, "generator": "test", "account": ACCOUNT, "region": REGION,
        "capturedAt": "2026-07-20T06:00:00Z", "resources": rows,
    })


def write_findings(path, rows):
    write_json(path, {
        "schema": 1, "generator": "test", "method": "test", "account": ACCOUNT,
        "region": REGION, "capturedAt": "2026-07-20T06:00:00Z",
        "findings": rows, "totalFindings": len(rows), "ignoredCount": 0,
        "ignoredByRule": [], "coverage": {"captured": False},
    })


class PayloadsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "findings-out.json")

    def tearDown(self):
        self.tmp.cleanup()

    def path(self, name):
        return os.path.join(self.tmp.name, name)

    def gen_imports(self, cand_rows, out_name="imports-probe.tf"):
        cand_path = self.path("candidates.json")
        write_candidates(cand_path, cand_rows)
        out_tf = self.path(out_name)
        r = run_py(GEN_IMPORTS, ["--manifest", cand_path, "--out", out_tf])
        assert r.returncode == 0, r.stderr
        return cand_path, out_tf

    def run_payloads(self, findings_path, candidates_path, extra=None):
        args = [
            "--findings", findings_path,
            "--candidates", candidates_path,
            "--out", self.out,
        ] + (extra or [])
        return run_py(PAYLOADS, args)

    def load_out(self):
        with open(self.out) as fh:
            return json.load(fh)

    def finding_by_id(self, live_id):
        doc = self.load_out()
        return next(f for f in doc["findings"] if f["liveId"] == live_id)


# ── happy path / golden payload-attach (generated.tf.fixture) ──────────────

class GoldenPayloadAttachTest(PayloadsTestCase):
    """The end-to-end §2.6 step 4 pipeline over the EXISTING generated.tf
    golden fixture: import-block parsing (via the real gen-imports.py),
    skeleton splitting, secret battery (a null password must not
    false-positive), and the stateful guard — all in one run."""

    def setUp(self):
        super().setUp()
        self.cand_rows = [
            candidate_row("aws_instance", "i-0a0a0a0a0a0a0a001", "app_server_1",
                          "app-server-1", service="ec2", stateful=False),
            candidate_row("aws_ebs_volume", "vol-0c0c0c0c0c0c0c001", "app_data",
                          "app-data", service="ebs", stateful=True),
            candidate_row("aws_s3_bucket", "example-app-logs", "example_app_logs",
                          "example-app-logs", service="s3", stateful=True),
            candidate_row("aws_db_instance", "appdb-postgres", "appdb_postgres",
                          "appdb-postgres", service="rds", stateful=True),
        ]
        self.cand_path, self.imports_tf = self.gen_imports(self.cand_rows)
        self.findings_path = self.path("findings.json")
        write_findings(self.findings_path, [
            finding_row(c["type"], c["id"], c["name"], service=c["service"], stateful=c["stateful"])
            for c in self.cand_rows
        ])

    def test_payload_attach_golden_fixture_generated_tf(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("4 attached, 0 withheld", r.stdout)

        server = self.finding_by_id("i-0a0a0a0a0a0a0a001")
        self.assertIsNone(server["payloadWithheldReason"])
        payload = server["importPayload"]
        self.assertEqual(payload["address"], "aws_instance.app_server_1")
        self.assertEqual(payload["targetFile"], "oob-adopted.tf")
        self.assertEqual(
            payload["importBlock"],
            'import {\n  to = aws_instance.app_server_1\n  id = "i-0a0a0a0a0a0a0a001"\n}\n',
        )
        self.assertIn('resource "aws_instance" "app_server_1" {', payload["skeletonHcl"])
        self.assertIn('echo "heredoc with a decoy { brace', payload["skeletonHcl"],
                       "verbatim bytes — the decoy-brace heredoc must survive untouched")
        self.assertNotIn("prevent_destroy", payload["skeletonHcl"], "non-stateful: no guard")

    def test_stateful_candidates_get_prevent_destroy_appended(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        for live_id, address in (
            ("vol-0c0c0c0c0c0c0c001", "aws_ebs_volume.app_data"),
            ("example-app-logs", "aws_s3_bucket.example_app_logs"),
            ("appdb-postgres", "aws_db_instance.appdb_postgres"),
        ):
            finding = self.finding_by_id(live_id)
            skeleton = finding["importPayload"]["skeletonHcl"]
            self.assertIn(
                '  lifecycle {\n    # stateful resource — never destroyed via Terraform '
                '(importer/docs/strategy.md rule 2)\n    prevent_destroy = true\n  }\n}\n',
                skeleton, address,
            )
            self.assertTrue(skeleton.rstrip("\n").endswith("}"), "still a single well-formed block")

    def test_null_valued_attribute_does_not_false_positive_secret_battery(self):
        # appdb_postgres's `password = null` in generated.tf.fixture (not a
        # literal) must not withhold the payload.
        r = self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        finding = self.finding_by_id("appdb-postgres")
        self.assertIsNotNone(finding["importPayload"])
        self.assertIsNone(finding["payloadWithheldReason"])

    def test_rerun_is_byte_identical(self):
        self.assertEqual(self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE,
        ]).returncode, 0)
        with open(self.out) as fh:
            first = fh.read()
        out2 = self.path("findings-out-2.json")
        r = run_py(PAYLOADS, [
            "--findings", self.findings_path, "--candidates", self.cand_path,
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE, "--out", out2,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(out2) as fh:
            second = fh.read()
        self.assertEqual(first, second)


# ── secret battery ───────────────────────────────────────────────────────

class SecretBatteryTests(PayloadsTestCase):
    def test_secret_literal_withholds_the_payload(self):
        cand_rows = [candidate_row("aws_db_instance", "appdb-postgres", "appdb_postgres",
                                    "appdb-postgres", service="rds", stateful=True)]
        cand_path, imports_tf = self.gen_imports(cand_rows)
        findings_path = self.path("findings.json")
        write_findings(findings_path, [finding_row("aws_db_instance", "appdb-postgres",
                                                     "appdb-postgres", service="rds", stateful=True)])
        r = self.run_payloads(findings_path, cand_path, extra=[
            "--imports", imports_tf, "--generated", SECRET_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("0 attached, 1 withheld", r.stdout)
        finding = self.finding_by_id("appdb-postgres")
        self.assertIsNone(finding["importPayload"])
        self.assertEqual(
            finding["payloadWithheldReason"],
            "generated config carries secret-shaped values — import via the kit runbook with "
            "secret handling (e.g. ignore_changes on the secret attribute), never through the "
            "portal",
        )

    def test_allowlisted_value_prefix_is_not_flagged(self):
        # the canonical rules allowlist arn:/https:// etc. values even under
        # secret-ish attribute names (catalog/redaction-rules.json).
        generated = self.path("generated.tf")
        with open(generated, "w") as fh:
            fh.write(
                '# __generated__ by Terraform\n\n'
                'resource "aws_iam_role" "r" {\n'
                '  secret = "arn:aws:iam::111111111111:role/x"\n'
                '}\n'
            )
        cand_rows = [candidate_row("aws_iam_role", "r-1", "r", "r", service="iam", stateful=False)]
        cand_path, imports_tf = self.gen_imports(cand_rows)
        findings_path = self.path("findings.json")
        write_findings(findings_path, [finding_row("aws_iam_role", "r-1", "r", service="iam")])
        r = self.run_payloads(findings_path, cand_path, extra=[
            "--imports", imports_tf, "--generated", generated,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNotNone(self.finding_by_id("r-1")["importPayload"])

    def test_bad_rules_file_fails_closed(self):
        cand_rows = [candidate_row("aws_instance", "i-x", "x", "x")]
        cand_path, imports_tf = self.gen_imports(cand_rows)
        findings_path = self.path("findings.json")
        write_findings(findings_path, [finding_row("aws_instance", "i-x", "x")])
        r = self.run_payloads(findings_path, cand_path, extra=[
            "--imports", imports_tf, "--generated", GENERATED_FIXTURE,
            "--rules", self.path("nope.json"),
        ])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_RULES", r.stderr)

    def test_uses_the_real_vendored_redaction_rules_by_default(self):
        cand_rows = [candidate_row("aws_db_instance", "appdb-postgres", "appdb_postgres",
                                    "appdb-postgres", service="rds", stateful=True)]
        cand_path, imports_tf = self.gen_imports(cand_rows)
        findings_path = self.path("findings.json")
        write_findings(findings_path, [finding_row("aws_db_instance", "appdb-postgres",
                                                     "appdb-postgres", service="rds", stateful=True)])
        # no --rules passed: must default to catalog/redaction-rules.json and still catch it
        r = self.run_payloads(findings_path, cand_path, extra=[
            "--imports", imports_tf, "--generated", SECRET_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNotNone(REAL_REDACTION_RULES)
        self.assertTrue(os.path.exists(REAL_REDACTION_RULES))
        self.assertIsNone(self.finding_by_id("appdb-postgres")["importPayload"])


# ── splitter: happy / ambiguous-refuses ─────────────────────────────────────

class SplitterAmbiguousTests(PayloadsTestCase):
    def setUp(self):
        super().setUp()
        self.cand_rows = [
            candidate_row("aws_instance", "i-clean0000000001", "oob_clean_one", "clean-one"),
            candidate_row("aws_instance", "i-broken0000000002", "oob_broken_two", "broken-two"),
            candidate_row("aws_instance", "i-clean0000000003", "oob_clean_three", "clean-three"),
        ]
        self.cand_path, self.imports_tf = self.gen_imports(self.cand_rows)
        self.findings_path = self.path("findings.json")
        write_findings(self.findings_path, [
            finding_row(c["type"], c["id"], c["name"]) for c in self.cand_rows
        ])

    def test_unterminated_block_is_withheld_neighbors_are_not(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_AMBIGUOUS,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("2 attached, 1 withheld", r.stdout)

        broken = self.finding_by_id("i-broken0000000002")
        self.assertIsNone(broken["importPayload"])
        self.assertIn("unterminated", broken["payloadWithheldReason"])
        self.assertIn("aws_instance.oob_broken_two", broken["payloadWithheldReason"])

        for live_id in ("i-clean0000000001", "i-clean0000000003"):
            clean = self.finding_by_id(live_id)
            self.assertIsNotNone(clean["importPayload"], f"{live_id} must not be poisoned by its broken neighbor")
            self.assertIsNone(clean["payloadWithheldReason"])

    def test_duplicate_address_in_generated_tf_is_withheld(self):
        dup_generated = self.path("generated-dup.tf")
        with open(dup_generated, "w") as fh:
            fh.write(
                'resource "aws_instance" "oob_clean_one" {\n'
                '  instance_type = "t3.micro"\n'
                '}\n\n'
                'resource "aws_instance" "oob_clean_one" {\n'
                '  instance_type = "t3.large"\n'
                '}\n'
            )
        cand_rows = [candidate_row("aws_instance", "i-clean0000000001", "oob_clean_one", "clean-one")]
        cand_path, imports_tf = self.gen_imports(cand_rows, out_name="imports-dup.tf")
        findings_path = self.path("findings-dup.json")
        write_findings(findings_path, [finding_row("aws_instance", "i-clean0000000001", "clean-one")])
        r = self.run_payloads(findings_path, cand_path, extra=[
            "--imports", imports_tf, "--generated", dup_generated,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        finding = self.finding_by_id("i-clean0000000001")
        self.assertIsNone(finding["importPayload"])
        self.assertIn("duplicate", finding["payloadWithheldReason"])


# ── missing/absent generation inputs ────────────────────────────────────────

class MissingInputsTests(PayloadsTestCase):
    def setUp(self):
        super().setUp()
        self.cand_rows = [candidate_row("aws_instance", "i-0a0a0a0a0a0a0a001", "app_server_1", "app-server-1")]
        self.cand_path, self.imports_tf = self.gen_imports(self.cand_rows)
        self.findings_path = self.path("findings.json")
        write_findings(self.findings_path, [finding_row("aws_instance", "i-0a0a0a0a0a0a0a001", "app-server-1")])

    def test_no_generation_inputs_withholds_with_generic_reason(self):
        r = self.run_payloads(self.findings_path, self.cand_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        finding = self.finding_by_id("i-0a0a0a0a0a0a0a001")
        self.assertIsNone(finding["importPayload"])
        self.assertIn("did not run", finding["payloadWithheldReason"])

    def test_probe_error_text_becomes_the_withheld_reason(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=[
            "--probe-error", "Error: creating EC2 Instance: UnauthorizedOperation",
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        finding = self.finding_by_id("i-0a0a0a0a0a0a0a001")
        self.assertEqual(finding["payloadWithheldReason"], "Error: creating EC2 Instance: UnauthorizedOperation")

    def test_only_generated_without_imports_withholds(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=["--generated", GENERATED_FIXTURE])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNone(self.finding_by_id("i-0a0a0a0a0a0a0a001")["importPayload"])

    def test_only_imports_without_generated_withholds(self):
        r = self.run_payloads(self.findings_path, self.cand_path, extra=["--imports", self.imports_tf])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNone(self.finding_by_id("i-0a0a0a0a0a0a0a001")["importPayload"])

    def test_missing_import_block_for_a_candidate_is_withheld(self):
        # a candidate present in --candidates but absent from --imports
        # (e.g. gen-imports.py refused it upstream) must withhold, not crash.
        extra_cand_path = self.path("candidates-extra.json")
        write_candidates(extra_cand_path, self.cand_rows + [
            candidate_row("aws_instance", "i-nowhere00000000", "oob_nowhere", "nowhere"),
        ])
        findings_path = self.path("findings-extra.json")
        write_findings(findings_path, [
            finding_row("aws_instance", "i-0a0a0a0a0a0a0a001", "app-server-1"),
            finding_row("aws_instance", "i-nowhere00000000", "nowhere"),
        ])
        r = self.run_payloads(findings_path, extra_cand_path, extra=[
            "--imports", self.imports_tf, "--generated", GENERATED_FIXTURE,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        finding = self.finding_by_id("i-nowhere00000000")
        self.assertIsNone(finding["importPayload"])
        self.assertIn("no import block", finding["payloadWithheldReason"])


# ── refusal paths ────────────────────────────────────────────────────────────

class RefusalTests(PayloadsTestCase):
    def test_bad_findings_refuses(self):
        cand_path = self.path("candidates.json")
        write_candidates(cand_path, [candidate_row("aws_instance", "i-x", "x", "x")])
        bad = self.path("bad-findings.json")
        write_json(bad, {"no_findings_key": True})
        r = self.run_payloads(bad, cand_path)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_FINDINGS", r.stderr)

    def test_bad_candidates_refuses(self):
        findings_path = self.path("findings.json")
        write_findings(findings_path, [])
        bad = self.path("bad-candidates.json")
        write_json(bad, {"no_resources_key": True})
        r = self.run_payloads(findings_path, bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_CANDIDATES", r.stderr)

    def test_malformed_candidate_refuses(self):
        findings_path = self.path("findings.json")
        write_findings(findings_path, [])
        cand_path = self.path("candidates.json")
        row = candidate_row("aws_instance", "i-x", "x", "x")
        del row["label"]
        write_candidates(cand_path, [row])
        r = self.run_payloads(findings_path, cand_path)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE MALFORMED_CANDIDATE", r.stderr)

    def test_unreadable_findings_refuses(self):
        cand_path = self.path("candidates.json")
        write_candidates(cand_path, [])
        r = self.run_payloads(self.path("nope.json"), cand_path)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_FINDINGS", r.stderr)


if __name__ == "__main__":
    unittest.main()
