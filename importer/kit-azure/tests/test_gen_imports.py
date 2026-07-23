"""gen-imports.py — discovery manifest -> imports.tf, tested with in-memory manifests."""
import json
import os
import tempfile
import unittest

from kitpaths import GEN_IMPORTS, run_py

SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers"


def row(tf_type, rid, label, phase=3, stateful=False, disposition="import"):
    return {"type": tf_type, "id": rid, "name": label, "label": label, "service": "s",
            "phase": phase, "stateful": stateful, "providerHint": "azurerm", "disposition": disposition}


def manifest(resources):
    return {"schema": 1, "subscription": "00000000-0000-0000-0000-000000000000",
            "tenant": "11111111-1111-1111-1111-111111111111", "location": "southeastasia",
            "capturedAt": "2026-07-18T00:00:00Z", "resources": resources}


class Gen(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def gen(self, m, *extra):
        mp = os.path.join(self.tmp.name, "m.json")
        json.dump(m, open(mp, "w"))
        out = os.path.join(self.tmp.name, "imports.tf")
        r = run_py(GEN_IMPORTS, ["--manifest", mp, "--out", out, *extra])
        return r, out

    def test_emits_import_blocks(self):
        r, out = self.gen(manifest([row("azurerm_virtual_network", f"{SUB}/Microsoft.Network/virtualNetworks/vnet", "vnet")]))
        self.assertEqual(r.returncode, 0, r.stderr)
        text = open(out).read()
        self.assertIn("import {", text)
        self.assertIn("to = azurerm_virtual_network.vnet", text)
        self.assertIn(f'id = "{SUB}/Microsoft.Network/virtualNetworks/vnet"', text)

    def test_excludes_non_import_disposition(self):
        r, out = self.gen(manifest([
            row("azurerm_virtual_network", f"{SUB}/Microsoft.Network/virtualNetworks/v", "v"),
            row("azurerm_storage_account", f"{SUB}/Microsoft.Storage/storageAccounts/s", "s", phase=5, stateful=True, disposition="ignore"),
        ]))
        self.assertEqual(r.returncode, 0, r.stderr)
        text = open(out).read()
        self.assertIn("azurerm_virtual_network.v", text)
        self.assertNotIn("azurerm_storage_account", text)
        self.assertIn("excluded", r.stdout)

    def test_phase_filter(self):
        r, out = self.gen(manifest([
            row("azurerm_virtual_network", f"{SUB}/Microsoft.Network/virtualNetworks/v", "v", phase=3),
            row("azurerm_storage_account", f"{SUB}/Microsoft.Storage/storageAccounts/s", "s", phase=5, stateful=True),
        ]), "--phase", "5")
        self.assertEqual(r.returncode, 0, r.stderr)
        text = open(out).read()
        self.assertIn("azurerm_storage_account.s", text)
        self.assertNotIn("azurerm_virtual_network", text)

    def test_bad_label_refuses(self):
        r, _ = self.gen(manifest([row("azurerm_virtual_network", f"{SUB}/x/v", "1bad")]))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE BAD_LABEL", r.stderr)

    def test_duplicate_address_refuses(self):
        r, _ = self.gen(manifest([
            row("azurerm_virtual_network", f"{SUB}/x/a", "dup"),
            row("azurerm_virtual_network", f"{SUB}/x/b", "dup"),
        ]))
        self.assertEqual(r.returncode, 2)
        self.assertIn("REFUSE DUPLICATE_ADDRESS", r.stderr)


if __name__ == "__main__":
    unittest.main()
