"""List the work items for one run: either the single dispatch target, or every inbox/*.json.

CLI: items.py --inbox inbox --url "<dispatch url or empty>" [--skill-path P] [--ref R] --run-id N  -> one JSON line
Matrix item: {id, item_type, url, repo, ref, path, force}; malformed captures carry "error" instead.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import target

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
URL_RE = target.URL_RE
URL_MAX = target.URL_MAX
# GitHub caps a matrix at 256 jobs; the rest waits for the next run (any push or an empty dispatch).
MAX_ITEMS = 200


def _error(stem: str, msg: str) -> dict:
    return {"id": stem, "item_type": None, "url": None, "repo": None, "ref": None, "path": None, "force": False,
            "error": msg}


def _check_capture(cap: dict) -> tuple[str, str, str | None, str | None]:
    ident = target.normalize_capture(cap)
    at = cap.get("captured_at")
    if not isinstance(at, str):
        raise ValueError("capture: captured_at missing")
    try:
        datetime.fromisoformat(at)
    except ValueError:
        raise ValueError("capture: captured_at is not ISO 8601") from None
    return ident


def _item(path: Path) -> dict:
    """Matrix items carry only identity: publish re-reads the capture from the repo."""
    stem = path.stem
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except ValueError:
        return _error(stem, "capture: not valid JSON")
    if not isinstance(data, dict):
        return _error(stem, "capture: not a JSON object")
    try:
        item_type, repo, ref, sub = _check_capture(data)
    except ValueError as e:
        return _error(stem, str(e))
    return {"id": stem, "item_type": item_type, "url": f"https://github.com/{repo}", "repo": repo, "ref": ref,
            "path": sub, "force": data.get("reanalyze") is True}


def dispatch_item(url: str, run_id: str, skill_path: str = "", ref: str = "") -> dict:
    iid = f"dispatch-{run_id}"
    repo = target.repo_from_url(url.rstrip("/") if url else url)
    if repo is None:
        return _error(iid, "dispatch: url is not a GitHub repo URL")
    if not skill_path:
        return {"id": iid, "item_type": "repository", "url": f"https://github.com/{repo}", "repo": repo, "ref": None,
                "path": None, "force": True}
    if ref and not target.valid_ref(ref):
        return _error(iid, "dispatch: ref is not a valid ref name")
    try:
        sub = target.normalize_path("" if skill_path.strip() == "/" else skill_path.strip())
    except ValueError as e:
        return _error(iid, f"dispatch: {e}")
    return {"id": iid, "item_type": "skill", "url": f"https://github.com/{repo}", "repo": repo, "ref": ref or None,
            "path": sub, "force": True}


def collect(inbox: Path, url: str, run_id: str, skill_path: str = "", ref: str = "") -> list[dict]:
    if url:
        return [dispatch_item(url, run_id, skill_path, ref)]
    out, skipped = [], []
    for p in sorted(Path(inbox).glob("*.json")):
        if not p.is_file():
            continue
        if not ID_RE.match(p.stem):
            skipped.append(p.name)
            continue
        out.append(_item(p))
    out.sort(key=lambda i: i["id"])
    if skipped or len(out) > MAX_ITEMS:
        print(json.dumps({"skipped": skipped, "deferred": len(out[MAX_ITEMS:])}), file=sys.stderr)
    return out[:MAX_ITEMS]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", type=Path, required=True)
    ap.add_argument("--url", default="")
    ap.add_argument("--skill-path", default="")
    ap.add_argument("--ref", default="")
    ap.add_argument("--run-id", required=True)
    args = ap.parse_args(argv)
    items = collect(args.inbox, args.url.strip(), args.run_id, args.skill_path, args.ref.strip())
    print(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
