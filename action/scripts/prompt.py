"""Render the analyze / fix prompts from action/prompts/*.md with string.Template.

CLI: prompt.py analyze --full F --target T --out O --skill S --taxonomy <yml|-> [--item-type T]
                       [--vocab <tags.yml|->] [--user-json <file|->] [--skill-path P] [--ref R] [--sha S]
     prompt.py fix --out O --check <check.txt>
     prompt.py fix-summary --out O --errors <validator output> [--item-type T]
"""
from __future__ import annotations

import argparse
import string
import sys
from pathlib import Path

import tags
import taxonomy

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"
ANALYZE = PROMPTS / "analyze.md"
ANALYZE_SKILL = PROMPTS / "analyze-skill.md"
FIX = PROMPTS / "fix.md"
FIX_SUMMARY = PROMPTS / "fix-summary.md"
TEMPLATES = {"repository": ANALYZE, "skill": ANALYZE_SKILL}
# Bump when a template's output contract changes; publish records it as analysis.version.
VERSIONS = {"repository": "repository-v2", "skill": "skill-v1"}
SHAPES = {
    "repository": ("tagline, intro, problem, examples, requirements, summary, category, tags, stack, highlights, "
                   "suggested_tags, fit; tagline 4-20 characters, intro 30-300 characters, problem 10-200 characters, "
                   "examples 1-2 items and highlights 2-3 items of 10-120 characters each, requirements 1-4 items "
                   "of 2-100 characters, fit 1-3 items of 10-150 characters, suggested_tags 0-4 names from the "
                   "tag list in your instructions"),
    "skill": ("tagline, intro, problem, triggers, inputs, outputs, compatible_tools, dependencies, permissions, "
              "install, requirements, summary, category, tags, stack, highlights, suggested_tags, fit; tagline 4-20 "
              "characters, intro 30-300 characters, problem 10-200 characters, triggers 1-4 items of 4-120 "
              "characters, inputs and outputs 0-4 items of 2-100 characters, compatible_tools 0-4 of exactly "
              "Claude Code / Claude.ai / Claude API / Codex / 其他, dependencies and permissions 0-6 items of 2-100 "
              "characters, install 0-4 items of 2-160 characters, requirements 1-4 items of 2-100 characters, "
              "highlights 1-3 items of 10-120 characters, fit 1-3 items of 10-150 characters, suggested_tags 0-4 "
              "names from the tag list in your instructions"),
}


def render(template: Path, **values: str) -> str:
    # substitute() is single-pass, so a "$OUT" inside checker output stays literal.
    return string.Template(template.read_text(encoding="utf-8")).substitute(**values)


def _opt(path: str) -> Path | None:
    return None if path in ("", "-") else Path(path)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="kind", required=True)
    a = sub.add_parser("analyze")
    for flag in ("--full", "--target", "--out", "--skill", "--taxonomy"):
        a.add_argument(flag, required=True)
    a.add_argument("--item-type", choices=sorted(TEMPLATES), default="repository")
    a.add_argument("--vocab", default="-")
    a.add_argument("--user-json", default="-")
    a.add_argument("--skill-path", default="")
    a.add_argument("--ref", default="")
    a.add_argument("--sha", default="")
    f = sub.add_parser("fix")
    f.add_argument("--out", required=True)
    f.add_argument("--check", required=True)
    fs = sub.add_parser("fix-summary")
    fs.add_argument("--out", required=True)
    fs.add_argument("--errors", required=True)
    fs.add_argument("--item-type", choices=sorted(TEMPLATES), default="repository")
    args = ap.parse_args(argv)
    if args.kind == "analyze":
        cats = taxonomy.load_or_default(_opt(args.taxonomy))
        vocab = tags.vocabulary(_opt(args.vocab), _opt(args.user_json))
        values = dict(FULL=args.full, TARGET=args.target, OUT=args.out, SKILL=args.skill,
                      TAXONOMY=taxonomy.render_for_prompt(cats), VOCAB=tags.render_for_prompt(vocab))
        if args.item_type == "skill":
            values.update(SKILL_PATH=args.skill_path or "（repo 根目錄）", REF=args.ref or "-", SHA=args.sha or "-")
        text = render(TEMPLATES[args.item_type], **values)
    elif args.kind == "fix":
        check = Path(args.check).read_text(encoding="utf-8", errors="replace")
        text = render(FIX, OUT=args.out, CHECK=check)
    else:
        errors = Path(args.errors).read_text(encoding="utf-8", errors="replace")
        text = render(FIX_SUMMARY, OUT=args.out, ERRORS=errors, SHAPE=SHAPES[args.item_type])
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
