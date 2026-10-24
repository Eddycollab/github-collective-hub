"""Validators for model output: summary.json schema and an SVG element/attribute allowlist.

CLI: validate.py summary <file> [--taxonomy <yml>] [--item-type T] [--vocab <tags.yml>] [--user-json <file>]
     validate.py svg <file>
Exit 0 with no output when valid; otherwise one error per line and exit 1.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import tags
import taxonomy

CJK = re.compile(r"[一-鿿]")
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,39}$")
STACK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .+#/-]{0,29}$")
COMMON_KEYS = {"tagline", "intro", "problem", "requirements", "summary", "category", "tags", "stack", "highlights",
               "suggested_tags", "fit"}
SUMMARY_KEYS = {"repository": COMMON_KEYS | {"examples"},
                "skill": COMMON_KEYS | {"triggers", "inputs", "outputs", "compatible_tools", "dependencies",
                                        "permissions", "install"}}
TOOLS = ("Claude Code", "Claude.ai", "Claude API", "Codex", "其他")
SVG_MAX_BYTES = 2 * 1024 * 1024

# Everything arch-blueprint's example and icon library use, plus a few harmless shape/text
# elements. No style, script, foreignObject, image or a: those are how SVG reaches the network.
SVG_ELEMENTS = {
    "svg", "title", "desc", "defs", "symbol", "g", "rect", "path", "line", "polyline",
    "polygon", "circle", "ellipse", "text", "tspan", "use", "marker",
}
SVG_ATTRS = {
    "aria-hidden", "aria-labelledby", "class", "cx", "cy", "d", "data-edge", "fill",
    "fill-opacity", "font-family", "font-size", "font-weight", "height", "href", "id",
    "letter-spacing", "marker-end", "marker-start", "markerHeight", "markerWidth", "orient",
    "points", "r", "refX", "refY", "role", "rx", "ry", "stroke", "stroke-dasharray",
    "stroke-linecap", "stroke-linejoin", "stroke-opacity", "stroke-width", "text-anchor",
    "transform", "viewBox", "width", "x", "x1", "x2", "y", "y1", "y2", "dominant-baseline",
    "opacity", "xmlns", "version",
}
INTERNAL_URL = r"url\(#[A-Za-z0-9_-]+\)"
# Exact grammars: a CSS escape such as "\75 rl(...)" can never match these.
STRICT = {
    "marker-start": re.compile(rf"^{INTERNAL_URL}$"),
    "marker-end": re.compile(rf"^{INTERNAL_URL}$"),
    "fill": re.compile(rf"^(none|transparent|currentColor|#[0-9A-Fa-f]{{3}}|#[0-9A-Fa-f]{{6}}|#[0-9A-Fa-f]{{8}}|{INTERNAL_URL})$"),
    "stroke": re.compile(rf"^(none|transparent|currentColor|#[0-9A-Fa-f]{{3}}|#[0-9A-Fa-f]{{6}}|#[0-9A-Fa-f]{{8}}|{INTERNAL_URL})$"),
}
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _text(v, lo: int, hi: int, cjk: bool = True) -> bool:
    return isinstance(v, str) and lo <= len(v) <= hi and (not cjk or bool(CJK.search(v)))


def _lines(v, n_lo: int, n_hi: int, lo: int, hi: int, cjk: bool = True) -> bool:
    return isinstance(v, list) and n_lo <= len(v) <= n_hi and all(_text(x, lo, hi, cjk) for x in v)


def validate_summary(text: str, categories: list[str], item_type: str = "repository",
                     vocab: list[str] | None = None) -> list[str]:
    try:
        data = json.loads(text)
    except ValueError as e:
        return [f"not a single JSON value: {e}"]
    if not isinstance(data, dict):
        return ["top level must be an object"]
    keys = SUMMARY_KEYS.get(item_type)
    if keys is None:
        return [f"unknown item_type {item_type!r}"]
    skill = item_type == "skill"
    vocab = tags.names(tags.DEFAULT) if vocab is None else vocab
    errors = []
    if set(data) != keys:
        errors.append(f"keys must be exactly {sorted(keys)}, got {sorted(data)}")
    if not _text(data.get("tagline"), 4, 20):
        errors.append("tagline: 4-20 chars of plain Traditional Chinese")
    if not _text(data.get("intro"), 30, 300):
        errors.append("intro: 30-300 chars of plain Traditional Chinese")
    if not _text(data.get("problem"), 10, 200):
        errors.append("problem: 10-200 chars of Traditional Chinese")
    if not skill and not _lines(data.get("examples"), 1, 2, 10, 120):
        errors.append("examples: 1-2 Chinese sentences of 10-120 chars")
    if not _lines(data.get("requirements"), 1, 4, 2, 100):
        errors.append("requirements: 1-4 Chinese lines of 2-100 chars")
    if not _text(data.get("summary"), 20, 600):
        errors.append("summary: 20-600 chars with Traditional Chinese text")
    if data.get("category") not in categories:
        errors.append(f"category: must be one of {categories}")
    tg = data.get("tags")
    if not (isinstance(tg, list) and len(tg) <= 5 and all(isinstance(t, str) and TAG_RE.match(t) for t in tg)):
        errors.append("tags: at most 5 lowercase tags")
    stack = data.get("stack")
    if not (isinstance(stack, list) and (0 if skill else 1) <= len(stack) <= 8
            and all(isinstance(s, str) and STACK_RE.match(s) for s in stack)):
        errors.append(f"stack: {'0' if skill else '1'}-8 short names")
    if not _lines(data.get("highlights"), 1 if skill else 2, 3, 10, 120):
        errors.append(f"highlights: {'1' if skill else '2'}-3 Chinese sentences of 10-120 chars")
    st = data.get("suggested_tags")
    if not (isinstance(st, list) and len(st) <= 4 and len(set(map(str, st))) == len(st) and all(t in vocab for t in st)):
        errors.append(f"suggested_tags: 0-4 distinct tags from {vocab}")
    if not _lines(data.get("fit"), 1, 3, 10, 150):
        errors.append("fit: 1-3 Chinese sentences of 10-150 chars")
    if skill:
        if not _lines(data.get("triggers"), 1, 4, 4, 120):
            errors.append("triggers: 1-4 Chinese items of 4-120 chars")
        for k in ("inputs", "outputs"):
            if not _lines(data.get(k), 0, 4, 2, 100):
                errors.append(f"{k}: 0-4 Chinese items of 2-100 chars")
        ct = data.get("compatible_tools")
        if not (isinstance(ct, list) and len(ct) <= 4 and len(set(map(str, ct))) == len(ct) and all(t in TOOLS for t in ct)):
            errors.append(f"compatible_tools: 0-4 distinct values from {list(TOOLS)}")
        for k in ("dependencies", "permissions"):
            if not _lines(data.get(k), 0, 6, 2, 100, cjk=False):
                errors.append(f"{k}: 0-6 items of 2-100 chars")
        if not _lines(data.get("install"), 0, 4, 2, 160, cjk=False):
            errors.append("install: 0-4 items of 2-160 chars")
    return errors


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def validate_svg(text: str) -> list[str]:
    if len(text.encode("utf-8")) > SVG_MAX_BYTES:
        return ["svg larger than 2 MiB"]
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        return ["DOCTYPE/ENTITY not allowed"]
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        return [f"not well-formed XML: {e}"]
    errors = []
    for el in root.iter():
        tag = _local(el.tag) if isinstance(el.tag, str) else "?"
        if tag not in SVG_ELEMENTS:
            errors.append(f"{tag}: element not allowed")
            continue
        for raw_name, value in el.attrib.items():
            name = _local(raw_name)
            low = value.strip().lower()
            if name.startswith("on") or name == "style":
                errors.append(f"{tag}@{name}: attribute not allowed")
            elif name not in SVG_ATTRS and not raw_name.startswith("{http://www.w3.org/2000/xmlns/}"):
                errors.append(f"{tag}@{name}: attribute not allowed")
            elif "\\" in value or CONTROL.search(value):
                errors.append(f"{tag}@{name}: escapes and control characters not allowed")
            elif name == "href" and not value.startswith("#"):
                errors.append(f"{tag}@{name}: only internal #references allowed")
            elif name in STRICT and not STRICT[name].match(value.strip()):
                errors.append(f"{tag}@{name}: value {value[:40]!r} not allowed")
            elif name not in STRICT and "url(" in low:
                errors.append(f"{tag}@{name}: url() not allowed here")
            elif "javascript:" in low or "data:" in low:
                errors.append(f"{tag}@{name}: script or data URI not allowed")
    return errors


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["summary", "svg"])
    ap.add_argument("file", type=Path)
    ap.add_argument("--taxonomy", type=Path)
    ap.add_argument("--item-type", choices=sorted(SUMMARY_KEYS), default="repository")
    ap.add_argument("--vocab", type=Path)
    ap.add_argument("--user-json", type=Path)
    args = ap.parse_args(argv)
    try:
        text = args.file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print(f"cannot read {args.file}: {e}")
        return 1
    if args.kind == "summary":
        vocab = tags.names(tags.vocabulary(args.vocab, args.user_json))
        errors = validate_summary(text, taxonomy.names(taxonomy.load_or_default(args.taxonomy)), args.item_type, vocab)
    else:
        errors = validate_svg(text)
    for e in errors:
        print(e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
