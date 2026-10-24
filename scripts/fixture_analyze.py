"""Local stand-in for the analyze job, for trying the whole loop without GitHub Actions or Claude.

CLI: python scripts/fixture_analyze.py --library <local collection folder> [--fail owner/repo ...]

It plans the inbox with the real items.py, writes the stage folder the analyze job would upload
using FIXTURE text (every field says so; it is not an analysis of the repository), then runs the
real publish.py without pushing. Nothing touches the network. Use it with scripts/preview.mjs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "action" / "scripts"))
import entry  # noqa: E402
import items  # noqa: E402
import publish  # noqa: E402
import tags  # noqa: E402
import target  # noqa: E402

LABEL = "（fixture 模擬分析，不是 Claude 產出）"
FIXTURE_SHA = "0" * 40


def fake_meta(full: str) -> dict:
    # A stable made-up id; no stars, language or license, because those would be invented facts.
    rid = int(hashlib.sha256(full.lower().encode()).hexdigest()[:8], 16)
    return {"id": rid, "full_name": full, "html_url": f"https://github.com/{full}", "private": False,
            "description": f"{LABEL}", "language": None, "stargazers_count": None, "license": None,
            "default_branch": "main"}


def fixture_summary(item_type: str, full: str, vocab: list[str]) -> dict:
    common = {
        "tagline": "本機模擬的收藏條目", "intro": f"{LABEL}這段文字只用來確認收藏、索引與網頁顯示流程，沒有讀過 {full} 的內容。",
        "problem": "示範：確認收藏流程能從收件匣走到收藏頁。", "requirements": ["需要準備：這是本機模擬資料"],
        "summary": f"{LABEL}沒有任何程式碼被分析。", "tags": ["fixture"], "suggested_tags": vocab[:1],
        "fit": ["（推論示範）等真正的 Claude 分析完成後，這裡才會有實際建議。"],
    }
    if item_type == "skill":
        return {**common, "category": "agent-skill", "triggers": ["示範：本機模擬的觸發情境"], "inputs": [], "outputs": [],
                "compatible_tools": [], "dependencies": [], "permissions": [], "install": [], "stack": [],
                "highlights": ["示範：這是模擬資料，沒有實際借鏡內容。"]}
    return {**common, "category": "other", "examples": ["示範：在本機預覽中走完一次收藏流程。"], "stack": ["Fixture"],
            "highlights": ["示範：這是模擬資料，沒有實際借鏡內容。", "示範：真正的分析要在 GitHub Actions 上執行。"]}


def stage(item: dict, art: Path, repo: Path, vocab: list[str], fail: set[str]) -> None:
    d = art / f"repobox-out-{item['id']}"
    d.mkdir(parents=True)
    (d / "item.json").write_text(json.dumps(item), encoding="utf-8")
    status = {"status": "failed", "error": None, "entry": None, "repo_id": None, "diagram": False, "rounds": 0,
              "wall_s": 0, "claude_exit": None}
    if item.get("error") or item["repo"].lower() in fail:
        status["error"] = item.get("error") or "fixture: 模擬分析失敗（--fail）"
    else:
        meta = fake_meta(item["repo"])
        (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        if item["item_type"] == "skill":
            md = f"---\nname: {(item['path'] or 'root').rsplit('/', 1)[-1]}\ndescription: {LABEL}\n---\n"
            rec = target.stage_record(meta, "skill", item["ref"] or "main", FIXTURE_SHA, item["path"], md)
        else:
            rec = target.stage_record(meta, "repository")
        (d / "target.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        found = entry.find_entry(repo / "library", meta["id"], meta["full_name"], item["item_type"], item["path"])
        status.update(repo_id=meta["id"], entry=found.relative_to(repo).as_posix() if found else None, claude_exit=0)
        if found and not item["force"]:
            status["status"] = "dedup"
        else:
            summary = fixture_summary(item["item_type"], item["repo"], vocab)
            (d / "summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
            (d / "run.json").write_text(json.dumps({"result": {"num_turns": 0, "modelUsage": {"fixture": {}}}, "tools": {}}), encoding="utf-8")
            status["status"] = "ok"
    (d / "status.json").write_text(json.dumps(status), encoding="utf-8")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", type=Path, required=True, help="local collection folder (made by scripts/preview.mjs)")
    ap.add_argument("--fail", nargs="*", default=[], help="owner/repo to mark as failed")
    args = ap.parse_args(argv)
    repo = args.library.resolve()
    if not (repo / "inbox").is_dir():
        print(f"{repo} has no inbox/ folder", file=sys.stderr)
        return 1
    planned = items.collect(repo / "inbox", "", "fixture")
    if not planned:
        print("inbox is empty: nothing to analyze")
        return 0
    vocab = [t["name"] for t in tags.load_or_default(repo / "tags.yml")]
    with tempfile.TemporaryDirectory() as tmp:
        art = Path(tmp)
        for it in planned:
            stage(it, art, repo, vocab, {f.lower() for f in args.fail})
        counts = publish.run(art, repo, items=planned)
    print(json.dumps(counts, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
