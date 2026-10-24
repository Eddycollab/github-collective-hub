"""Summarize `claude -p --output-format stream-json --verbose` output into a run record.

CLI: claude_stream.py <stream.jsonl> [<fix-round.jsonl> ...] <out.json>
     claude_stream.py --error <run.json>   (prints why Claude failed; exit 1 when it did not)
Streams are concatenated in order (the latest result event wins). Exit 2 when no stream has a
result event (the record is still written).
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from typing import Iterable

RESULT_TEXT_MAX = 2000


def summarize(lines: Iterable[str]) -> dict:
    by_name: Counter[str] = Counter()
    files: set[str] = set()
    result = None
    for line in lines:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    name = str(block.get("name", "?"))
                    by_name[name] += 1
                    path = (block.get("input") or {}).get("file_path")
                    if name == "Read" and isinstance(path, str):
                        files.add(path)
        elif ev.get("type") == "result":
            result = {k: v for k, v in ev.items() if k != "result"}
            result["result_text"] = str(ev.get("result") or "")[:RESULT_TEXT_MAX]
    return {
        "result": result,
        "tools": {
            "by_name": dict(by_name),
            "calls": sum(by_name.values()),
            "deepwiki": any(n.startswith("mcp__deepwiki") for n in by_name),
            "files_read": len(files),
        },
    }


def claude_error(record: dict | None) -> str | None:
    """One line naming why Claude itself failed, or None when its run ended normally."""
    result = (record or {}).get("result")
    if not isinstance(result, dict):
        return "claude: no result event (the CLI crashed, was killed or never started)"
    if not result.get("is_error"):
        return None
    status = result.get("api_error_status")
    text = " ".join(str(result.get("result_text") or "").split())[:300]
    msg = "claude: " + (text or str(result.get("terminal_reason") or result.get("subtype") or "error"))
    if status in (401, 403):
        msg += " (check the CLAUDE_CODE_OAUTH_TOKEN Actions secret; regenerate it with `claude setup-token`)"
    return msg


def main(argv: list[str]) -> int:
    if argv[:1] == ["--error"] and len(argv) == 2:
        # claude_stream.py --error <run.json>: print Claude's failure and exit 0, or exit 1 when none.
        try:
            record = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            record = None
        msg = claude_error(record)
        if msg is None:
            return 1
        print(msg)
        return 0
    if len(argv) < 2:
        print("usage: claude_stream.py <stream.jsonl> [...] <out.json>", file=sys.stderr)
        return 1
    *sources, out = [Path(a) for a in argv]
    lines: list[str] = []
    for src in sources:
        if src.exists():
            lines += src.read_text(encoding="utf-8", errors="replace").splitlines()
    record = summarize(lines)
    record["rounds_logged"] = len(sources)
    out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if record["result"] is not None else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
