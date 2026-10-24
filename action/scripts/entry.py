"""Library entries (library/<stem>.md + .json): rendering, parsing, identity lookup, sightings.

The pipeline owns the frontmatter and the text between START and END. Anything a user writes
after the first END is preserved byte for byte; no notes heading is generated any more.
User notes, manual tags, favourites and status live in the front-end owned user.json and are
never written here, so a re-analysis cannot overwrite them.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import yaml

import target

START = "<!-- repobox:auto:start -->"
END = "<!-- repobox:auto:end -->"
USER_DEFAULT = "\n"
# Entries rendered before 2026-10-18 carried an empty notes heading; it is dropped on rewrite.
LEGACY_EMPTY_NOTES = "## 我的筆記"
SCHEMA_VERSION = 2
NOTE_MAX, URL_FIELD_MAX, SHARE_MAX, TRANSCRIPT_MAX = 500, 500, 4000, 8000
CAPTURE_TAGS_MAX, CAPTURE_TAG_LEN, CAPTURE_TAGS_TOTAL = 10, 20, 20
_TAG = re.compile(r"<[^>]*>", re.S)
_MD_SPECIAL = re.compile(r"([\\`*_\[\]()#!|~])")
# GFM autolinks bare URLs and emails even without link syntax; these go into code spans.
_AUTOLINK = re.compile(r"(?:https?://|www\.)\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.I)
# A credential pasted into share text must never reach the library.
_SECRET = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})")
REDACTED = "［已遮蔽的 token］"
_HTTP_URL = re.compile(r"^https?://[^\s<>\"']+$")
# Model output shown to readers. Skill-only keys stay None on repositories and vice versa.
SKILL_KEYS = ("triggers", "inputs", "outputs", "compatible_tools", "dependencies", "permissions", "install")
INFERRED_KEYS = ("suggested_tags", "fit")
READING_KEYS = ("tagline", "intro", "problem", "examples", "requirements", "summary", "highlights", *SKILL_KEYS,
                *INFERRED_KEYS)
# Full record: written to the hidden sidecar library/<stem>.json.
FM_KEYS = ("schema_version", "id", "key", "item_type", "repo", "repo_id", "url", "description", "language", "stars",
           "stars_at", "license", "target", "resolved", "skill", "category", "tags", "stack", *READING_KEYS,
           "sightings", "capture_tags", "created_at", "updated_at", "analyzed_at", "analysis")
# Visible table: GitHub renders every frontmatter key, so only human-facing fields go here.
DISPLAY_KEYS = ("item_type", "repo", "repo_id", "url", "description", "language", "stars", "license", "category", "tags",
                "stack")
SEEN_COUNT, LAST_SEEN = "收藏次數", "最後看到"
CARRIED_ON_DEDUP = ("category", "tags", "stack", "analyzed_at", "analysis", "resolved", "skill", *READING_KEYS)


def slug(full_name: str) -> str:
    return full_name.lower().replace("/", "__")


def to_plain(s: str, keep_lines: bool = False) -> str:
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
    if not keep_lines:
        return " ".join(s.split())
    lines = [" ".join(line.split()) for line in s.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def redact(s: str) -> str:
    return _SECRET.sub(REDACTED, s)


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


def sidecar(md_path: Path) -> Path:
    return Path(md_path).with_suffix(".json")




def upgrade(record: dict, stem: str) -> dict:
    """Fill the v2 identity fields an upstream (v1) record lacks; v1 records were all repositories."""
    rec = dict(record)
    if rec.get("schema_version") == SCHEMA_VERSION:
        return rec
    repo = rec.get("repo") if isinstance(rec.get("repo"), str) else ""
    item_type = rec.get("item_type") if rec.get("item_type") in target.TYPES else "repository"
    rec.update(schema_version=SCHEMA_VERSION, item_type=item_type)
    rec.setdefault("id", stem)
    if repo:
        rec.setdefault("key", target.key(item_type, repo))
        rec.setdefault("target", {"repo": repo, "ref": None, "path": None})
    times = [s.get("at") for s in rec.get("sightings") or [] if isinstance(s, dict) and s.get("at")]
    first = min(times, key=lambda t: _instant({"at": t})) if times else None
    rec.setdefault("created_at", str(rec.get("analyzed_at") or first or "") or None)
    rec.setdefault("updated_at", rec.get("analyzed_at"))
    return rec


def read_record(md_path: Path) -> dict:
    """Frontmatter merged with the sidecar, upgraded to v2; legacy entries kept everything in frontmatter."""
    fm, _ = read_entry(md_path)
    record = dict(fm)
    side = sidecar(md_path)
    if side.exists():
        # A damaged sidecar must stop the write: falling back would overwrite it with a record
        # that has lost its sightings and analysis.
        try:
            data = json.loads(side.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as e:
            raise ValueError(f"{side.name}: unreadable sidecar ({e.__class__.__name__})") from e
        if not isinstance(data, dict):
            raise ValueError(f"{side.name}: sidecar is not an object")
        record.update(data)
    return upgrade(record, Path(md_path).stem)


def write_entry_files(md_path: Path, record: dict, md_text: str) -> None:
    # Sidecar first: legacy entries keep their machine fields in the .md until this succeeds.
    # default=str turns YAML-parsed dates into strings.
    data = json.dumps({k: record.get(k) for k in FM_KEYS}, ensure_ascii=False, indent=2, default=str)
    side = sidecar(md_path)
    previous = side.read_bytes() if side.is_file() else None
    side.write_text(data + "\n", encoding="utf-8")
    try:
        Path(md_path).write_text(md_text, encoding="utf-8")
    except OSError:
        if previous is None:
            side.unlink(missing_ok=True)
        else:
            side.write_bytes(previous)
        raise


def display_frontmatter(record: dict) -> dict:
    disp = {k: record.get(k) for k in DISPLAY_KEYS}
    if disp["item_type"] is None:
        disp["item_type"] = "repository"
    if disp["item_type"] == "skill":
        t, s = record.get("target") or {}, record.get("skill") or {}
        disp = {"item_type": "skill", "skill_name": s.get("name"), "skill_path": t.get("path"), "ref": t.get("ref"),
                **{k: v for k, v in disp.items() if k != "item_type"}}
    if record.get("stars") is not None and record.get("stars_at"):
        disp["stars"] = f"{record['stars']}（{record['stars_at']}）"
    sightings = [s for s in record.get("sightings") or [] if isinstance(s, dict)]
    disp[SEEN_COUNT] = len(sightings)
    if sightings:
        disp[LAST_SEEN] = str(max(sightings, key=_instant).get("at", ""))[:10]
    else:
        disp[LAST_SEEN] = str(record.get("analyzed_at") or "")[:10] or None
    return disp


def find_entry(library: Path, repo_id: int, full_name: str, item_type: str = "repository",
               path: str | None = None) -> Path | None:
    """Identity is (item_type, repo_id, skill path); a renamed repo keeps its old file."""
    for p in sorted(Path(library).glob("*.md")):
        try:
            fm, _ = _split(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if (fm.get("item_type") or "repository") != item_type or fm.get("repo_id") != repo_id:
            continue
        if item_type == "repository" or fm.get("skill_path") == path:
            return p
    candidate = Path(library) / f"{target.stem(item_type, full_name, path)}.md"
    return candidate if candidate.exists() else None


def _plain_list(v) -> list[str]:
    return [to_plain(x) for x in v] if isinstance(v, list) else v


def build_frontmatter(meta: dict, analysis: dict | None, sightings: list[dict], prev: dict | None,
                      run: dict | None, now: str | None = None, ident: dict | None = None) -> dict:
    """ident: {item_type, id, ref, path, resolved, skill} from the trusted publish step; None = repository."""
    lic = meta.get("license")
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    prev, ident = prev or {}, ident or {}
    item_type = ident.get("item_type") or prev.get("item_type") or "repository"
    path = ident.get("path") if item_type == "skill" else None
    prev_target = prev.get("target") if isinstance(prev.get("target"), dict) else {}
    ref = ident.get("ref") if ident.get("ref") is not None else prev_target.get("ref")
    fm = {
        "schema_version": SCHEMA_VERSION,
        "id": prev.get("id") or ident.get("id") or target.stem(item_type, meta["full_name"], path),
        "key": prev.get("key") or target.key(item_type, meta["full_name"], path),
        "item_type": item_type,
        "repo": meta["full_name"],
        "repo_id": meta["id"],
        "url": meta["html_url"],
        "description": to_plain(meta.get("description") or ""),
        "language": meta.get("language"),
        "stars": meta.get("stargazers_count"),
        "stars_at": now[:10] if isinstance(meta.get("stargazers_count"), int) else None,
        "license": lic.get("spdx_id") if isinstance(lic, dict) else None,
        "target": {"repo": meta["full_name"], "ref": ref if item_type == "skill" else None, "path": path},
    }
    if analysis is None:
        carried = {k: prev.get(k) for k in CARRIED_ON_DEDUP}
    else:
        carried = {
            "category": analysis["category"],
            "tags": list(analysis["tags"]),
            "stack": list(analysis["stack"]),
            "analyzed_at": now,
            "analysis": dict(run) if run is not None else None,
            "resolved": ident.get("resolved"),
            "skill": ident.get("skill"),
        }
        for k in READING_KEYS:
            v = analysis.get(k)
            carried[k] = None if v is None else _plain_list(v) if isinstance(v, list) else to_plain(v)
    fm.update(carried)
    fm["sightings"] = list(sightings)
    fm["capture_tags"] = capture_tags(sightings)
    fm["created_at"] = prev.get("created_at") or prev.get("analyzed_at") or now
    fm["updated_at"] = now
    return {k: fm.get(k) for k in FM_KEYS}


def capture_tags(sightings: list) -> list[str]:
    out = []
    for s in sightings:
        for t in (s.get("tags") if isinstance(s, dict) and isinstance(s.get("tags"), list) else []):
            if isinstance(t, str) and t and t not in out:
                out.append(t)
    return out[:CAPTURE_TAGS_TOTAL]


def _bullets(items) -> str:
    return "".join(f"- {safe_text(x)}\n" for x in items or [])


def _skill_block(analysis: dict, fm: dict) -> str:
    s, t, r = fm.get("skill") or {}, fm.get("target") or {}, fm.get("resolved") or {}
    tools = analysis.get("compatible_tools") or []
    lines = [f"- 名稱：{safe_text(s.get('name') or '')}", f"- 路徑：{safe_text(t.get('path') or '（repo 根目錄）')}"]
    if t.get("ref") or r.get("ref"):
        lines.append(f"- 來源 ref：{safe_text(t.get('ref') or r.get('ref'))}")
    if r.get("commit_sha"):
        lines.append(f"- 分析的 commit：{safe_text(r['commit_sha'])}")
    if s.get("license"):
        lines.append(f"- 授權（SKILL.md）：{safe_text(s['license'])}")
    lines.append("- 適用工具：" + ("、".join(safe_text(x) for x in tools) if tools else "未確認（來源沒有明確寫）"))
    out = ["\n## Skill 資訊\n\n> Skill 內容只作為資料收藏，本收藏庫不會執行或安裝它。\n\n" + "\n".join(lines) + "\n"]
    for title, k in (("觸發情境", "triggers"), ("輸入", "inputs"), ("輸出", "outputs"), ("依賴", "dependencies"),
                     ("權限需求", "permissions"), ("安裝說明（轉述來源）", "install")):
        if analysis.get(k):
            out.append(f"\n### {title}\n\n" + _bullets(analysis[k]))
    return "".join(out)


def _auto_block(analysis: dict, svg_name: str | None, fm: dict | None = None) -> str:
    fm = fm or {}
    skill = fm.get("item_type") == "skill"
    parts = [
        "\n> " + safe_text(analysis["tagline"]) + "\n",
        "\n## 這是什麼\n\n" + safe_text(analysis["intro"]) + "\n\n"
        + "".join(f"- **例如**：{safe_text(e)}\n" for e in analysis.get("examples") or []),
    ]
    if analysis.get("problem"):
        parts.append("\n## 解決的問題\n\n" + safe_text(analysis["problem"]) + "\n")
    if skill:
        parts.append(_skill_block(analysis, fm))
    parts += [
        "\n## 使用門檻\n\n" + _bullets(analysis["requirements"]),
        "\n## 技術摘要\n\n" + safe_text(analysis["summary"]) + "\n",
        "\n## 值得借鏡\n\n" + _bullets(analysis["highlights"]),
    ]
    if analysis.get("stack"):
        parts.append("\n## 技術棧\n\n" + " · ".join(safe_text(s) for s in analysis["stack"]) + "\n")
    if analysis.get("fit"):
        parts.append("\n## 適合的應用（推論）\n\n" + _bullets(analysis["fit"]))
    if analysis.get("suggested_tags"):
        parts.append("\n建議標籤（推論，待採用）：" + "、".join(safe_text(x) for x in analysis["suggested_tags"]) + "\n")
    if svg_name:
        title, alt = ("使用流程圖", "flow") if skill else ("架構圖", "architecture")
        parts.append(f"\n## {title}\n\n![{alt}]({svg_name})\n")
    return "".join(parts)


def render_entry(fm: dict, analysis: dict | None, svg_name: str | None, user_section: str | None,
                 auto: str | None = None) -> str:
    if analysis is not None:
        block = _auto_block(analysis, svg_name, fm)
    elif auto is not None:
        block = auto
    else:
        raise ValueError("render_entry needs either analysis or the previous auto block")
    if user_section is not None and user_section.strip() == LEGACY_EMPTY_NOTES:
        user_section = None
    head = "---\n" + yaml.safe_dump(display_frontmatter(fm), allow_unicode=True, sort_keys=False, width=1000) + "---\n"
    text = head + START + block + END + (user_section if user_section is not None else USER_DEFAULT)
    if text.count(START) != 1 or text.count(END) != 1 or text.index(START) > text.index(END):
        raise ValueError("rendered entry must contain exactly one ordered auto marker pair")
    return text


def _capped(v, limit: int, keep_lines: bool = False) -> str:
    return redact(to_plain(v, keep_lines))[:limit] if isinstance(v, str) else ""


def _url_field(v) -> str:
    v = v.strip() if isinstance(v, str) else ""
    return v if len(v) <= URL_FIELD_MAX and _HTTP_URL.match(v) and not _SECRET.search(v) else ""


def write_sighting(item_id: str, capture: dict) -> dict:
    raw_tags = capture.get("tags") if isinstance(capture.get("tags"), list) else []
    tags = []
    for t in raw_tags:
        t = _capped(t, CAPTURE_TAG_LEN)
        if t and t not in tags:
            tags.append(t)
    return {
        "id": item_id,
        "at": capture["captured_at"],
        "source": to_plain(capture.get("source") or ""),
        "note": _capped(capture.get("note"), NOTE_MAX, keep_lines=True),
        "post_url": _url_field(capture.get("post_url")),
        "share_text": _capped(capture.get("share_text"), SHARE_MAX, keep_lines=True),
        "transcript": _capped(capture.get("transcript"), TRANSCRIPT_MAX, keep_lines=True),
        "source_url": _url_field(capture.get("source_url")),
        "tags": tags[:CAPTURE_TAGS_MAX],
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
