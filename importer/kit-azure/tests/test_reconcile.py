"""reconcile.py — inverts aztfexport's silent best-effort into loud gaps (zero cloud)."""
import json
import os
import tempfile
import unittest

from kitpaths import RECONCILE, run_py

BASE = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.Network/virtualNetworks"
A = f"{BASE}/a"
B = f"{BASE}/b"


def manifest(id_types):
    return {"resources": [
        {"type": t, "id": i, "name": "n", "label": "l", "service": "s",
         "phase": 3, "stateful": False, "providerHint": "azurerm", "disposition": "import"}
        for i, t in id_types
    ]}


def mapping(ids):
    return {i: {"resource_type": "azurerm_x", "resource_name": "n", "resource_id": i} for i in ids}


class Reconcile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, m, mp, *extra):
        mpath = os.path.join(self.tmp.name, "m.json")
        json.dump(m, open(mpath, "w"))
        mapp = os.path.join(self.tmp.name, "map.json")
        json.dump(mp, open(mapp, "w"))
        return run_py(RECONCILE, ["--manifest", mpath, "--mapping", mapp, *extra])

    def test_all_mapped_ok(self):
        r = self._run(manifest([(A, "azurerm_virtual_network"), (B, "azurerm_storage_account")]), mapping([A, B]))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no silent gaps", r.stdout)

    def test_gap_reported_loudly_but_not_refused(self):
        r = self._run(manifest([(A, "azurerm_virtual_network"), (B, "azurerm_storage_account")]), mapping([A]))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("UNMAPPED BY ENGINE", r.stderr)
        self.assertIn(B, r.stderr)

    def test_gap_strict_refuses(self):
        r = self._run(manifest([(A, "azurerm_virtual_network"), (B, "azurerm_storage_account")]), mapping([A]), "--strict")
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE COVERAGE_GAP", r.stderr)

    def test_case_insensitive_match(self):
        # ARG and aztfexport can disagree on ARM-id segment casing; that must not read as a gap
        r = self._run(manifest([(A.upper(), "azurerm_virtual_network")]), mapping([A.lower()]))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no silent gaps", r.stdout)


if __name__ == "__main__":
    unittest.main()
