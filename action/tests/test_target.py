import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _path import SCRIPTS
import target
from helpers import meta, write_entry

SHA = "0123456789abcdef0123456789abcdef01234567"


class TargetTest(unittest.TestCase):
    def test_keys_ignore_ref_and_lowercase_repo_only(self):
        self.assertEqual(target.key("repository", "Owner/Repo"), "repository:owner/repo")
        self.assertEqual(target.key("skill", "Owner/Repo", "Skills/PDF"), "skill:owner/repo:Skills/PDF")
        self.assertEqual(target.key("skill", "Owner/Repo", ""), "skill:owner/repo:")

    def test_stems(self):
        self.assertEqual(target.stem("repository", "Owner/My.Repo"), "owner__my.repo")
        a = target.stem("skill", "Owner/Repo", "skills/pdf")
        b = target.stem("skill", "Owner/Repo", "skills/docx")
        self.assertRegex(a, r"^owner__repo--skill--skills-pdf-[0-9a-f]{6}$")
        self.assertNotEqual(a, b)
        self.assertEqual(a, target.stem("skill", "OWNER/repo", "skills/pdf"))
        self.assertRegex(target.stem("skill", "o/r", ""), r"^o__r--skill--root-[0-9a-f]{6}$")
        self.assertLessEqual(len(target.stem("skill", "o/r", "a" * 190)), 80)

    def test_normalize_path(self):
        self.assertEqual(target.normalize_path("/skills/pdf/"), "skills/pdf")
        self.assertEqual(target.normalize_path(""), "")
        self.assertEqual(target.normalize_path("my skills/v1.2@x"), "my skills/v1.2@x")
        for bad in ("a/../b", "a//b", "./a", "a\\b", "a/<b>", None, 3, "a" * 201, "a/ b"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                target.normalize_path(bad)

    def test_valid_ref(self):
        for ok in ("main", "feature/x/y", "v1.2.3", SHA, "release@2026"):
            self.assertTrue(target.valid_ref(ok), ok)
        for bad in ("", "-x", "/x", "x/", "a..b", "a//b", "x.lock", "a@{1}", "a b", "a~1", None, "x" * 201):
            self.assertFalse(target.valid_ref(bad), bad)

    def test_repo_from_url(self):
        self.assertEqual(target.repo_from_url("https://github.com/a/b.git"), "a/b")
        self.assertEqual(target.repo_from_url("https://github.com/a/b/"), "a/b")
        self.assertIsNone(target.repo_from_url("https://github.com/a/.git"))
        self.assertIsNone(target.repo_from_url("http://github.com/a/b"))
        self.assertIsNone(target.repo_from_url("https://github.com/a/b/tree/main"))

    def test_parse_skill_md(self):
        md = "---\nname: pdf\ndescription: <b>Read</b> PDFs\nlicense: Apache-2.0\n---\n# body\n"
        self.assertEqual(target.parse_skill_md(md), {"name": "pdf", "description": "Read PDFs", "license": "Apache-2.0"})
        self.assertEqual(target.parse_skill_md("no frontmatter"), {"name": None, "description": None, "license": None})
        self.assertEqual(target.parse_skill_md("---\n: [bad\n---\n")["name"], None)
        self.assertEqual(target.parse_skill_md("---\n- a list\n---\n")["name"], None)
        self.assertEqual(len(target.parse_skill_md("---\nname: " + "n" * 500 + "\n---\n")["name"]), target.NAME_MAX)
        self.assertIsNone(target.parse_skill_md("---\nname: x\n---\n" + "x" * (target.SKILL_MD_MAX + 1))["name"])

    def test_stage_and_verify_roundtrip(self):
        m = meta(default_branch="main")
        rec = target.stage_record(m, "skill", "main", SHA, "skills/pdf", "---\nname: pdf\n---\n")
        self.assertEqual(target.verify_stage(rec, m, "skill", "skills/pdf", None), rec)
        self.assertEqual(target.verify_stage(rec, m, "skill", "skills/pdf", "main"), rec)
        repo = target.stage_record(m, "repository")
        self.assertEqual(target.verify_stage(repo, m, "repository", None, None), repo)

    def test_stage_name_falls_back_to_folder(self):
        rec = target.stage_record(meta(default_branch="main"), "skill", "main", SHA, "skills/pdf", "")
        self.assertEqual(rec["skill"]["name"], "pdf")

    def test_verify_rejects_tampering(self):
        m = meta(default_branch="main")
        good = target.stage_record(m, "skill", "main", SHA, "skills/pdf", "---\nname: pdf\n---\n")
        cases = [
            ("type", dict(good, item_type="repository"), "skill", "skills/pdf", None),
            ("path", good, "skill", "skills/other", None),
            ("ref", good, "skill", "skills/pdf", "dev"),
            ("sha", dict(good, commit_sha="abc"), "skill", "skills/pdf", None),
            ("repo_id", dict(good, repo_id=99), "skill", "skills/pdf", None),
            ("extra", dict(good, evil=1), "skill", "skills/pdf", None),
            ("markup", dict(good, skill={"name": "<b>x</b>", "description": None, "license": None}), "skill", "skills/pdf", None),
            ("dotdot", dict(good, path="../x"), "skill", "../x", None),
            ("repo-with-skill", dict(target.stage_record(m, "repository"), path="x"), "repository", None, None),
        ]
        for label, data, it, path, ref in cases:
            with self.subTest(label), self.assertRaises(ValueError):
                target.verify_stage(data, m, it, path, ref)

    def test_normalize_capture(self):
        v1 = {"v": 1, "url": "https://github.com/a/b"}
        self.assertEqual(target.normalize_capture(v1), ("repository", "a/b", None, None))
        v2 = {"v": 2, "item_type": "skill", "url": "https://github.com/a/b", "target": {"repo": "A/B", "ref": None, "path": "/x/"}}
        self.assertEqual(target.normalize_capture(v2), ("skill", "a/b", None, "x"))


class TargetCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / "target.py"), *args], capture_output=True, text=True,
                              encoding="utf-8")

    def test_lookup(self):
        lib = self.tmp / "library"
        p = write_entry(lib, "Owner/Repo", 7)
        out = self.run_cli("lookup", "--library", str(lib), "--item-type", "repository", "--repo-id", "7", "--full", "X/Y")
        self.assertEqual(out.stdout.strip(), p.as_posix())
        out = self.run_cli("lookup", "--library", str(lib), "--item-type", "skill", "--repo-id", "7", "--full", "Owner/Repo",
                           "--path", "skills/pdf")
        self.assertEqual((out.returncode, out.stdout.strip()), (0, ""))

    def test_stage(self):
        (self.tmp / "meta.json").write_text(json.dumps(meta(default_branch="main")), encoding="utf-8")
        (self.tmp / "SKILL.md").write_text("---\nname: pdf\ndescription: 讀 PDF\n---\n", encoding="utf-8")
        out = self.run_cli("stage", "--meta", str(self.tmp / "meta.json"), "--item-type", "skill", "--ref", "feature/x",
                           "--sha", SHA, "--path", "skills/pdf", "--skill-md", str(self.tmp / "SKILL.md"),
                           "--out", str(self.tmp / "target.json"))
        self.assertEqual(out.returncode, 0, out.stderr)
        rec = json.loads((self.tmp / "target.json").read_text(encoding="utf-8"))
        self.assertEqual((rec["ref"], rec["commit_sha"], rec["path"], rec["skill"]["description"]),
                         ("feature/x", SHA, "skills/pdf", "讀 PDF"))
        bad = self.run_cli("stage", "--meta", str(self.tmp / "meta.json"), "--item-type", "skill", "--ref", "main",
                           "--sha", "nothex", "--path", "x", "--out", str(self.tmp / "t2.json"))
        self.assertEqual(bad.returncode, 1)
        self.assertFalse((self.tmp / "t2.json").exists())


if __name__ == "__main__":
    unittest.main()
