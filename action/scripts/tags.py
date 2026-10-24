"""Usage-tag vocabulary (簡報類、程式類…): tags.yml with defaults, plus tags the user made up in user.json.

The pipeline only reads user.json (front-end owned); AI suggested_tags must come from this vocabulary.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

NAME_RE = re.compile(r"^[A-Za-z0-9㐀-鿿豈-﫿](?:[A-Za-z0-9㐀-鿿豈-﫿 +.&-]{0,18}[A-Za-z0-9㐀-鿿豈-﫿+.])?$")
VOCAB_MAX = 60

DEFAULT: list[dict] = [
    {"name": "簡報類", "definition": "製作、生成、轉換或展示簡報與投影片"},
    {"name": "程式類", "definition": "寫程式、開發流程、程式碼品質與開發者工具"},
    {"name": "語音類", "definition": "語音辨識、語音合成、錄音與逐字稿"},
    {"name": "AI 工具", "definition": "以 AI 模型為核心的工具、agent 與工作流程"},
    {"name": "設計資源", "definition": "視覺設計、UI、圖示、字型與設計系統"},
    {"name": "教育應用", "definition": "教學、學習、課程與教育平台"},
]


def valid(name) -> bool:
    return isinstance(name, str) and bool(NAME_RE.match(name))


def load(path: Path | None) -> list[dict]:
    if path is None or not Path(path).exists():
        return [dict(t) for t in DEFAULT]
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, UnicodeDecodeError, OSError) as e:
        raise ValueError(f"tags.yml: cannot parse ({e.__class__.__name__})") from e
    raw = data.get("tags") if isinstance(data, dict) else None
    if not isinstance(raw, list) or not raw:
        raise ValueError("tags.yml: 'tags' must be a non-empty list")
    out, seen = [], set()
    for item in raw:
        name = item.get("name") if isinstance(item, dict) else None
        if not valid(name):
            raise ValueError(f"tags.yml: bad tag name {name!r}")
        if name in seen:
            raise ValueError(f"tags.yml: duplicate tag {name!r}")
        seen.add(name)
        out.append({"name": name, "definition": str(item.get("definition") or "")})
    return out


def load_or_default(path: Path | None) -> list[dict]:
    try:
        return load(path)
    except ValueError as e:
        print(f"{e}; using the default tags", file=sys.stderr)
        return load(None)


def user_tags(path: Path | None) -> list[str]:
    """Tag names used in user.json items; anything malformed is ignored, never fatal."""
    if path is None or not Path(path).is_file():
        return []
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return []
    items = data.get("items") if isinstance(data, dict) else None
    out = []
    for it in (items.values() if isinstance(items, dict) else []):
        for t in (it.get("tags") if isinstance(it, dict) and isinstance(it.get("tags"), list) else []):
            if valid(t) and t not in out:
                out.append(t)
    return out


def vocabulary(tags_yml: Path | None, user_json: Path | None = None) -> list[dict]:
    vocab = load_or_default(tags_yml)
    known = {t["name"] for t in vocab}
    vocab += [{"name": t, "definition": ""} for t in user_tags(user_json) if t not in known]
    return vocab[:VOCAB_MAX]


def names(vocab: list[dict]) -> list[str]:
    return [t["name"] for t in vocab]


def write_default(path: Path) -> None:
    Path(path).write_text(yaml.safe_dump({"tags": DEFAULT}, allow_unicode=True, sort_keys=False), encoding="utf-8")


def render_for_prompt(vocab: list[dict]) -> str:
    return "\n".join(f"- {t['name']}" + (f": {t['definition']}" if t["definition"] else "") for t in vocab)
