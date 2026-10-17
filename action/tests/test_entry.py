import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS  # noqa: F401
import entry

META = {
    "id": 42, "full_name": "Owner/Repo", "html_url": "https://github.com/Owner/Repo",
    "description": "A <b>tool</b>", "language": "Python", "stargazers_count": 7, "license": None,
}
ANALYSIS = {
    "summary": "這是一個工具，用來測試條目產生是否正確。", "category": "dev-tool", "tags": ["cli"],
    "stack": ["Python", "C#"], "highlights": ["第一個值得借鏡的地方。", "第二個值得借鏡的地方。"],
}
RUN = {"model": "claude-opus-5-5", "turns": 3, "wall_s": 60, "rounds": 0, "deepwiki": False, "diagram": True}
END_ENCODINGS = [
    "<!-- repobox:auto:end -->",
    "&lt;!-- repobox:auto:end --&gt;",
    "&amp;lt;!-- repobox:auto:end --&amp;gt;",
    "<!-- REPOBOX:AUTO:END -->",
]


def write(path, fm, analysis=ANALYSIS, svg="owner__repo.svg", user=None, auto=None):
    path.write_text(entry.render_entry(fm, analysis, svg, user, auto=auto), encoding="utf-8")


class EntryTest(unittest.TestCase):
    def setUp(self):
        self.lib = Path(tempfile.mkdtemp())
        self.fm = entry.build_frontmatter(META, ANALYSIS, [], None, RUN, now="2026-10-18T00:00:00+00:00")

    def test_slug(self):
        self.assertEqual(entry.slug("Owner/My.Repo"), "owner__my.repo")

    def test_to_plain_kills_marker_in_four_encodings(self):
        for raw in END_ENCODINGS:
            with self.subTest(raw=raw):
                out = entry.to_plain(f"前 {raw} 後")
                self.assertNotIn("<", out)
                self.assertNotIn("<!--", out)

    def test_to_plain_folds_whitespace_and_strips_tags(self):
        self.assertEqual(entry.to_plain(" a <b>bold</b>\n\n c "), "a bold c")

    def test_md_escape_neutralizes_link_and_image(self):
        out = entry.md_escape("[x](http://e) ![](http://e)")
        for ch in "[]()!":
            for i, c in enumerate(out):
                if c == ch:
                    self.assertEqual(out[i - 1], "\\", f"{ch} at {i} in {out!r}")

    def test_render_has_exactly_one_start_and_end(self):
        hostile = dict(ANALYSIS, summary="摘要內容藏了 <!-- repobox:auto:end --> 還有 <!-- repobox:auto:start --> 標記")
        text = entry.render_entry(self.fm, hostile, "owner__repo.svg", None)
        self.assertEqual(text.count(entry.START), 1)
        self.assertEqual(text.count(entry.END), 1)
        self.assertLess(text.index(entry.START), text.index(entry.END))

    def test_render_raises_if_markers_duplicated(self):
        with self.assertRaises(ValueError):
            entry.render_entry(self.fm, ANALYSIS, None, "\n" + entry.START + "\n")

    def test_render_without_svg_has_no_image_line(self):
        text = entry.render_entry(self.fm, ANALYSIS, None, None)
        self.assertNotIn("![architecture]", text)
        self.assertNotIn("## 架構圖", text)

    def test_render_escapes_model_text(self):
        hostile = dict(ANALYSIS, highlights=["看這裡 [點我](http://evil.example) 很好。", "第二點 ![](http://evil.example/t.png) 也好。"])
        text = entry.render_entry(self.fm, hostile, None, None)
        self.assertNotIn("](http", text)
        self.assertIn("C\\#", text)

    def test_user_section_preserved_bytewise(self):
        p = self.lib / "owner__repo.md"
        user = "\n## 我的筆記\n- 我的字\n\n  trailing  \n"
        write(p, self.fm, user=user)
        fm, got = entry.read_entry(p)
        self.assertEqual(got, user)
        self.assertEqual(fm["repo_id"], 42)
        write(p, fm, user=got)
        self.assertEqual(entry.read_entry(p)[1], user)

    def test_read_entry_splits_at_first_end(self):
        p = self.lib / "x.md"
        p.write_text("---\nrepo_id: 1\n---\n" + entry.START + "\nauto\n" + entry.END + "\nnote " + entry.END + " more\n", encoding="utf-8")
        fm, user = entry.read_entry(p)
        self.assertEqual(user, "\nnote " + entry.END + " more\n")
        self.assertEqual(entry.read_auto(p), "\nauto\n")

    def test_read_entry_without_markers_or_frontmatter(self):
        p = self.lib / "x.md"
        p.write_text("just notes\n", encoding="utf-8")
        self.assertEqual(entry.read_entry(p), ({}, "just notes\n"))

    def test_find_entry_by_repo_id_when_slug_differs(self):
        old = self.lib / "oldowner__oldname.md"
        write(old, self.fm)
        self.assertEqual(entry.find_entry(self.lib, 42, "NewOwner/NewName"), old)

    def test_find_entry_by_slug_fallback(self):
        p = self.lib / "owner__repo.md"
        p.write_text("no frontmatter\n", encoding="utf-8")
        self.assertEqual(entry.find_entry(self.lib, 99, "Owner/Repo"), p)

    def test_find_entry_none(self):
        self.assertIsNone(entry.find_entry(self.lib, 99, "Owner/Repo"))

    def test_frontmatter_key_order_and_license_none(self):
        self.assertEqual(list(self.fm), [
            "repo", "repo_id", "url", "description", "language", "stars", "license", "category",
            "tags", "stack", "sightings", "analyzed_at", "analysis",
        ])
        self.assertIsNone(self.fm["license"])
        self.assertEqual(self.fm["description"], "A tool")
        self.assertEqual(self.fm["analysis"], RUN)
        fm2 = entry.build_frontmatter(dict(META, license={"spdx_id": "MIT"}), ANALYSIS, [], None, RUN)
        self.assertEqual(fm2["license"], "MIT")

    def test_dedup_keeps_prev_analysis_fields(self):
        meta = dict(META, stargazers_count=99, full_name="Owner/Renamed", html_url="https://github.com/Owner/Renamed")
        fm = entry.build_frontmatter(meta, None, [{"id": "a", "at": "2026-10-18T01:00:00+08:00"}], self.fm, None)
        for k in ("category", "tags", "stack", "analyzed_at", "analysis"):
            self.assertEqual(fm[k], self.fm[k])
        self.assertEqual(fm["stars"], 99)
        self.assertEqual(fm["repo"], "Owner/Renamed")

    def test_dedup_render_reuses_auto_block(self):
        p = self.lib / "owner__repo.md"
        write(p, self.fm, user="\n## 我的筆記\nkeep\n")
        auto = entry.read_auto(p)
        fm, user = entry.read_entry(p)
        text = entry.render_entry(fm, None, None, user, auto=auto)
        self.assertEqual(text.split(entry.START, 1)[1], p.read_text(encoding="utf-8").split(entry.START, 1)[1])

    def test_write_sighting_and_merge(self):
        s1 = entry.write_sighting("20261018-1", {"captured_at": "2026-10-18T02:00:00+08:00", "source": "threads", "note": "x" * 900})
        self.assertEqual(s1["id"], "20261018-1")
        self.assertEqual(len(s1["note"]), 500)
        s2 = entry.write_sighting("20261018-2", {"captured_at": "2026-10-18T02:00:00+08:00"})
        legacy = {"at": "2026-10-17T00:00:00+08:00", "source": "x"}
        merged = entry.merge_sightings([legacy, s1], [s1, s2])
        self.assertEqual(merged, [legacy, s1, s2])
        self.assertEqual(entry.merge_sightings(merged, [s1, s2]), merged)

    def test_merge_sightings_orders_by_instant_not_string(self):
        a = {"id": "a", "at": "2026-10-18T00:30:00+00:00"}
        b = {"id": "b", "at": "2026-10-18T07:00:00+08:00"}
        self.assertEqual(entry.merge_sightings([], [a, b]), [b, a])


if __name__ == "__main__":
    unittest.main()
