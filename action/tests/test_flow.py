"""Fixture end-to-end run of the pipeline with no network and no Claude.

A temp collection repo is built from library-template/; captures are written the way the front end
writes them; items.collect plans the run; each planned item gets the stage directory the analyze job
would upload (meta/target/status/summary/svg/run, built with the same scripts the workflow calls);
publish.run writes the library. Only GitHub's API answers and Claude's output are fixtures.
"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from _path import FIXTURES, SCRIPTS
import entry
import items
import publish
import target
import validate
from helpers import ANALYSIS, SKILL_ANALYSIS

TEMPLATE = SCRIPTS.parent.parent / "library-template"
SVG_OK = (FIXTURES / "svg_ok.svg").read_text(encoding="utf-8")
SVG_BAD = SVG_OK.replace("</svg>", "<script>alert(1)</script></svg>")
SHA = "89abcdef0123456789abcdef0123456789abcdef"
FAKE_TOKENS = ("ghp_" + "Z" * 36, "github_pat_" + "Y" * 40, "sk-ant-oat01-" + "X" * 40)
RUN = {"result": {"num_turns": 7, "modelUsage": {"claude-opus": {}}}, "tools": {"by_name": {"Read": 3}}}
# What `gh api repos/<owner>/<repo>` would answer.
GITHUB = {
    "owner/repo": {"id": 101, "full_name": "Owner/Repo", "html_url": "https://github.com/Owner/Repo", "private": False,
                   "description": "Repo tool", "language": "Python", "stargazers_count": 12,
                   "license": {"spdx_id": "MIT"}, "default_branch": "main"},
    "anthropics/skills": {"id": 202, "full_name": "anthropics/skills", "html_url": "https://github.com/anthropics/skills",
                          "private": False, "description": "Skills", "language": "Python", "stargazers_count": 5,
                          "license": None, "default_branch": "main"},
    "b/two": {"id": 302, "full_name": "B/Two", "html_url": "https://github.com/B/Two", "private": False,
              "description": "two", "language": "Go", "stargazers_count": 1, "license": None, "default_branch": "main"},
    "c/three": {"id": 303, "full_name": "C/Three", "html_url": "https://github.com/C/Three", "private": False,
                "description": "three", "language": "Rust", "stargazers_count": 1, "license": None,
                "default_branch": "main"},
}


def cap(repo, item_type="repository", path=None, ref=None, at="2026-10-24T10:00:00+08:00", **kw):
    """The capture shape web/app.js writes (docs/collective-plan.md 3.1)."""
    c = {"v": 2, "item_type": item_type, "url": f"https://github.com/{repo}",
         "target": {"repo": repo, "ref": ref, "path": path}, "captured_at": at, "source": "github",
         "post_url": "", "share_text": "", "transcript": "", "note": "", "tags": [], "reanalyze": False,
         "client": "collective@1"}
    c.update(kw)
    return c


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "collection"
        shutil.copytree(TEMPLATE, self.repo)
        self.lib = self.repo / "library"
        self.run_n = 0
        self.behaviour = {}  # repo key -> "fail" | "bad-svg-dropped" | "bad-svg-claimed" | "no-skill-md"

    # --- front end ------------------------------------------------------------

    def capture(self, iid, c):
        # Contents API PUT creates a new file; a different id never overwrites another capture.
        p = self.repo / "inbox" / f"{iid}.json"
        self.assertFalse(p.exists(), "front end ids must be unique")
        p.write_text(json.dumps(c, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # --- analyze job (fixtures stand in for gh api and Claude) -----------------

    def analyze(self, item, art):
        d = art / f"repobox-out-{item['id']}"
        d.mkdir(parents=True)
        (d / "item.json").write_text(json.dumps(item), encoding="utf-8")
        status = {"status": "failed", "error": None, "entry": None, "repo_id": None, "diagram": False, "rounds": 0,
                  "wall_s": 0, "claude_exit": None}
        if item.get("error"):
            status["error"] = item["error"]
            return self._status(d, status)
        meta = GITHUB.get(item["repo"].lower())
        how = self.behaviour.get(item["repo"].lower() + ":" + (item["path"] or ""))
        if meta is None:
            status["error"] = "resolve: HTTP 404: Not Found"
            return self._status(d, status)
        (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        if item["item_type"] == "skill":
            if how == "no-skill-md":
                status["error"] = f"resolve: {item['path']}/SKILL.md not found at main ({SHA})"
                return self._status(d, status)
            md = f"---\nname: {item['path'].rsplit('/', 1)[-1]}\ndescription: test skill\n---\n"
            rec = target.stage_record(meta, "skill", item["ref"] or meta["default_branch"], SHA, item["path"], md)
        else:
            rec = target.stage_record(meta, "repository")
        (d / "target.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        found = entry.find_entry(self.lib, meta["id"], meta["full_name"], item["item_type"], item["path"])
        status.update(repo_id=meta["id"], entry=found.relative_to(self.repo).as_posix() if found else None)
        if found and not item["force"]:
            status["status"] = "dedup"
            return self._status(d, status)
        if how == "fail":
            status["error"] = "summary: claude exited without a valid summary"
            return self._status(d, status)
        summary = SKILL_ANALYSIS if item["item_type"] == "skill" else ANALYSIS
        (d / "summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
        (d / "run.json").write_text(json.dumps(RUN), encoding="utf-8")
        svg = SVG_BAD if how in ("bad-svg-dropped", "bad-svg-claimed") else SVG_OK
        # The workflow's Verify step: a diagram that fails the allowlist is left out, the rest is kept.
        keep = how == "bad-svg-claimed" or not validate.validate_svg(svg)
        if keep:
            (d / "diagram.svg").write_text(svg, encoding="utf-8")
        status.update(status="ok", diagram=keep, claude_exit=0, wall_s=120)
        return self._status(d, status)

    def _status(self, d, status):
        (d / "status.json").write_text(json.dumps(status), encoding="utf-8")

    def pipeline(self, now="2026-10-24T03:00:00+00:00", dispatch=None):
        self.run_n += 1
        art = self.tmp / f"artifacts-{self.run_n}"
        art.mkdir()
        planned = items.collect(self.repo / "inbox", *(dispatch or ("", str(self.run_n))))
        for it in planned:
            self.analyze(it, art)
        counts = publish.run(art, self.repo, now=now, items=planned)
        return counts, json.loads((self.repo / "index.json").read_text(encoding="utf-8"))

    def by_key(self, idx):
        return {e["key"]: e for e in idx["entries"]}

    # --- acceptance cases ----------------------------------------------------

    def test_repo_url_lands_in_index_with_searchable_tags(self):
        self.capture("20261024-100000-aaaaaaaa", cap("Owner/Repo", tags=["程式類", "AI 工具"], note="朋友推薦"))
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["failed"]), (1, 0))
        e = self.by_key(idx)["repository:owner/repo"]
        self.assertEqual(e["capture_tags"], ["程式類", "AI 工具"])
        self.assertEqual(e["suggested_tags"], ANALYSIS["suggested_tags"])
        self.assertEqual((e["svg"], e["analysis_version"]), (f"library/{e['id']}.svg", "repository-v2"))
        self.assertEqual(idx["schema_version"], 2)
        self.assertEqual([t["name"] for t in idx["tag_vocabulary"]][:6], ["簡報類", "程式類", "語音類", "AI 工具", "設計資源", "教育應用"])
        self.assertTrue((self.repo / "inbox/done/20261024-100000-aaaaaaaa.json").exists())
        self.assertIn("1 筆收藏", (self.repo / "README.md").read_text(encoding="utf-8"))

    def test_same_repo_spelled_differently_is_one_entry(self):
        self.capture("20261024-100000-00000001", cap("Owner/Repo"))
        self.pipeline()
        # .git / trailing slash / tracking params are stripped by the front end; what reaches the
        # pipeline differs at most in case and in a trailing .git, and identity is repo_id anyway.
        self.capture("20261024-100001-00000002", cap("owner/repo", url="https://github.com/owner/repo.git"))
        self.capture("20261024-100002-00000003", {"v": 1, "url": "https://github.com/OWNER/Repo/",
                                                  "captured_at": "2026-10-24T11:00:00+08:00", "source": "threads"})
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["dedup"], counts["failed"]), (0, 1, 0))
        self.assertEqual(idx["count"], 1)
        self.assertEqual(idx["entries"][0]["sightings_n"], 3)

    def test_two_skills_in_one_repo_and_reanalyze_keeps_user_notes(self):
        self.capture("20261024-100000-0000000a", cap("anthropics/skills", "skill", "skills/pdf", "main"))
        self.capture("20261024-100000-0000000b", cap("anthropics/skills", "skill", "skills/docx"))
        counts, idx = self.pipeline()
        self.assertEqual(counts["ok"], 2)
        keys = self.by_key(idx)
        pdf = keys["skill:anthropics/skills:skills/pdf"]
        self.assertIn("skill:anthropics/skills:skills/docx", keys)
        self.assertEqual((pdf["skill_name"], pdf["ref"], pdf["commit_sha"]), ("pdf", "main", SHA))
        user = {"schema_version": 1, "items": {pdf["key"]: {"tags": ["教育應用"], "note": "教材用", "favorite": True,
                                                            "status": "in_use", "updated_at": "2026-10-24T05:00:00+00:00"}}}
        (self.repo / "user.json").write_text(json.dumps(user, ensure_ascii=False, indent=2), encoding="utf-8")
        before = (self.repo / "user.json").read_bytes()
        md_before = (self.lib / f"{pdf['id']}.md").read_text(encoding="utf-8")
        self.capture("20261024-120000-0000000c", cap("anthropics/skills", "skill", "skills/pdf", "main", reanalyze=True))
        counts, idx = self.pipeline(now="2026-10-25T00:00:00+00:00")
        self.assertEqual((counts["ok"], counts["dedup"]), (1, 0))
        self.assertEqual(idx["count"], 2)
        again = self.by_key(idx)[pdf["key"]]
        self.assertEqual((again["id"], again["sightings_n"], again["analyzed_at"]), (pdf["id"], 1, "2026-10-25T00:00:00+00:00"))
        self.assertEqual((self.repo / "user.json").read_bytes(), before)
        self.assertNotEqual((self.lib / f"{pdf['id']}.md").read_text(encoding="utf-8"), md_before)
        # The user's tag joined the suggestion vocabulary without user.json being written.
        self.assertIn("教育應用", [t["name"] for t in idx["tag_vocabulary"]])

    def test_three_urls_one_duplicate_two_new_entries(self):
        self.capture("20261024-090000-00000001", cap("Owner/Repo"))
        self.pipeline()
        share = "看到三個好用的：github.com/Owner/Repo 、github.com/B/Two 、github.com/C/Three"
        for n, repo in enumerate(("B/Two", "C/Three")):
            self.capture(f"20261024-100000-0000001{n}", cap(repo, source="threads", share_text=share,
                                                           post_url="https://www.threads.com/@a/post/1"))
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["dedup"], counts["failed"]), (2, 0, 0))
        self.assertEqual(idx["count"], 3)
        two = json.loads((self.lib / f"{self.by_key(idx)['repository:b/two']['id']}.json").read_text(encoding="utf-8"))
        self.assertEqual((two["sightings"][0]["share_text"], two["sightings"][0]["source"]), (share, "threads"))
        self.assertEqual(self.by_key(idx)["repository:owner/repo"]["sightings_n"], 1)

    def test_failures_are_recoverable(self):
        self.behaviour = {"b/two:": "fail", "c/three:": "bad-svg-dropped", "owner/repo:": "bad-svg-claimed",
                          "anthropics/skills:skills/none": "no-skill-md"}
        self.capture("20261024-100000-00000001", cap("B/Two"))
        self.capture("20261024-100000-00000002", cap("C/Three"))
        self.capture("20261024-100000-00000003", cap("Owner/Repo"))
        self.capture("20261024-100000-00000004", cap("anthropics/skills", "skill", "skills/none"))
        self.capture("20261024-100000-00000005", cap("Ghost/Missing"))
        (self.repo / "inbox" / "20261024-100000-00000006.json").write_text("{not json", encoding="utf-8")
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["failed"]), (1, 5))
        # A diagram that fails the allowlist is dropped; the entry is published without it.
        three = self.by_key(idx)["repository:c/three"]
        self.assertNotIn("svg", three)
        self.assertFalse((self.lib / f"{three['id']}.svg").exists())
        failed = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (self.repo / "inbox/failed").glob("*.json")}
        self.assertIn("summary", failed["20261024-100000-00000001"]["error"])
        self.assertIn("diagram.svg", failed["20261024-100000-00000003"]["error"])
        self.assertIn("SKILL.md", failed["20261024-100000-00000004"]["error"])
        self.assertIn("404", failed["20261024-100000-00000005"]["error"])
        self.assertEqual(failed["20261024-100000-00000006"]["raw"], "{not json")
        self.assertEqual(list((self.repo / "inbox").glob("*.json")), [])
        # Retry = put the stored capture back into inbox/ (what the front end's 重新排入 does).
        self.behaviour = {}
        rec = failed["20261024-100000-00000001"]
        (self.repo / "inbox" / "20261024-100000-00000001.json").write_text(json.dumps(rec["capture"]), encoding="utf-8")
        (self.repo / "inbox/failed/20261024-100000-00000001.json").unlink()
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["failed"]), (1, 0))
        self.assertIn("repository:b/two", self.by_key(idx))

    def test_captures_arriving_together_are_all_kept(self):
        self.capture("20261024-100000-00000001", cap("Owner/Repo", note="手機"))
        self.capture("20261024-100000-00000002", cap("Owner/Repo", note="電腦"))
        self.capture("20261024-100000-00000003", cap("B/Two"))
        counts, idx = self.pipeline()
        self.assertEqual((counts["ok"], counts["failed"]), (2, 0))
        rec = json.loads((self.lib / "owner__repo.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(s["note"] for s in rec["sightings"]), ["手機", "電腦"])
        self.assertEqual(len(list((self.repo / "inbox/done").glob("*.json"))), 3)

    def test_dispatch_reanalysis_of_skill(self):
        self.capture("20261024-100000-0000000a", cap("anthropics/skills", "skill", "skills/pdf"))
        self.pipeline()
        counts, idx = self.pipeline(dispatch=("https://github.com/anthropics/skills", "77", "skills/pdf", ""))
        self.assertEqual(counts["ok"], 1)
        self.assertEqual(idx["count"], 1)
        self.assertEqual(idx["entries"][0]["sightings_n"], 1)

    def test_no_token_reaches_written_files(self):
        os.environ["GH_TOKEN"] = FAKE_TOKENS[0]
        self.addCleanup(os.environ.pop, "GH_TOKEN", None)
        self.capture("20261024-100000-00000001", cap("Owner/Repo", share_text="不小心貼了 " + " ".join(FAKE_TOKENS),
                                                     note=FAKE_TOKENS[1], transcript=FAKE_TOKENS[2],
                                                     source_url="https://github.com/Owner/Repo?t=" + FAKE_TOKENS[0]))
        self.pipeline()
        written = [self.repo / "README.md", self.repo / "index.json", *self.lib.iterdir()]
        for p in written:
            text = p.read_text(encoding="utf-8")
            for tok in FAKE_TOKENS:
                self.assertNotIn(tok, text, p.name)
        rec = json.loads((self.lib / "owner__repo.json").read_text(encoding="utf-8"))
        self.assertIn(entry.REDACTED, rec["sightings"][0]["share_text"])
        self.assertEqual(rec["sightings"][0]["source_url"], "")


if __name__ == "__main__":
    unittest.main()
