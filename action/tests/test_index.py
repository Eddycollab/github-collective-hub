import json
import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS  # noqa: F401
import index
import taxonomy
from helpers import write_entry


def s(at, sid="x"):
    return {"id": sid, "at": at}


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.lib = Path(tempfile.mkdtemp()) / "library"

    def test_collect_reads_svg_presence_and_last_seen(self):
        write_entry(self.lib, "A/One", 1, [s("2026-10-01T00:00:00+00:00"), s("2026-10-05T00:00:00+08:00", "y")], svg=True)
        write_entry(self.lib, "B/Two", 2)
        got = {e["repo"]: e for e in index.collect(self.lib)}
        self.assertEqual(got["A/One"]["svg"], "library/a__one.svg")
        self.assertEqual(got["A/One"]["md"], "library/a__one.md")
        self.assertEqual(got["A/One"]["last_seen"], "2026-10-05T00:00:00+08:00")
        self.assertEqual(got["A/One"]["sightings_n"], 2)
        self.assertNotIn("svg", got["B/Two"])
        self.assertEqual(got["B/Two"]["last_seen"], "2026-10-01T00:00:00+00:00")

    def test_collect_skips_invalid_frontmatter(self):
        self.lib.mkdir(parents=True)
        (self.lib / "junk.md").write_text("---\nrepo: '](http://e)'\nrepo_id: x\n---\nhi\n", encoding="utf-8")
        write_entry(self.lib, "A/One", 1)
        self.assertEqual([e["repo"] for e in index.collect(self.lib)], ["A/One"])

    def test_readme_groups_by_taxonomy_order_and_skips_empty(self):
        write_entry(self.lib, "A/One", 1, category="frontend")
        write_entry(self.lib, "B/Two", 2, category="mcp-server")
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        self.assertIn("2 筆收藏 · 2 個 GitHub 專案 · 0 個 Skill · 更新 2026-10-18", text)
        self.assertLess(text.index("### mcp-server"), text.index("### frontend"))
        self.assertNotIn("### dev-tool", text)

    def test_readme_newest_first_within_category(self):
        write_entry(self.lib, "A/Old", 1, [s("2026-10-01T00:00:00+00:00")])
        write_entry(self.lib, "B/New", 2, [s("2026-10-09T00:00:00+00:00")])
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        section = text.split("### dev-tool", 1)[1]
        self.assertLess(section.index("B/New"), section.index("A/Old"))
        recent = text.split("## 最近收藏", 1)[1].split("## 分類", 1)[0]
        self.assertLess(recent.index("B/New"), recent.index("A/Old"))

    def test_readme_truncates_description(self):
        write_entry(self.lib, "A/One", 1, description="字" * 300)
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        line = next(l for l in text.splitlines() if "A/One" in l and "⭐" in l)
        self.assertIn("字" * 160 + "…", line)
        self.assertNotIn("字" * 161, line)

    def test_readme_stars_are_dated_snapshots_never_made_up(self):
        write_entry(self.lib, "A/One", 1)
        write_entry(self.lib, "B/Two", 2, stargazers_count=None)
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        one = next(l for l in text.splitlines() if "A/One" in l)
        two = next(l for l in text.splitlines() if "B/Two" in l)
        self.assertIn("⭐ 3（2026-10-01 快照）", one)
        self.assertNotIn("⭐", two)

    def test_readme_escapes_hostile_description(self):
        write_entry(self.lib, "A/One", 1, description="[x](http://e) <img src=x>")
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        self.assertNotIn("](http://e)", text)
        self.assertNotIn("<img", text)

    def test_readme_unknown_category_goes_to_uncategorized(self):
        write_entry(self.lib, "A/One", 1, category="dev-tool")
        cats = [{"name": "alpha", "definition": "a"}]
        text = index.render_readme(index.collect(self.lib), cats, today="2026-10-18")
        self.assertIn("### 未分類", text)

    def test_index_json_sorted_by_last_seen(self):
        write_entry(self.lib, "A/Old", 1, [s("2026-10-01T00:00:00+00:00")])
        write_entry(self.lib, "B/New", 2, [s("2026-10-09T00:00:00+00:00")])
        data = json.loads(index.render_index(index.collect(self.lib)))
        self.assertEqual(data["count"], 2)
        self.assertEqual([e["repo"] for e in data["entries"]], ["B/New", "A/Old"])
        self.assertIn("generated_at", data)

    def test_readme_defuses_bare_url_in_description(self):
        write_entry(self.lib, "A/One", 1, description="Docs at https://evil.example/x")
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        self.assertIn("`https://evil.example/x`", text)

    def test_readme_survives_hand_edited_frontmatter(self):
        p = write_entry(self.lib, "A/One", 1)
        p.write_text(p.read_text(encoding="utf-8").replace("stars: 3", "stars: lots").replace("tags:", "tags: oops\nold_tags:"), encoding="utf-8")
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-18")
        self.assertIn("A/One", text)

    def test_index_entries_include_intro(self):
        write_entry(self.lib, "A/One", 1)
        data = json.loads(index.render_index(index.collect(self.lib)))
        self.assertTrue(data["entries"][0]["intro"])

    def test_index_entries_include_tagline_and_requirements(self):
        write_entry(self.lib, "A/One", 1)
        e = json.loads(index.render_index(index.collect(self.lib)))["entries"][0]
        self.assertTrue(e["tagline"])
        self.assertTrue(e["requirements"])


class IndexV2Test(unittest.TestCase):
    def setUp(self):
        self.lib = Path(tempfile.mkdtemp()) / "library"

    def write_skill(self, path, sightings=()):
        import entry
        import target
        from helpers import SKILL_ANALYSIS, meta
        self.lib.mkdir(parents=True, exist_ok=True)
        ident = {"item_type": "skill", "path": path, "ref": "main",
                 "resolved": {"ref": "main", "commit_sha": "b" * 40, "default_branch": "main"},
                 "skill": {"name": path.rsplit("/", 1)[-1], "description": None, "license": None, "path": path,
                           "url": "https://github.com/Owner/Repo/blob/x/SKILL.md"}}
        fm = entry.build_frontmatter(meta(), SKILL_ANALYSIS, list(sightings), None,
                                     {"version": "skill-v1", "status": "succeeded"}, now="2026-10-02T00:00:00+00:00",
                                     ident=ident)
        p = self.lib / f"{target.stem('skill', 'Owner/Repo', path)}.md"
        entry.write_entry_files(p, fm, entry.render_entry(fm, SKILL_ANALYSIS, None, None))
        return p

    def test_index_v2_shape_and_skills(self):
        write_entry(self.lib, "Owner/Repo", 1, [{"id": "a", "at": "2026-10-01T00:00:00+00:00", "source": "threads",
                                                 "tags": ["程式類"]}])
        self.write_skill("skills/pdf", [{"id": "b", "at": "2026-10-03T00:00:00+00:00", "source": "voice"}])
        self.write_skill("skills/docx")
        data = json.loads(index.render_index(index.collect(self.lib), taxonomy.DEFAULT, [{"name": "程式類", "definition": ""}]))
        self.assertEqual((data["schema_version"], data["count"]), (2, 3))
        self.assertEqual(data["tag_vocabulary"][0]["name"], "程式類")
        self.assertTrue(any(c["name"] == "agent-skill" for c in data["categories"]))
        by = {e["key"]: e for e in data["entries"]}
        self.assertEqual(set(by), {"repository:owner/repo", "skill:owner/repo:skills/pdf", "skill:owner/repo:skills/docx"})
        pdf = by["skill:owner/repo:skills/pdf"]
        self.assertEqual((pdf["item_type"], pdf["skill_name"], pdf["skill_path"], pdf["ref"], pdf["commit_sha"]),
                         ("skill", "pdf", "skills/pdf", "main", "b" * 40))
        self.assertEqual((pdf["sources"], pdf["analysis_version"], pdf["id"]), (["voice"], "skill-v1", pdf["md"][8:-3]))
        repo = by["repository:owner/repo"]
        self.assertEqual((repo["capture_tags"], repo["sources"], repo["skill_name"]), (["程式類"], ["threads"], None))
        self.assertEqual(repo["first_seen"], "2026-10-01T00:00:00+00:00")

    def test_readme_lists_skills_and_counts(self):
        write_entry(self.lib, "Owner/Repo", 1)
        p = self.write_skill("skills/pdf")
        text = index.render_readme(index.collect(self.lib), taxonomy.DEFAULT, today="2026-10-24")
        self.assertTrue(text.splitlines()[2].startswith("2 筆收藏 · 1 個 GitHub 專案 · 1 個 Skill"))
        self.assertIn("## Skills", text)
        self.assertIn(f"](library/{p.name}) · Skill", text)
        self.assertTrue(all(l.startswith("- [") for l in text.splitlines() if "](library/" in l))

    def test_legacy_entry_gets_legacy_analysis_version(self):
        self.lib.mkdir(parents=True)
        import entry
        (self.lib / "a__one.md").write_text("---\nrepo: A/One\nrepo_id: 1\nanalyzed_at: '2026-10-01T00:00:00+00:00'\n---\n"
                                           + entry.START + "\nx\n" + entry.END + "\n", encoding="utf-8")
        [e] = index.collect(self.lib)
        self.assertEqual((e["item_type"], e["key"], e["analysis_version"]), ("repository", "repository:a/one", "repository-v1"))


if __name__ == "__main__":
    unittest.main()
