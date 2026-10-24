import json
import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS  # noqa: F401
import tags


class TagsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_defaults_match_the_brief(self):
        self.assertEqual(tags.names(tags.DEFAULT), ["簡報類", "程式類", "語音類", "AI 工具", "設計資源", "教育應用"])
        self.assertTrue(all(t["definition"] for t in tags.DEFAULT))

    def test_load_file_and_roundtrip(self):
        p = self.tmp / "tags.yml"
        tags.write_default(p)
        self.assertEqual(tags.load(p), tags.DEFAULT)
        p.write_text("tags:\n  - name: 客語\n    definition: 客家語\n", encoding="utf-8")
        self.assertEqual(tags.names(tags.load(p)), ["客語"])

    def test_bad_files_fall_back(self):
        p = self.tmp / "tags.yml"
        for text in ("tags: [unterminated\n", "tags: []\n", "tags:\n  - name: '<b>'\n", "tags:\n  - name: a\n  - name: a\n"):
            p.write_text(text, encoding="utf-8")
            with self.assertRaises(ValueError):
                tags.load(p)
            self.assertEqual(tags.load_or_default(p), tags.DEFAULT)

    def test_valid_names(self):
        for ok in ("AI 工具", "程式類", "C++", "R&D"):
            self.assertTrue(tags.valid(ok), ok)
        for bad in ("", " x", "x ", "[x](y)", "<b>", "a" * 21, None, 3, "`x`"):
            self.assertFalse(tags.valid(bad), bad)

    def test_vocabulary_merges_user_tags_read_only(self):
        u = self.tmp / "user.json"
        text = json.dumps({"schema_version": 1, "items": {"k": {"tags": ["程式類", "客語", "<bad>"]}, "j": "x"}},
                          ensure_ascii=False)
        u.write_text(text, encoding="utf-8")
        v = tags.names(tags.vocabulary(None, u))
        self.assertEqual(v[:6], tags.names(tags.DEFAULT))
        self.assertEqual(v[6:], ["客語"])
        self.assertEqual(u.read_text(encoding="utf-8"), text)
        u.write_text("{broken", encoding="utf-8")
        self.assertEqual(tags.vocabulary(None, u), tags.DEFAULT)

    def test_render_for_prompt(self):
        text = tags.render_for_prompt(tags.vocabulary(None) + [{"name": "客語", "definition": ""}])
        self.assertIn("- 簡報類: ", text)
        self.assertIn("\n- 客語", text)


if __name__ == "__main__":
    unittest.main()
