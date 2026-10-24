import json
import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS  # noqa: F401
import entry
import migrate

LEGACY_FM = ("---\nrepo: Owner/Repo\nrepo_id: 1\nstars: 3\ncategory: dev-tool\ntags: [a]\nstack: [Python]\n"
             "sightings:\n- id: old\n  at: '2026-10-01T00:00:00+08:00'\n  source: threads\n"
             "analyzed_at: '2026-10-01T00:00:00+00:00'\nanalysis:\n  model: m\n---\n")


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.lib = self.root / "library"
        self.lib.mkdir()
        self.md = self.lib / "owner__repo.md"
        self.md.write_text(LEGACY_FM + entry.START + "\n## 技術摘要\n\nx\n" + entry.END + "\n手寫的筆記\n", encoding="utf-8")
        (self.root / "user.json").write_text('{"items": {}}', encoding="utf-8")

    def test_dry_run_changes_nothing(self):
        before = self.md.read_bytes()
        res = migrate.run(self.lib, write=False)
        self.assertEqual(res["outdated"], ["owner__repo.md"])
        self.assertEqual(self.md.read_bytes(), before)
        self.assertFalse((self.lib / "owner__repo.json").exists())

    def test_write_upgrades_and_keeps_text(self):
        res = migrate.run(self.lib, write=True)
        self.assertEqual(res["migrated"], ["owner__repo.md"])
        side = json.loads((self.lib / "owner__repo.json").read_text(encoding="utf-8"))
        self.assertEqual((side["schema_version"], side["key"], side["item_type"], side["id"]),
                         (2, "repository:owner/repo", "repository", "owner__repo"))
        self.assertEqual(side["sightings"][0]["id"], "old")
        self.assertEqual(side["analysis"], {"model": "m"})
        text = self.md.read_text(encoding="utf-8")
        self.assertTrue(text.endswith(entry.END + "\n手寫的筆記\n"))
        self.assertIn("## 技術摘要", text)
        self.assertNotIn("analysis:", text.split(entry.START, 1)[0])
        idx = json.loads((self.root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual((idx["schema_version"], idx["entries"][0]["key"]), (2, "repository:owner/repo"))
        self.assertEqual((self.root / "user.json").read_text(encoding="utf-8"), '{"items": {}}')
        self.assertEqual(migrate.run(self.lib, write=False)["outdated"], [])

    def test_corrupt_sidecar_is_reported_not_overwritten(self):
        (self.lib / "owner__repo.json").write_text("{broken", encoding="utf-8")
        self.assertEqual(migrate.run(self.lib, write=True)["outdated"], [])
        self.assertEqual((self.lib / "owner__repo.json").read_text(encoding="utf-8"), "{broken")


if __name__ == "__main__":
    unittest.main()
