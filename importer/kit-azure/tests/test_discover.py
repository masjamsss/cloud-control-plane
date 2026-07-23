"""discover.py — the offline transformer, tested against recorded ARG fixtures (zero Azure).

Mirrors importer/kit/tests/test_discover.py. Every case drives discover.py as a subprocess via
run_py against a recorded testdata/ capture dir — the identical code path a real capture dir
takes, so a green suite means the real pipeline works too."""
import json
import os
import tempfile
import unittest

from kitpaths import (
    DISCOVER_PY, SERVICES, HAPPY, UNKNOWN, MALFORMED, COVERAGE_MALFORMED, PAGED,
    SUBSCRIPTIONS_FIXTURE, run_py, FIXTURE_SUBSCRIPTION, FIXTURE_TENANT,
)


def build(capture_dir, out, *extra):
    return run_py(DISCOVER_PY, ["build", "--capture-dir", capture_dir, "--services", SERVICES, "--out", out, *extra])


class PlanCommands(unittest.TestCase):
    def test_emits_capture_tab_kql(self):
        r = run_py(DISCOVER_PY, ["plan-commands", "--services", SERVICES])
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertTrue(any(l.startswith("resources\t") for l in lines))
        self.assertIn("Resources", r.stdout)  # the KQL table name
        for l in lines:
            self.assertIn("\t", l)  # capture<TAB>kql


class Build(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "m.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_happy_extracts_and_classifies(self):
        r = build(HAPPY, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.load(open(self.out))
        types = sorted(row["type"] for row in m["resources"])
        self.assertEqual(types, [
            "azurerm_key_vault", "azurerm_resource_group",
            "azurerm_storage_account", "azurerm_virtual_network",
        ])
        for row in m["resources"]:
            self.assertTrue(row["label"])
            self.assertEqual(row["providerHint"], "azurerm")
            self.assertEqual(row["disposition"], "import")
        # the VM is a manual type: classified, not extracted, never silently dropped
        manual = {t["type"] for t in m["coverage"]["manualTypes"]}
        self.assertIn("microsoft.compute/virtualmachines", manual)
        self.assertEqual(m["coverage"]["unrecognizedResourceTypes"], [])
        self.assertTrue(m["coverage"]["captured"])
        self.assertEqual(m["subscription"], FIXTURE_SUBSCRIPTION)
        self.assertEqual(m["tenant"], FIXTURE_TENANT)
        self.assertTrue(m["servicesSha256"])

    def test_deterministic_byte_identical(self):
        build(HAPPY, self.out)
        a = open(self.out).read()
        out2 = os.path.join(self.tmp.name, "m2.json")
        build(HAPPY, out2)
        self.assertEqual(a, open(out2).read())

    def test_unknown_type_is_loud_not_fatal(self):
        r = build(UNKNOWN, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.load(open(self.out))
        unrec = {t["type"] for t in m["coverage"]["unrecognizedResourceTypes"]}
        self.assertIn("microsoft.cache/redis", unrec)
        self.assertIn("unrecognized", r.stderr.lower())
        redis = next(t for t in m["coverage"]["unrecognizedResourceTypes"] if t["type"] == "microsoft.cache/redis")
        self.assertIn("REDACTED", redis["sampleId"])
        self.assertNotIn(FIXTURE_SUBSCRIPTION, redis["sampleId"])  # leak guard: no live sub id in the clear

    def test_malformed_missing_id_refuses(self):
        r = build(MALFORMED, self.out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE MALFORMED_RECORD", r.stderr)

    def test_coverage_malformed_missing_type_refuses(self):
        r = build(COVERAGE_MALFORMED, self.out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_CAPTURE", r.stderr)

    def test_subscription_mismatch_refuses(self):
        r = build(HAPPY, self.out, "--require-subscription", "99999999-9999-9999-9999-999999999999")
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE SUBSCRIPTION_MISMATCH", r.stderr)

    def test_tenant_mismatch_refuses(self):
        r = build(HAPPY, self.out, "--require-subscription", FIXTURE_SUBSCRIPTION,
                  "--require-tenant", "99999999-9999-9999-9999-999999999999")
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE TENANT_MISMATCH", r.stderr)

    def test_paged_merges_all_pages(self):
        r = build(PAGED, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.load(open(self.out))
        names = sorted(row["name"] for row in m["resources"])
        self.assertEqual(names, ["stpage1data", "vnet-page0"])  # one row from each page merged


class ListSubscriptions(unittest.TestCase):
    def test_formats_subs_with_mgmt_group_and_iteration_note(self):
        r = run_py(DISCOVER_PY, ["list-subscriptions", "--capture", SUBSCRIPTIONS_FIXTURE,
                                 "--tenant", FIXTURE_TENANT])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("subscriptions visible under tenant", r.stdout)
        self.assertIn(FIXTURE_SUBSCRIPTION, r.stdout)                       # sub-prod
        self.assertIn("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", r.stdout)      # sub-dev
        self.assertIn("mgmt group: Platform", r.stdout)                     # MG chain surfaced
        self.assertIn("ONCE PER SUBSCRIPTION", r.stdout)                    # the loud iteration note

    def test_empty_capture_warns_reader_gap(self):
        import json, os, tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "subs.json")
            json.dump({"data": [], "count": 0}, open(p, "w"))
            r = run_py(DISCOVER_PY, ["list-subscriptions", "--capture", p, "--tenant", FIXTURE_TENANT])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(": 0", r.stdout)          # count line shows zero subscriptions
            self.assertIn("Reader", r.stderr)        # loud "you likely lack Reader" gap warning


class NextToken(unittest.TestCase):
    def test_prints_token_when_present(self):
        r = run_py(DISCOVER_PY, ["next-token", "--page", os.path.join(PAGED, "resources.page0.json")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "PAGE0TOKEN==")

    def test_prints_nothing_when_last_page(self):
        r = run_py(DISCOVER_PY, ["next-token", "--page", os.path.join(PAGED, "resources.page1.json")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
