import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS
import items

GOOD = {"v": 1, "url": "https://github.com/a/b", "captured_at": "2026-10-18T10:00:00+08:00"}


class ItemsTest(unittest.TestCase):
    def setUp(self):
        self.inbox = Path(tempfile.mkdtemp()) / "inbox"
        self.inbox.mkdir()

    def put(self, name, content):
        (self.inbox / name).write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    def collect(self, url=""):
        return items.collect(self.inbox, url, "77")

    def test_dispatch_url_single_item_ignores_inbox(self):
        self.put("20261018-1.json", GOOD)
        self.assertEqual(self.collect("https://github.com/x/y"),
                         [{"id": "dispatch-77", "item_type": "repository", "url": "https://github.com/x/y", "repo": "x/y",
                           "ref": None, "path": None, "force": True}])

    def test_inbox_items_sorted(self):
        self.put("20261018-2.json", GOOD)
        self.put("20261018-1.json", dict(GOOD, url="https://github.com/c/d"))
        got = self.collect()
        self.assertEqual([i["id"] for i in got], ["20261018-1", "20261018-2"])
        self.assertEqual(got[0], {"id": "20261018-1", "item_type": "repository", "url": "https://github.com/c/d",
                                  "repo": "c/d", "ref": None, "path": None, "force": False})

    def test_bad_json_yields_error_item(self):
        self.put("bad.json", "{not json")
        [it] = self.collect()
        self.assertEqual(set(it), {"id", "item_type", "url", "repo", "ref", "path", "force", "error"})
        self.assertIsNone(it["url"])
        self.assertTrue(it["error"])

    def test_json_null_and_array_yield_error_items(self):
        self.put("a.json", "null")
        self.put("b.json", "[1]")
        got = self.collect()
        self.assertEqual([i["id"] for i in got], ["a", "b"])
        self.assertTrue(all(i["error"] for i in got))

    def test_missing_url_yields_error_item(self):
        self.put("m.json", {k: v for k, v in GOOD.items() if k != "url"})
        [it] = self.collect()
        self.assertIn("url", it["error"])

    def test_long_url_rejected(self):
        self.put("l.json", dict(GOOD, url="https://github.com/a/" + "b" * 200))
        [it] = self.collect()
        self.assertIn("url", it["error"])

    def test_item_size_independent_of_capture_size(self):
        self.put("big.json", dict(GOOD, note="x" * 1_000_000))
        [it] = self.collect()
        self.assertLess(len(json.dumps(it)), 250)

    def test_items_capped_per_run(self):
        for n in range(items.MAX_ITEMS + 5):
            self.put(f"20261018-{n:04d}.json", GOOD)
        got = self.collect()
        self.assertEqual(len(got), items.MAX_ITEMS)
        self.assertEqual(got[-1]["id"], f"20261018-{items.MAX_ITEMS - 1:04d}")

    def test_gist_url_yields_error_item(self):
        self.put("g.json", dict(GOOD, url="https://gist.github.com/a/b"))
        self.put("u.json", dict(GOOD, url="https://github.com/cholateio"))
        self.assertTrue(all(i.get("error") for i in self.collect()))

    def test_missing_or_bad_captured_at_yields_error_item(self):
        self.put("c1.json", {"v": 1, "url": GOOD["url"]})
        self.put("c2.json", dict(GOOD, captured_at="yesterday"))
        self.put("c3.json", dict(GOOD, captured_at=5))
        got = self.collect()
        self.assertEqual(len(got), 3)
        self.assertTrue(all("captured_at" in i["error"] for i in got))

    def test_wrong_v_yields_error_item(self):
        self.put("v.json", dict(GOOD, v=3))
        [it] = self.collect()
        self.assertIn("v", it["error"])

    def test_unsafe_stem_skipped_not_in_items(self):
        self.put("bad name.json", GOOD)
        self.put("-lead.json", GOOD)
        self.assertEqual(self.collect(), [])

    def test_ignores_done_and_failed_subdirs(self):
        (self.inbox / "done").mkdir()
        (self.inbox / "done" / "x.json").write_text(json.dumps(GOOD))
        self.assertEqual(self.collect(), [])

    def test_cli_prints_one_json_line(self):
        self.put("20261018-1.json", GOOD)
        p = subprocess.run([sys.executable, str(SCRIPTS / "items.py"), "--inbox", str(self.inbox), "--url", "",
                            "--run-id", "5"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(len(p.stdout.strip().splitlines()), 1)
        self.assertEqual(json.loads(p.stdout)[0]["id"], "20261018-1")


SKILL = {"v": 2, "item_type": "skill", "url": "https://github.com/a/b",
         "target": {"repo": "a/b", "ref": "feature/x", "path": "skills/pdf"},
         "captured_at": "2026-10-24T10:00:00+08:00", "source": "threads", "share_text": "看這個"}


class ItemsV2Test(unittest.TestCase):
    setUp, put, collect = ItemsTest.setUp, ItemsTest.put, ItemsTest.collect

    def test_v2_skill_item(self):
        self.put("s.json", SKILL)
        [it] = self.collect()
        self.assertEqual(it, {"id": "s", "item_type": "skill", "url": "https://github.com/a/b", "repo": "a/b",
                              "ref": "feature/x", "path": "skills/pdf", "force": False})

    def test_v2_repository_and_git_suffix_normalized(self):
        self.put("r.json", {"v": 2, "item_type": "repository", "url": "https://github.com/a/b.git",
                            "target": {"repo": "a/b", "ref": None, "path": None}, "captured_at": GOOD["captured_at"]})
        [it] = self.collect()
        self.assertEqual((it["item_type"], it["url"], it["repo"]), ("repository", "https://github.com/a/b", "a/b"))

    def test_reanalyze_sets_force(self):
        self.put("s.json", dict(SKILL, reanalyze=True))
        self.assertTrue(self.collect()[0]["force"])
        self.put("t.json", dict(SKILL, reanalyze="yes"))
        self.assertIn("reanalyze", self.collect()[1]["error"])

    def test_v2_rejects_bad_targets(self):
        bad = [dict(SKILL, item_type="gist"), dict(SKILL, target={"repo": "other/repo", "path": "x"}),
               dict(SKILL, target={"repo": "a/b", "path": "../etc"}), dict(SKILL, target={"repo": "a/b", "path": None}),
               dict(SKILL, target={"repo": "a/b", "ref": "bad..ref", "path": "x"}), dict(SKILL, target=None),
               {**SKILL, "item_type": "repository", "target": {"repo": "a/b", "path": "x"}}]
        for n, cap in enumerate(bad):
            self.put(f"b{n}.json", cap)
        got = self.collect()
        self.assertEqual(len(got), len(bad))
        self.assertTrue(all(i["error"] and i["item_type"] is None for i in got), got)

    def test_root_skill_path_is_empty_string(self):
        self.put("s.json", dict(SKILL, target={"repo": "A/B", "ref": None, "path": ""}))
        [it] = self.collect()
        self.assertEqual((it["path"], it["ref"]), ("", None))

    def test_dispatch_skill(self):
        [it] = items.collect(self.inbox, "https://github.com/x/y", "9", skill_path="skills/a/", ref="main")
        self.assertEqual((it["item_type"], it["path"], it["ref"], it["force"]), ("skill", "skills/a", "main", True))
        [root] = items.collect(self.inbox, "https://github.com/x/y", "9", skill_path="/")
        self.assertEqual((root["path"], root["ref"]), ("", None))
        [bad] = items.collect(self.inbox, "https://github.com/x/y", "9", skill_path="a/../b")
        self.assertTrue(bad["error"])
        [bad_url] = items.collect(self.inbox, "https://evil.example/x/y", "9")
        self.assertTrue(bad_url["error"])


if __name__ == "__main__":
    unittest.main()
