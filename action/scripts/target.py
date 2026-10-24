"""Collection identity: item types, canonical targets, keys, stems, and the stage/target.json record.

CLI: target.py lookup --library L --item-type T --repo-id N --full F [--path P]   -> entry path or ""
     target.py stage --meta M --item-type T [--ref R] [--sha S] [--path P] [--skill-md F] --out O

See docs/collective-plan.md section 2 and 3.3. The key never contains the ref: a skill path tracked
on another branch is the same item; the commit an analysis read is recorded in `resolved`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

TYPES = ("repository", "skill")
FULL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$")
URL_RE = re.compile(r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)/?$")
URL_MAX = 200
SEG_RE = re.compile(r"^[A-Za-z0-9._@+ -]+$")
PATH_MAX = 200
REF_RE = re.compile(r"^[A-Za-z0-9._/@+-]{1,200}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SKILL_MD_MAX = 256 * 1024
NAME_MAX, DESC_MAX, LICENSE_MAX = 80, 600, 80


def repo_slug(full: str) -> str:
    return full.lower().replace("/", "__")


def repo_from_url(url) -> str | None:
    if not isinstance(url, str) or len(url) > URL_MAX:
        return None
    m = URL_RE.match(url)
    if not m:
        return None
    repo = m.group(2)[:-4] if m.group(2).lower().endswith(".git") else m.group(2)
    return f"{m.group(1)}/{repo}" if repo else None


def normalize_path(path) -> str:
    """Folder that holds SKILL.md, relative to the repo root; "" is the root."""
    if not isinstance(path, str):
        raise ValueError("skill path must be a string")
    p = path.strip("/")
    if len(p) > PATH_MAX:
        raise ValueError("skill path longer than 200")
    if p == "":
        return ""
    for seg in p.split("/"):
        if seg in ("", ".", "..") or not SEG_RE.match(seg) or seg != seg.strip():
            raise ValueError(f"skill path has a bad segment {seg[:40]!r}")
    return p


def valid_ref(ref) -> bool:
    return (isinstance(ref, str) and bool(REF_RE.match(ref)) and ".." not in ref and "//" not in ref
            and "@{" not in ref and not ref.startswith(("/", "-", ".")) and not ref.endswith(("/", ".", ".lock")))


def key(item_type: str, full: str, path: str | None = None) -> str:
    if item_type == "skill":
        return f"skill:{full.lower()}:{path or ''}"
    return f"repository:{full.lower()}"


def stem(item_type: str, full: str, path: str | None = None) -> str:
    base = repo_slug(full)
    if item_type != "skill":
        return base
    slug = re.sub(r"[^a-z0-9]+", "-", (path or "").lower()).strip("-")[:40].strip("-") or "root"
    return f"{base}--skill--{slug}-{hashlib.sha256(key('skill', full, path).encode()).hexdigest()[:6]}"


def normalize_capture(cap: dict) -> tuple[str, str, str | None, str | None]:
    """(item_type, owner/repo, ref, path) of a v1/v2 capture; ValueError names the first problem."""
    if cap.get("v") not in (1, 2):
        raise ValueError("capture: v must be 1 or 2")
    repo = repo_from_url(cap.get("url"))
    if repo is None:
        raise ValueError("capture: url is not a GitHub repo URL")
    if "reanalyze" in cap and not isinstance(cap["reanalyze"], bool):
        raise ValueError("capture: reanalyze must be true or false")
    if cap["v"] == 1:
        return "repository", repo, None, None
    item_type, t = cap.get("item_type"), cap.get("target")
    if item_type not in TYPES:
        raise ValueError("capture: item_type must be repository or skill")
    if not isinstance(t, dict) or not isinstance(t.get("repo"), str) or t["repo"].lower() != repo.lower():
        raise ValueError("capture: target.repo must match url")
    if item_type == "repository":
        if t.get("path") is not None:
            raise ValueError("capture: a repository target has no path")
        return item_type, repo, None, None
    ref = t.get("ref")
    if ref is not None and not valid_ref(ref):
        raise ValueError("capture: target.ref is not a valid ref name")
    return item_type, repo, ref, normalize_path(t.get("path"))


def _plain(v, limit: int) -> str:
    import entry  # entry imports this module
    return entry.to_plain(v if isinstance(v, str) else "")[:limit]


def parse_skill_md(text: str) -> dict:
    """name/description/license from SKILL.md frontmatter, coerced to short plain text. Never raises."""
    fm = {}
    if len(text.encode("utf-8")) <= SKILL_MD_MAX and text.lstrip("﻿").startswith("---"):
        body = text.lstrip("﻿")
        end = body.find("\n---", 3)
        if end != -1:
            try:
                data = yaml.safe_load(body[3:end])
            except yaml.YAMLError:
                data = None
            fm = data if isinstance(data, dict) else {}
    lic = fm.get("license")
    return {"name": _plain(fm.get("name"), NAME_MAX) or None, "description": _plain(fm.get("description"), DESC_MAX) or None,
            "license": _plain(lic, LICENSE_MAX) or None}


def stage_record(meta: dict, item_type: str, ref=None, sha=None, path=None, skill_md: str | None = None) -> dict:
    rec = {"item_type": item_type, "repo": meta["full_name"], "repo_id": meta["id"],
           "default_branch": meta.get("default_branch"), "ref": None, "commit_sha": None, "path": None, "skill": None}
    if item_type == "skill":
        info = parse_skill_md(skill_md or "")
        info["name"] = info["name"] or (normalize_path(path).rsplit("/", 1)[-1] or meta["full_name"].split("/")[1])[:NAME_MAX]
        rec.update(ref=ref, commit_sha=sha, path=normalize_path(path), skill=info)
    return rec


def verify_stage(data, meta: dict, item_type: str, path: str | None, requested_ref: str | None) -> dict:
    """Re-validate an analyze job's target.json against trusted expectations (capture or dispatch item)."""
    if not isinstance(data, dict) or set(data) != {"item_type", "repo", "repo_id", "default_branch", "ref",
                                                   "commit_sha", "path", "skill"}:
        raise ValueError("target.json has unexpected keys")
    if data["item_type"] != item_type:
        raise ValueError("target.json item_type does not match the capture")
    if data["repo_id"] != meta["id"] or data["repo"] != meta["full_name"]:
        raise ValueError("target.json repo does not match meta")
    db = data["default_branch"]
    if db is not None and not valid_ref(db):
        raise ValueError("target.json default_branch is not a ref")
    if item_type == "repository":
        if any(data[k] is not None for k in ("ref", "commit_sha", "path", "skill")):
            raise ValueError("target.json has skill fields on a repository")
        return data
    if not valid_ref(data["ref"]) or not (isinstance(data["commit_sha"], str) and SHA_RE.match(data["commit_sha"])):
        raise ValueError("target.json ref/commit_sha malformed")
    if not isinstance(data["path"], str) or normalize_path(data["path"]) != data["path"] or data["path"] != path:
        raise ValueError("target.json path does not match the capture")
    if data["ref"] != (requested_ref if requested_ref is not None else db):
        raise ValueError("target.json ref does not match the capture")
    s = data["skill"]
    if not (isinstance(s, dict) and set(s) == {"name", "description", "license"}
            and isinstance(s["name"], str) and 0 < len(s["name"]) <= NAME_MAX
            and all(s[k] is None or (isinstance(s[k], str) and len(s[k]) <= m)
                    for k, m in (("description", DESC_MAX), ("license", LICENSE_MAX)))):
        raise ValueError("target.json skill info malformed")
    import entry
    if any(v is not None and entry.to_plain(v) != v for v in s.values()):
        raise ValueError("target.json skill info is not plain text")
    return data


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    lk = sub.add_parser("lookup")
    lk.add_argument("--library", type=Path, required=True)
    lk.add_argument("--item-type", choices=TYPES, required=True)
    lk.add_argument("--repo-id", type=int, required=True)
    lk.add_argument("--full", required=True)
    lk.add_argument("--path", default="")
    st = sub.add_parser("stage")
    st.add_argument("--meta", type=Path, required=True)
    st.add_argument("--item-type", choices=TYPES, required=True)
    st.add_argument("--ref", default="")
    st.add_argument("--sha", default="")
    st.add_argument("--path", default="")
    st.add_argument("--skill-md", type=Path)
    st.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    if a.cmd == "lookup":
        import entry
        path = normalize_path(a.path) if a.item_type == "skill" else None
        p = entry.find_entry(a.library, a.repo_id, a.full, a.item_type, path)
        print(p.as_posix() if p else "")
        return 0
    meta = json.loads(a.meta.read_text(encoding="utf-8"))
    md = None
    if a.skill_md is not None:
        raw = a.skill_md.read_bytes()
        if len(raw) > SKILL_MD_MAX:
            print("SKILL.md larger than 256 KiB", file=sys.stderr)
            return 1
        md = raw.decode("utf-8", errors="replace")
    try:
        rec = stage_record(meta, a.item_type, a.ref or None, a.sha or None, a.path, md)
        if a.item_type == "skill":
            verify_stage(rec, meta, "skill", rec["path"], rec["ref"])
    except (ValueError, KeyError) as e:
        print(f"stage: {e}", file=sys.stderr)
        return 1
    a.out.write_text(json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
