"""Builders shared by the index and publish tests."""
from pathlib import Path

import entry

ANALYSIS = {
    "summary": "這是一個用來測試的專案，說明寫得夠長才會通過驗證。", "category": "dev-tool", "tags": ["cli", "test"],
    "stack": ["Python"], "highlights": ["第一個值得借鏡的地方。", "第二個值得借鏡的地方。"],
}


def meta(full="Owner/Repo", rid=1, **kw):
    m = {"id": rid, "full_name": full, "html_url": f"https://github.com/{full}", "description": "desc",
         "language": "Python", "stargazers_count": 3, "license": None}
    m.update(kw)
    return m


def write_entry(library: Path, full="Owner/Repo", rid=1, sightings=(), category="dev-tool", stem=None,
                svg=False, user=None, **meta_kw):
    library.mkdir(parents=True, exist_ok=True)
    stem = stem or entry.slug(full)
    fm = entry.build_frontmatter(meta(full, rid, **meta_kw), dict(ANALYSIS, category=category), list(sightings),
                                 None, None, now="2026-10-01T00:00:00+00:00")
    svg_name = f"{stem}.svg" if svg else None
    if svg:
        (library / svg_name).write_text("<svg/>", encoding="utf-8")
    path = library / f"{stem}.md"
    path.write_text(entry.render_entry(fm, ANALYSIS, svg_name, user), encoding="utf-8")
    return path
