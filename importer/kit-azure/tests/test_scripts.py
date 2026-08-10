"""discover.sh / verify.sh / run-aztfexport.sh — the SHELL scripts' logic, tested with stub
binaries (testdata/stub-bin) so zero Azure and zero real terraform/aztfexport are ever touched.
clean_env() additionally strips every AWS_*/TF_TOKEN_*/GOOGLE_*/ARM_*/AZURE_* variable from the
subprocess environment — ambient cloud credentials cannot reach these tests."""
import json
import os
import subprocess
import tempfile
import unittest

from kitpaths import (
    DISCOVER_SH, VERIFY_SH, RUN_AZTFEXPORT, MAPPING_FIXTURE, SUBSCRIPTIONS_FIXTURE, run_sh,
    FIXTURE_SUBSCRIPTION, FIXTURE_TENANT,
)

MISMATCH_SUB = "22222222-2222-2222-2222-222222222222"
MISMATCH_TENANT = "33333333-3333-3333-3333-333333333333"


class ShellSyntax(unittest.TestCase):
    def test_bash_n_clean(self):
        for script in (DISCOVER_SH, VERIFY_SH, RUN_AZTFEXPORT):
            r = subprocess.run(["bash", "-n", script], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{script}: {r.stderr}")


class DiscoverSh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "cap")

    def tearDown(self):
        self.tmp.cleanup()

    def _live_env(self, **extra):
        env = {"STUB_SUBSCRIPTION": FIXTURE_SUBSCRIPTION, "STUB_TENANT": FIXTURE_TENANT}
        env.update(extra)
        return env

    def test_dry_run_prints_graph_query_and_writes_nothing(self):
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out, "--dry-run"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("az graph query -q", r.stdout)
        self.assertIn("resources.page", r.stdout)
        self.assertFalse(os.path.exists(self.out), "dry-run must not create the capture dir")

    def test_stub_live_path_records_pages_meta_and_manifest(self):
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env())
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        meta = json.load(open(os.path.join(self.out, "capture-meta.json")))
        self.assertEqual(meta["subscription"], FIXTURE_SUBSCRIPTION)
        self.assertEqual(meta["tenant"], FIXTURE_TENANT)
        manifest = json.load(open(os.path.join(self.out, "discovery-manifest.json")))
        self.assertEqual(manifest["resources"], [])  # stub returns an empty ARG envelope everywhere
        self.assertTrue(os.path.exists(os.path.join(self.out, "resources.page0.json")))
        self.assertTrue(manifest["coverage"]["captured"])
        self.assertEqual(manifest["coverage"]["totalSwept"], 0)

    def test_rerun_clears_stale_pages_from_a_prior_larger_capture(self):
        # IMP-5 — nothing removed a PRIOR run's pages before capturing. A re-run
        # producing FEWER pages than last time (the documented PARTIAL_CAPTURE
        # recovery path, or the estate shrinking across a 1000-row boundary)
        # left the stale higher-numbered page(s) in place, and merge_pages
        # merged them as if current — deleted resources reappearing as live.
        os.makedirs(self.out)
        stale_page = os.path.join(self.out, "resources.page5.json")
        with open(stale_page, "w") as fh:
            json.dump({
                "data": [{
                    "id": "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/phantom-deleted-vnet",
                    "name": "phantom-deleted-vnet", "type": "microsoft.network/virtualnetworks",
                    "location": "southeastasia", "resourceGroup": "rg",
                    "subscriptionId": FIXTURE_SUBSCRIPTION, "tags": {},
                }],
                "count": 1, "total_records": 1,
            }, fh)
        # a stale SINGLE-FILE form too — the other half of the same defect
        # (merge_pages used to merge <capture>.json + <capture>.page*.json
        # together unconditionally when both existed).
        stale_single = os.path.join(self.out, "resources.json")
        with open(stale_single, "w") as fh:
            json.dump({"data": [], "count": 0, "total_records": 0}, fh)

        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env())
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)

        self.assertFalse(os.path.exists(stale_page), "the stale higher-numbered page must be cleared before capturing")
        self.assertFalse(os.path.exists(stale_single), "the stale single-file form must be cleared too")
        manifest = json.load(open(os.path.join(self.out, "discovery-manifest.json")))
        names = [row.get("name") for row in manifest["resources"]]
        self.assertNotIn("phantom-deleted-vnet", names, "a deleted resource must not resurrect from a stale page")

    def test_subscription_mismatch_refuses_before_any_capture(self):
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env(STUB_SUBSCRIPTION=MISMATCH_SUB))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE SUBSCRIPTION_MISMATCH", r.stderr)
        self.assertFalse(os.path.exists(self.out), "nothing may be captured for the wrong subscription")

    def test_tenant_mismatch_refuses(self):
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env(STUB_TENANT=MISMATCH_TENANT))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE TENANT_MISMATCH", r.stderr)

    def test_partial_capture_fails_loudly_and_gap_is_in_the_manifest(self):
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env(STUB_FAIL_SERVICE="graph"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE PARTIAL_CAPTURE", r.stderr)
        manifest = json.load(open(os.path.join(self.out, "discovery-manifest.json")))
        self.assertFalse(manifest["coverage"]["captured"])  # the primary sweep failed — gap in the artifact too

    def test_non_guid_subscription_refuses(self):
        r = run_sh(DISCOVER_SH, ["--subscription", "not-a-guid", "--tenant", FIXTURE_TENANT, "--out", self.out])
        self.assertEqual(r.returncode, 2)
        self.assertIn("GUID", r.stderr)

    def test_location_with_a_quote_refuses_before_any_capture(self):
        # IMP-13(b) — $LOCATION is interpolated unvalidated into capture-meta.json's
        # JSON; a stray '"' would corrupt that file rather than refuse cleanly.
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out, "--location", 'eastus"'], extra_env=self._live_env())
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_ARG", r.stderr)
        self.assertIn("--location", r.stderr)
        self.assertFalse(os.path.exists(self.out), "nothing may be captured for a bad --location")

    def test_mkdir_failure_refuses_loudly(self):
        # IMP-13(a) — `mkdir -p "$OUT"` used to be unchecked.
        with open(self.out, "w") as fh:
            fh.write("not a directory\n")
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env())
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE IO_ERROR", r.stderr)

    def test_meta_write_failure_refuses_loudly_not_a_confusing_downstream_error(self):
        # IMP-13(a) — capture-meta.json's write used to be unchecked.
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env())
        self.assertEqual(r.returncode, 0, r.stderr)
        meta = os.path.join(self.out, "capture-meta.json")
        os.remove(meta)
        os.makedirs(meta)
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env())
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE IO_ERROR", r.stderr)
        self.assertIn("capture-meta.json", r.stderr)

    def test_corrupt_page_makes_next_token_fail_loudly_not_silently_stop_paging(self):
        # IMP-13(d) — next-token's own REFUSE on an unreadable page used to be
        # swallowed (`2>/dev/null`, exit code never checked): an empty $skip
        # from that refusal looked identical to "no more pages, stop" — paging
        # ended early, silently, with the diagnostic stderr thrown away.
        bad_page = os.path.join(self.tmp.name, "not-json.txt")
        with open(bad_page, "w") as fh:
            fh.write("not valid json at all")
        r = run_sh(DISCOVER_SH, ["--subscription", FIXTURE_SUBSCRIPTION, "--tenant", FIXTURE_TENANT,
                                 "--out", self.out], extra_env=self._live_env(STUB_GRAPH_FILE=bad_page))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE PARTIAL_CAPTURE", r.stderr)
        self.assertIn("next-token could not read", r.stderr)
        manifest = json.load(open(os.path.join(self.out, "discovery-manifest.json")))
        self.assertFalse(manifest["coverage"]["captured"])  # the gap is IN the artifact too

    # ── --list-subscriptions: the per-subscription iteration list (multi-sub estates) ──────────
    def test_list_subscriptions_dry_run(self):
        r = run_sh(DISCOVER_SH, ["--list-subscriptions", "--tenant", FIXTURE_TENANT, "--dry-run"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("az graph query", r.stdout)
        self.assertIn("microsoft.resources/subscriptions", r.stdout)

    def test_list_subscriptions_requires_tenant(self):
        r = run_sh(DISCOVER_SH, ["--list-subscriptions"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("requires --tenant", r.stderr)

    def test_list_subscriptions_stub_lists_all_subs_with_mg(self):
        r = run_sh(DISCOVER_SH, ["--list-subscriptions", "--tenant", FIXTURE_TENANT],
                   extra_env={"STUB_TENANT": FIXTURE_TENANT, "STUB_GRAPH_FILE": SUBSCRIPTIONS_FIXTURE})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn(FIXTURE_SUBSCRIPTION, r.stdout)
        self.assertIn("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", r.stdout)
        self.assertIn("mgmt group: Platform", r.stdout)
        self.assertIn("ONCE PER SUBSCRIPTION", r.stdout)

    def test_list_subscriptions_tenant_mismatch_refuses(self):
        r = run_sh(DISCOVER_SH, ["--list-subscriptions", "--tenant", FIXTURE_TENANT],
                   extra_env={"STUB_TENANT": MISMATCH_TENANT, "STUB_GRAPH_FILE": SUBSCRIPTIONS_FIXTURE})
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE TENANT_MISMATCH", r.stderr)


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
        return run_sh(VERIFY_SH, ["--env-dir", self.env_dir, "--phase", phase], extra_env=extra_env or {})

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

    def test_steady_phase_distinguishes_plan_error_from_real_drift(self):
        # IMP-13(c) — -detailed-exitcode's contract is 0 no-op / 1 plan ERROR
        # / 2 real drift; exit 1 used to get the SAME "not a no-op" message
        # as exit 2, reading like drift when the plan didn't even complete.
        self.write_plan("Error: some provider error\n")
        r = self.verify("steady", {"STUB_PLAN_FILE": self.plan, "STUB_PLAN_EXIT": "1"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("ERRORED", r.stderr)
        self.assertIn("not drift", r.stderr)
        self.assertNotIn("not a no-op", r.stderr)

    def test_fmt_gate_fails_first(self):
        r = self.verify("import", {"STUB_FMT_EXIT": "3"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("VERIFY FAIL [fmt]", r.stderr)

    def test_skip_plan_stops_after_validate_and_says_so(self):
        r = run_sh(VERIFY_SH, ["--env-dir", self.env_dir, "--skip-plan"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("NOT the full acceptance bar", r.stdout)


class RunAztfexport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "gen")

    def tearDown(self):
        self.tmp.cleanup()

    def test_mapping_mode_writes_mapping_and_no_state(self):
        r = run_sh(RUN_AZTFEXPORT, ["--mode", "mapping", "--out-dir", self.out,
                                    "--scope-kind", "resource-group", "--scope", "rg-app"],
                   extra_env={"STUB_MAPPING_FILE": MAPPING_FIXTURE})
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.out, "aztfexportResourceMapping.json")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "terraform.tfstate")))
        self.assertIn("no state written", r.stdout)

    def test_state_written_tripwire_refuses(self):
        r = run_sh(RUN_AZTFEXPORT, ["--mode", "hcl", "--out-dir", self.out,
                                    "--scope-kind", "resource-group", "--scope", "rg-app"],
                   extra_env={"STUB_WRITE_STATE": "1"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE STATE_WRITTEN", r.stderr)


if __name__ == "__main__":
    unittest.main()
