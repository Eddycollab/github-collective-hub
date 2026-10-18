"""Library entries (library/<slug>.md): rendering, parsing, lookup by repo_id, sightings.

The pipeline owns the frontmatter and the text between START and END. Anything a user writes
after the first END is preserved byte for byte; no notes heading is generated any more.
"""
from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from pathlib import Path

import yaml

START = "<!-- repobox:auto:start -->"
END = "<!-- repobox:auto:end -->"
USER_DEFAULT = "\n"
# Entries rendered before 2026-10-18 carried an empty notes heading; it is dropped on rewrite.
LEGACY_EMPTY_NOTES = "## 我的筆記"
NOTE_MAX = 500
_TAG = re.compile(r"<[^>]*>", re.S)
_MD_SPECIAL = re.compile(r"([\\`*_\[\]()#!|~])")
# GFM autolinks bare URLs and emails even without link syntax; these go into code spans.
_AUTOLINK = re.compile(r"(?:https?://|www\.)\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.I)
FM_KEYS = ("repo", "repo_id", "url", "description", "language", "stars", "license", "category",
           "tags", "stack", "sightings", "analyzed_at", "analysis")
CARRIED_ON_DEDUP = ("category", "tags", "stack", "analyzed_at", "analysis")


def slug(full_name: str) -> str:
    return full_name.lower().replace("/", "__")


def to_plain(s: str) -> str:
    s = str(s)
    for _ in range(5):
        decoded = html.unescape(s)
        if decoded == s:
            break
        s = decoded
    while True:
        stripped = _TAG.sub("", s)
        if stripped == s:
            break
        s = stripped
    # After this no "<!--" can exist, so model text can never forge a marker.
    s = s.replace("<", "＜").replace(">", "＞")
    return " ".join(s.split())


def md_escape(s: str) -> str:
    return _MD_SPECIAL.sub(r"\\\1", s)


def safe_text(s) -> str:
    plain, out, pos = to_plain(s), [], 0
    for m in _AUTOLINK.finditer(plain):
        out.append(md_escape(plain[pos:m.start()]))
        out.append("`" + m.group(0).replace("`", "") + "`")
        pos = m.end()
    out.append(md_escape(plain[pos:]))
    return "".join(out)


def _split(text: str) -> tuple[dict, str]:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 3)
        if end != -1:
            try:
                fm = yaml.safe_load(text[4:end + 1])
            except yaml.YAMLError:
                fm = None
            return (fm if isinstance(fm, dict) else {}), text[end + 5:]
    return {}, text


def read_entry(path: Path) -> tuple[dict, str]:
    fm, body = _split(Path(path).read_text(encoding="utf-8"))
    if END in body:
        return fm, body.split(END, 1)[1]
    return fm, body


def read_auto(path: Path) -> str | None:
    _, body = _split(Path(path).read_text(encoding="utf-8"))
    if START not in body:
        return None
    after = body.split(START, 1)[1]
    return after.split(END, 1)[0] if END in after else None


def find_entry(library: Path, repo_id: int, full_name: str) -> Path | None:
    for p in sorted(Path(library).glob("*.md")):
        try:
            fm, _ = _split(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if fm.get("repo_id") == repo_id:
            return p
    candidate = Path(library) / f"{slug(full_name)}.md"
    return candidate if candidate.exists() else None


def build_frontmatter(meta: dict, analysis: dict | None, sightings: list[dict], prev: dict | None,
                      run: dict | None, now: str | None = None) -> dict:
    lic = meta.get("license")
    fm = {
        "repo": meta["full_name"],
        "repo_id": meta["id"],
        "url": meta["html_url"],
        "description": to_plain(meta.get("description") or ""),
        "language": meta.get("language"),
        "stars": meta.get("stargazers_count"),
        "license": lic.get("spdx_id") if isinstance(lic, dict) else None,
    }
    if analysis is None:
        prev = prev or {}
        carried = {k: prev.get(k) for k in CARRIED_ON_DEDUP}
    else:
        carried = {
            "category": analysis["category"],
            "tags": list(analysis["tags"]),
            "stack": list(analysis["stack"]),
            "analyzed_at": now or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "analysis": dict(run) if run is not None else None,
        }
    fm.update(carried)
    fm["sightings"] = list(sightings)
    return {k: fm[k] for k in FM_KEYS}


def _auto_block(analysis: dict, svg_name: str | None) -> str:
    parts = [
        "\n## 這是什麼\n\n" + safe_text(analysis["intro"]) + "\n\n"
        + "".join(f"- **例如**：{safe_text(e)}\n" for e in analysis["examples"]),
        "\n## 技術摘要\n\n" + safe_text(analysis["summary"]) + "\n",
        "\n## 值得借鏡\n\n" + "".join(f"- {safe_text(h)}\n" for h in analysis["highlights"]),
        "\n## 技術棧\n\n" + " · ".join(safe_text(s) for s in analysis["stack"]) + "\n",
    ]
    if svg_name:
        parts.append(f"\n## 架構圖\n\n![architecture]({svg_name})\n")
    return "".join(parts)


def render_entry(fm: dict, analysis: dict | None, svg_name: str | None, user_section: str | None,
                 auto: str | None = None) -> str:
    if analysis is not None:
        block = _auto_block(analysis, svg_name)
    elif auto is not None:
        block = auto
    else:
        raise ValueError("render_entry needs either analysis or the previous auto block")
    if user_section is not None and user_section.strip() == LEGACY_EMPTY_NOTES:
        user_section = None
    head = "---\n" + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=1000) + "---\n"
    text = head + START + block + END + (user_section if user_section is not None else USER_DEFAULT)
    if text.count(START) != 1 or text.count(END) != 1 or text.index(START) > text.index(END):
        raise ValueError("rendered entry must contain exactly one ordered auto marker pair")
    return text


def write_sighting(item_id: str, capture: dict) -> dict:
    return {
        "id": item_id,
        "at": capture["captured_at"],
        "source": to_plain(capture.get("source") or ""),
        "note": to_plain(capture.get("note") or "")[:NOTE_MAX],
    }


def merge_sightings(prev: list[dict], new: list[dict]) -> list[dict]:
    seen, out = set(), []
    for s in [*prev, *new]:
        sid = s.get("id") if isinstance(s, dict) else None
        if sid is not None:
            if sid in seen:
                continue
            seen.add(sid)
        out.append(s)
    return sorted(out, key=_instant)


def _instant(s) -> datetime:
    try:
        t = datetime.fromisoformat(str(s.get("at")))
    except (AttributeError, TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
