"""statediff.py — fixture-driven tests (offline, stdlib-only, subprocess
style, mirroring test_discover.py / test_gen_imports.py).

Run: python3 -m unittest discover -s importer/kit/tests -v

Fixture scenario "sweep-happy" (importer/kit/tests/fixtures/sweep-happy/, 11
live resources) is built once per test via discover.py into a temp dir (so
the raw captures and the built manifest sit side by side, exactly like
discover.sh's real --out layout — this is what makes the tagKey ignore rule
testable) and then diffed against fixtures/plan-sweep-happy.json:

  i-happy...001 lonely-orphan        -> FINDING (nothing matches it)
  i-happy...002 root-state-matched   -> excluded: prior_state root module
  i-happy...003 child-state-matched  -> excluded: prior_state child module
  i-happy...004 asg-member (+ aws:autoscaling:groupName tag) -> ignored: tagKey rule
  i-happy...005 id-ignored-legacy    -> ignored: id rule
  i-happyPFX...006 prefix-ignored-legacy -> ignored: idPrefix rule
  i-happy...007 twin-bastion (#1)    -> FINDING, candidate label "oob_twin_bastion"
  i-happy...008 twin-bastion (#2)    -> FINDING, candidate label collides -> hash-suffixed
  i-happy...009 "---"                -> FINDING, empty sanitize -> hash-suffixed
  iam policy orphan-policy-1         -> FINDING (arn trivially derivable: id IS the arn)
  iam policy legacy-ignored-policy   -> ignored: arn rule

data.aws_ami.decoy in the plan's prior_state shares i-happy...001's id but
carries mode "data" — proving data-source entries are never state-matches.
"""
import hashlib
import json
import os
import shutil
import tempfile
import unittest

from kitpaths import (
    DEFAULT_SERVICES,
    DISCOVER_PY,
    PLAN_EMPTY,
    PLAN_SWEEP_HAPPY,
    REAL_SWEEP_IGNORE,
    STATEDIFF,
    SWEEP_CAP,
    SWEEP_HAPPY,
    SWEEP_IGNORE_TEST,
    WATCHLIST_TEST,
    run_py,
)


def build_manifest(tmp_dir, capture_src, account="333333333333"):
    """Copy a fixture capture dir into tmp_dir and build its manifest THERE
    (captures + manifest side by side) — the real discover.sh layout, and
    the precondition for statediff.py's tagKey raw-capture lookups."""
    cap_dir = os.path.join(tmp_dir, "cap")
    shutil.copytree(capture_src, cap_dir)
    manifest = os.path.join(cap_dir, "discovery-manifest.json")
    r = run_py(DISCOVER_PY, ["build", "--capture-dir", cap_dir, "--out", manifest,
                             "--require-account", account])
    assert r.returncode == 0, r.stderr
    return manifest, cap_dir


class StatediffTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manifest, self.cap_dir = build_manifest(self.tmp.name, SWEEP_HAPPY)
        with open(self.manifest) as fh:
            self.manifest_doc = json.load(fh)
        self.out = os.path.join(self.tmp.name, "unmanaged-findings.json")
        self.candidates_out = os.path.join(self.tmp.name, "candidates-manifest.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_statediff(self, extra=None, plan=PLAN_SWEEP_HAPPY, ignore=SWEEP_IGNORE_TEST,
                       out=None, candidates_out=None):
        out = out or self.out
        candidates_out = self.candidates_out if candidates_out is None else candidates_out
        args = [
            "--manifest", self.manifest,
            "--plan", plan,
            "--services", DEFAULT_SERVICES,
            "--ignore", ignore,
            "--out", out,
        ]
        if candidates_out:
            args += ["--candidates-out", candidates_out]
        return run_py(STATEDIFF, args + (extra or []))

    def load_out(self, path=None):
        with open(path or self.out) as fh:
            return json.load(fh)

    def load_candidates(self):
        with open(self.candidates_out) as fh:
            return json.load(fh)


# ── unmanaged-detected / state-matched-excluded ─────────────────────────────

class DetectionTests(StatediffTestCase):
    def test_unmanaged_detected(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        live_ids = {f["liveId"] for f in doc["findings"]}
        self.assertIn("i-happy0000000000001", live_ids, "a live, state-unmatched, unignored resource must be a finding")
        finding = next(f for f in doc["findings"] if f["liveId"] == "i-happy0000000000001")
        self.assertEqual(finding["class"], "unmanaged_resource")
        self.assertEqual(finding["tfType"], "aws_instance")
        self.assertEqual(finding["name"], "lonely-orphan")
        self.assertIsNone(finding["arn"], "an EC2 instance id is not an arn — must stay null, never guessed")
        self.assertFalse(finding["stateful"])
        self.assertEqual(finding["region"], "ap-southeast-9")
        self.assertFalse(finding["securityFamily"])
        self.assertIsNone(finding["actor"])
        self.assertIsNone(finding["importPayload"])
        self.assertIsNone(finding["payloadWithheldReason"])

    def test_arn_derived_when_the_id_is_already_one(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        policy = next(f for f in doc["findings"] if f["tfType"] == "aws_iam_policy")
        self.assertEqual(policy["arn"], "arn:aws:iam::333333333333:policy/orphan-policy-1")
        self.assertEqual(policy["liveId"], policy["arn"], "aws_iam_policy's id IS the arn (services.json)")

    def test_state_matched_excluded(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        live_ids = {f["liveId"] for f in doc["findings"]}
        self.assertNotIn("i-happy0000000000002", live_ids, "root-module prior_state match must be excluded")
        self.assertNotIn("i-happy0000000000003", live_ids, "child-module prior_state match must be excluded (recursion)")

    def test_data_source_in_prior_state_is_not_a_state_match(self):
        # plan-sweep-happy.json's data.aws_ami.decoy carries i-happy...001's
        # id under mode "data" — if mode filtering were broken, this finding
        # would vanish even though nothing MANAGES it.
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        live_ids = {f["liveId"] for f in doc["findings"]}
        self.assertIn("i-happy0000000000001", live_ids)

    def test_empty_prior_state_finds_everything_unignored(self):
        r = self.run_statediff(plan=PLAN_EMPTY)
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        live_ids = {f["liveId"] for f in doc["findings"]}
        # with no prior_state at all, the two normally-state-matched rows
        # become findings too — an empty state is a legitimate degenerate
        # case (e.g. a brand-new environment), not a refusal.
        self.assertIn("i-happy0000000000002", live_ids)
        self.assertIn("i-happy0000000000003", live_ids)

    def test_coverage_block_carried_verbatim(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        self.assertEqual(doc["coverage"], self.manifest_doc["coverage"])


# ── ignore-rule-counted-not-silent ──────────────────────────────────────────

class IgnoreRuleTests(StatediffTestCase):
    def test_ignore_rule_counted_not_silent(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        live_ids = {f["liveId"] for f in doc["findings"]}
        for excluded in ("i-happy0000000000004", "i-happy0000000000005", "i-happyPFX000000006"):
            self.assertNotIn(excluded, live_ids, f"{excluded} must be excluded by an ignore rule")
        self.assertNotIn("arn:aws:iam::333333333333:policy/legacy-ignored-policy",
                          {f["liveId"] for f in doc["findings"]})
        # suppression is visible: total + per-rule tallies, never silent
        self.assertEqual(doc["ignoredCount"], 4)
        by_kind = {row["kind"]: row for row in doc["ignoredByRule"]}
        self.assertEqual(set(by_kind), {"id", "idPrefix", "tagKey", "arn"})
        for row in doc["ignoredByRule"]:
            self.assertEqual(row["count"], 1)
            self.assertTrue(row["reason"].strip())

    def test_tagkey_rule_reads_raw_capture_tags_not_the_manifest(self):
        # the built manifest itself carries no raw tags (only the resolved
        # display `name`) — this specifically proves the sibling raw-capture
        # lookup is what makes the tagKey rule fire at all.
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("Tags", json.dumps(self.manifest_doc))
        doc = self.load_out()
        self.assertNotIn("i-happy0000000000004", {f["liveId"] for f in doc["findings"]})

    def test_tagkey_rule_is_inert_without_capture_data(self):
        # --capture-dir pointed somewhere with no raw captures at all: the
        # tagKey rule must degrade to "no tags known", never crash the sweep.
        empty_dir = tempfile.mkdtemp(dir=self.tmp.name)
        r = self.run_statediff(extra=["--capture-dir", empty_dir])
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        # the asg-member instance is no longer ignorable (no tag evidence) -> a finding
        self.assertIn("i-happy0000000000004", {f["liveId"] for f in doc["findings"]})

    def test_mandatory_reason_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-ignore.json")
        with open(bad, "w") as fh:
            json.dump({"rules": [{"kind": "id", "type": "aws_instance", "id": "x"}]}, fh)
        r = self.run_statediff(ignore=bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_IGNORE", r.stderr)
        self.assertIn("reason", r.stderr)

    def test_unknown_kind_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-ignore.json")
        with open(bad, "w") as fh:
            json.dump({"rules": [{"kind": "nope", "reason": "x"}]}, fh)
        r = self.run_statediff(ignore=bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_IGNORE", r.stderr)

    def test_real_sweep_ignore_json_is_well_formed_and_seeded(self):
        # the shipped production file (scripts/drift/sweep-ignore.json):
        # parses, every rule has a reason, and the two seed categories the
        # spec names are present (bootstrap-stack rows + the ASG tagKey rule).
        with open(REAL_SWEEP_IGNORE) as fh:
            doc = json.load(fh)
        self.assertIsInstance(doc["rules"], list)
        self.assertGreaterEqual(len(doc["rules"]), 5)
        for rule in doc["rules"]:
            self.assertIn(rule["kind"], ("id", "arn", "tagKey", "idPrefix"))
            self.assertTrue(rule["reason"].strip())
        kinds = [rule["kind"] for rule in doc["rules"]]
        self.assertIn("tagKey", kinds, "the aws:autoscaling:groupName seed rule must be present")
        tagkey_rules = [r for r in doc["rules"] if r["kind"] == "tagKey"]
        self.assertTrue(any(r["tagKey"] == "aws:autoscaling:groupName" for r in tagkey_rules))
        bootstrap_ids = {r["id"] for r in doc["rules"] if r["kind"] == "id"}
        self.assertIn("alarmtickettable", bootstrap_ids, "the real bootstrap state bucket (environments/prod/backend.tf)")
        # the real file must also be directly usable by statediff.py, not just parseable JSON
        r = self.run_statediff(ignore=REAL_SWEEP_IGNORE)
        self.assertEqual(r.returncode, 0, r.stderr)


# ── deterministic-ordering ───────────────────────────────────────────────────

class OrderingTests(StatediffTestCase):
    EXPECTED_ORDER = [
        "i-happy0000000000001",
        "i-happy0000000000007",
        "i-happy0000000000008",
        "i-happy0000000000009",
        "arn:aws:iam::333333333333:policy/orphan-policy-1",
    ]

    def test_deterministic_ordering(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        self.assertEqual([f["liveId"] for f in doc["findings"]], self.EXPECTED_ORDER,
                          "findings must sort by (arn or '', tfType, liveId) — empty-arn EC2 "
                          "instances first (by id), the arn-bearing IAM policy last")

    def test_rerun_is_byte_identical(self):
        self.assertEqual(self.run_statediff().returncode, 0)
        with open(self.out) as fh:
            first = fh.read()
        out2 = os.path.join(self.tmp.name, "unmanaged-findings-2.json")
        self.assertEqual(self.run_statediff(out=out2).returncode, 0)
        with open(out2) as fh:
            second = fh.read()
        self.assertEqual(first, second)
        self.assertNotIn("capturedAt\": \"unknown", first)  # sanity: real value flowed through
        self.assertIn("2026-07-20T06:00:00Z", first, "capturedAt is a passthrough, never wall-clock")


# ── label-derivation + collision-suffix ─────────────────────────────────────

class LabelTests(StatediffTestCase):
    def test_label_derivation(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        cands = {c["id"]: c for c in self.load_candidates()["resources"]}
        self.assertEqual(cands["i-happy0000000000001"]["label"], "oob_lonely_orphan")
        # aws_iam_policy became creation-security once WI-S5 landed the
        # creation_security_types watchlist key (this fixture policy predates it) —
        # correctly EXCLUDED from import candidates now, per the spec's
        # "security-family creations are never portal-importable". Hyphen→underscore
        # label derivation stays covered by the twin-bastion assertions below.
        self.assertNotIn("arn:aws:iam::333333333333:policy/orphan-policy-1", cands)
        for row in cands.values():
            self.assertEqual(row["disposition"], "import")
            self.assertRegex(row["label"], r"^[a-z_][a-z0-9_]*$", "must be a valid HCL identifier (gen-imports.py's own LABEL_RE)")

    def test_label_collision_suffix(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        cands = {c["id"]: c for c in self.load_candidates()["resources"]}
        first = cands["i-happy0000000000007"]["label"]
        second = cands["i-happy0000000000008"]["label"]
        self.assertEqual(first, "oob_twin_bastion", "the first twin (lower liveId, processed first) keeps the bare label")
        expected_suffix = hashlib.sha256(b"aws_instance:i-happy0000000000008").hexdigest()[:8]
        self.assertEqual(second, f"oob_twin_bastion_{expected_suffix}")
        self.assertNotEqual(first, second)

    def test_label_collision_suffix_on_empty_sanitized_name(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        cands = {c["id"]: c for c in self.load_candidates()["resources"]}
        label = cands["i-happy0000000000009"]["label"]
        expected_suffix = hashlib.sha256(b"aws_instance:i-happy0000000000009").hexdigest()[:8]
        self.assertEqual(label, f"oob__{expected_suffix}", "a punctuation-only Name tag sanitizes to empty -> hash-suffixed")

    def test_labels_are_unique_per_type(self):
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = self.load_candidates()["resources"]
        addrs = [f"{row['type']}.{row['label']}" for row in rows]
        self.assertEqual(len(addrs), len(set(addrs)), "no two candidates may share a Terraform address")

    def test_candidates_feed_gen_imports_unchanged(self):
        # §2.6 step 1/2: candidates-manifest.json must be gen-imports.py-ready
        # with ZERO translation — verbatim reuse, zero new HCL-emission code.
        from kitpaths import GEN_IMPORTS
        r = self.run_statediff()
        self.assertEqual(r.returncode, 0, r.stderr)
        out_tf = os.path.join(self.tmp.name, "imports-probe.tf")
        r2 = run_py(GEN_IMPORTS, ["--manifest", self.candidates_out, "--out", out_tf])
        self.assertEqual(r2.returncode, 0, r2.stderr)
        with open(out_tf) as fh:
            text = fh.read()
        self.assertIn("aws_instance.oob_lonely_orphan", text)


# ── security-family advisory (best-effort creation_security_types) ─────────

class SecurityFamilyTests(StatediffTestCase):
    def test_security_family_marks_finding_and_excludes_from_candidates(self):
        r = self.run_statediff(extra=["--watchlist", WATCHLIST_TEST])
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        policy = next(f for f in doc["findings"] if f["tfType"] == "aws_iam_policy")
        self.assertTrue(policy["securityFamily"])
        # still a finding (visible), but never a portal-import candidate
        cand_ids = {c["id"] for c in self.load_candidates()["resources"]}
        self.assertNotIn(policy["liveId"], cand_ids)
        # the EC2 candidates are unaffected
        self.assertIn("i-happy0000000000001", cand_ids)

    def test_missing_watchlist_degrades_to_no_security_family_never_refuses(self):
        missing = os.path.join(self.tmp.name, "does-not-exist.json")
        r = self.run_statediff(extra=["--watchlist", missing])
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = self.load_out()
        self.assertTrue(all(f["securityFamily"] is False for f in doc["findings"]))


# ── candidates-cap-20 ────────────────────────────────────────────────────────

class CandidatesCapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.manifest, _ = build_manifest(self.tmp.name, SWEEP_CAP)
        self.out = os.path.join(self.tmp.name, "unmanaged-findings.json")
        self.candidates_out = os.path.join(self.tmp.name, "candidates-manifest.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_candidates_cap_20(self):
        r = run_py(STATEDIFF, [
            "--manifest", self.manifest, "--plan", PLAN_EMPTY,
            "--services", DEFAULT_SERVICES, "--ignore", SWEEP_IGNORE_TEST,
            "--out", self.out, "--candidates-out", self.candidates_out,
        ])
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out) as fh:
            findings = json.load(fh)
        with open(self.candidates_out) as fh:
            candidates = json.load(fh)["resources"]
        self.assertEqual(findings["totalFindings"], 25, "the cap applies to candidates, never to findings")
        self.assertEqual(len(findings["findings"]), 25)
        self.assertEqual(len(candidates), 20, "candidates-manifest.json is capped at the first 20")
        expected_ids = sorted(f["liveId"] for f in findings["findings"])[:20]
        self.assertEqual(sorted(c["id"] for c in candidates), expected_ids,
                          "the chosen 20 are the first 20 in the same sorted (arn or '', tfType, liveId) order")


# ── refusal paths ────────────────────────────────────────────────────────────

class RefusalTests(StatediffTestCase):
    def test_bad_manifest_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-manifest.json")
        with open(bad, "w") as fh:
            json.dump({"no_resources_key": True}, fh)
        r = run_py(STATEDIFF, [
            "--manifest", bad, "--plan", PLAN_SWEEP_HAPPY, "--services", DEFAULT_SERVICES,
            "--ignore", SWEEP_IGNORE_TEST, "--out", self.out,
        ])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_MANIFEST", r.stderr)

    def test_unreadable_manifest_refuses(self):
        r = run_py(STATEDIFF, [
            "--manifest", os.path.join(self.tmp.name, "nope.json"), "--plan", PLAN_SWEEP_HAPPY,
            "--services", DEFAULT_SERVICES, "--ignore", SWEEP_IGNORE_TEST, "--out", self.out,
        ])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_MANIFEST", r.stderr)

    def test_bad_plan_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-plan.json")
        with open(bad, "w") as fh:
            json.dump({"not_a_plan": True}, fh)
        r = self.run_statediff(plan=bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_PLAN", r.stderr)

    def test_malformed_plan_json_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-plan.json")
        with open(bad, "w") as fh:
            fh.write("{ not json")
        r = self.run_statediff(plan=bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_PLAN", r.stderr)

    def test_bad_services_refuses(self):
        bad = os.path.join(self.tmp.name, "bad-services.json")
        with open(bad, "w") as fh:
            json.dump({"no_types": True}, fh)
        r = self.run_statediff(extra=["--services", bad])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_SERVICES", r.stderr)

    def test_malformed_row_refuses(self):
        bad_manifest = os.path.join(self.tmp.name, "bad-manifest.json")
        doc = dict(self.manifest_doc)
        doc["resources"] = [dict(doc["resources"][0])]
        del doc["resources"][0]["id"]
        with open(bad_manifest, "w") as fh:
            json.dump(doc, fh)
        r = run_py(STATEDIFF, [
            "--manifest", bad_manifest, "--plan", PLAN_SWEEP_HAPPY, "--services", DEFAULT_SERVICES,
            "--ignore", SWEEP_IGNORE_TEST, "--out", self.out,
        ])
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE MALFORMED_ROW", r.stderr)


if __name__ == "__main__":
    unittest.main()
