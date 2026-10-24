"""Upgrade upstream RepoBox (v1) library entries to record v2 in place.

CLI: migrate.py --library <collection repo>/library [--write]
Dry run by default: lists what would change. With --write, rewrites each outdated sidecar and the
.md frontmatter (the auto block and any hand-written text after it are kept byte for byte), then
regenerates README.md and index.json next to the library folder. Never touches user.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import entry
import index
import tags
import taxonomy


def outdated(md: Path) -> bool:
    side = entry.sidecar(md)
    if not side.is_file():
        return True
    try:
        data = json.loads(side.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return False  # a damaged sidecar is reported, never overwritten
    return not isinstance(data, dict) or data.get("schema_version") != entry.SCHEMA_VERSION


def migrate_one(md: Path) -> None:
    rec = entry.read_record(md)
    fm = {k: rec.get(k) for k in entry.FM_KEYS}
    fm["capture_tags"] = fm["capture_tags"] or entry.capture_tags(fm.get("sightings") or [])
    auto = entry.read_auto(md)
    _, user = entry.read_entry(md)
    text = entry.render_entry(fm, None, None, user, auto=auto if auto is not None else "\n")
    entry.write_entry_files(md, fm, text)


def run(library: Path, write: bool) -> dict:
    todo = [p for p in sorted(Path(library).glob("*.md")) if outdated(p)]
    done, failed = [], []
    for p in todo:
        if not write:
            continue
        try:
            migrate_one(p)
            done.append(p.name)
        except (OSError, ValueError, KeyError) as e:
            failed.append(f"{p.name}: {e}")
    if write and done:
        root = Path(library).parent
        cats = taxonomy.load_or_default(root / "taxonomy.yml")
        vocab = tags.vocabulary(root / "tags.yml", root / "user.json")
        entries = index.collect(library)
        (root / "README.md").write_text(index.render_readme(entries, cats), encoding="utf-8")
        (root / "index.json").write_text(index.render_index(entries, cats, vocab), encoding="utf-8")
    return {"outdated": [p.name for p in todo], "migrated": done, "failed": failed, "write": write}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", type=Path, required=True)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    if not args.library.is_dir():
        print(f"{args.library}: not a directory", file=sys.stderr)
        return 2
    res = run(args.library, args.write)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 1 if res["failed"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
