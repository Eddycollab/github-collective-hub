"""Library index: README.md (human) and index.json (machine, schema v2) generated from library/*.md."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import entry
import target

FULL_RE = target.FULL_RE
STEM_RE = re.compile(r"^[a-z0-9._-]+__[a-z0-9._-]+$")
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,39}$")
DESC_MAX = 160
RECENT_N = 10
UNCATEGORIZED = "未分類"
INDEX_VERSION = 2
# Records written by upstream RepoBox carry no analysis version.
LEGACY_ANALYSIS = "repository-v1"
INDEX_FIELDS = ("schema_version", "key", "item_type", "repo", "repo_id", "url", "description", "tagline", "intro",
                "problem", "requirements", "language", "stars", "stars_at", "license", "category", "tags", "stack",
                "suggested_tags", "capture_tags", "compatible_tools", "analyzed_at", "updated_at")


def _instant(at) -> datetime:
    return entry._instant({"at": at})


def _entry(p: Path, rec: dict) -> dict:
    sightings = [s for s in rec.get("sightings") or [] if isinstance(s, dict)]
    times = [s.get("at") for s in sightings if s.get("at")]
    last_seen = max(times, key=_instant) if times else rec.get("analyzed_at")
    first_seen = min(times, key=_instant) if times else rec.get("created_at") or rec.get("analyzed_at")
    t = rec.get("target") if isinstance(rec.get("target"), dict) else {}
    r = rec.get("resolved") if isinstance(rec.get("resolved"), dict) else {}
    s = rec.get("skill") if isinstance(rec.get("skill"), dict) else {}
    analysis = rec.get("analysis") if isinstance(rec.get("analysis"), dict) else {}
    skill = rec.get("item_type") == "skill"
    sources = []
    for x in sightings:
        if isinstance(x.get("source"), str) and x["source"] and x["source"] not in sources:
            sources.append(x["source"])
    e = {k: rec.get(k) for k in INDEX_FIELDS}
    e.update({
        "id": p.stem,
        "skill_name": s.get("name") if skill else None,
        "skill_path": t.get("path") if skill else None,
        "ref": (t.get("ref") or r.get("ref")) if skill else None,
        "commit_sha": r.get("commit_sha"),
        "sources": sources,
        "first_seen": str(first_seen or ""),
        "last_seen": str(last_seen or ""),
        "analysis_version": analysis.get("version") or (LEGACY_ANALYSIS if rec.get("analyzed_at") else None),
        "sightings_n": len(sightings),
        "md": f"library/{p.name}",
    })
    if (p.parent / f"{p.stem}.svg").exists():
        e["svg"] = f"library/{p.stem}.svg"
    return e


def collect(library: Path) -> list[dict]:
    out = []
    for p in sorted(Path(library).glob("*.md")):
        try:
            rec = entry.read_record(p)
        except (OSError, UnicodeDecodeError, ValueError) as e:
            print(f"index: skipping {p.name}: {e}", file=sys.stderr)
            continue
        repo, rid = rec.get("repo"), rec.get("repo_id")
        if not (isinstance(repo, str) and FULL_RE.match(repo) and isinstance(rid, int) and STEM_RE.match(p.stem)
                and rec.get("item_type") in target.TYPES):
            print(f"index: skipping {p.name}: frontmatter missing a valid repo/repo_id", file=sys.stderr)
            continue
        out.append(_entry(p, rec))
    return out


def _newest_first(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda e: _instant(e["last_seen"]), reverse=True)


def _line(e: dict) -> str:
    desc = entry.to_plain(e.get("description") or "")
    if len(desc) > DESC_MAX:
        desc = desc[:DESC_MAX] + "…"
    # Stars are a snapshot from capture time, so they only appear with their date and never as a made-up 0.
    stars = e["stars"] if isinstance(e.get("stars"), int) and not isinstance(e.get("stars"), bool) else None
    if e.get("item_type") == "skill":
        name = entry.safe_text(e.get("skill_name") or e.get("skill_path") or "skill")
        text = f"- [{e['repo']} · {name}]({e['md']}) · Skill"
        if e.get("skill_path"):
            text += f" · {entry.safe_text(e['skill_path'])}"
        desc = entry.to_plain(e.get("tagline") or "") or desc
    else:
        parts = [f"- [{e['repo']}]({e['md']})"]
        if stars is not None and e.get("stars_at"):
            parts.append(f"⭐ {stars}（{str(e['stars_at'])[:10]} 快照）")
        if e.get("language"):
            parts.append(f"· {entry.safe_text(e['language'])}")
        text = " ".join(parts)
    if desc:
        text += f" — {entry.safe_text(desc)}"
    raw_tags = e.get("tags") if isinstance(e.get("tags"), list) else []
    kw = [t for t in raw_tags if isinstance(t, str) and TAG_RE.match(t)]
    if kw:
        text += " " + " ".join(f"`{t}`" for t in kw)
    return text


def render_readme(entries: list[dict], cats: list[dict], today: str | None = None) -> str:
    """Header starts with "<N> 筆收藏": web/lib/library.mjs readmeWithout() rewrites that count on removal."""
    today = today or datetime.now(timezone.utc).date().isoformat()
    ordered = _newest_first(entries)
    repos = [e for e in ordered if e.get("item_type") != "skill"]
    skills = [e for e in ordered if e.get("item_type") == "skill"]
    lines = ["# GitHub Collective Hub 收藏庫", "",
             f"{len(entries)} 筆收藏 · {len(repos)} 個 GitHub 專案 · {len(skills)} 個 Skill · 更新 {today}", "",
             "## 最近收藏", ""]
    lines += [_line(e) for e in ordered[:RECENT_N]] or ["（還沒有收藏）"]
    if skills:
        lines += ["", "## Skills", "", *(_line(e) for e in skills)]
    lines += ["", "## 分類", ""]
    known = {c["name"] for c in cats}
    groups = [(c["name"], c["definition"]) for c in cats] + [(UNCATEGORIZED, "")]
    for name, definition in groups:
        if name == UNCATEGORIZED:
            members = [e for e in ordered if e.get("category") not in known]
        else:
            members = [e for e in ordered if e.get("category") == name]
        if not members:
            continue
        heading = f"### {name}" + (f" — {entry.safe_text(definition)}" if definition else "")
        lines += [heading, "", *(_line(e) for e in members), ""]
    return "\n".join(lines).rstrip() + "\n"


def render_index(entries: list[dict], cats: list[dict] | None = None, vocab: list[dict] | None = None) -> str:
    data = {
        "schema_version": INDEX_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(entries),
        "categories": list(cats or []),
        "tag_vocabulary": list(vocab or []),
        "entries": _newest_first(entries),
    }
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
