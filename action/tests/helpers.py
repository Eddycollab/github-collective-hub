"""Builders shared by the index and publish tests."""
from pathlib import Path

import entry

ANALYSIS = {
    "tagline": "測試用的一句白話副標",
    "intro": "一個給人用的白話介紹，說明這個工具能幫你做什麼事情，以及為什麼你會想用它。", "examples": ["用它來整理下載資料夾裡的檔案。", "用它來幫專案自動寫測試。"],
    "requirements": ["平台：只支援 Windows", "費用：免費"],
    "summary": "這是一個用來測試的專案，說明寫得夠長才會通過驗證。", "category": "dev-tool", "tags": ["cli", "test"],
    "stack": ["Python"], "highlights": ["第一個值得借鏡的地方。", "第二個值得借鏡的地方。"],
    "problem": "下載資料夾越堆越亂，找不到要的檔案。", "suggested_tags": ["程式類"],
    "fit": ["可以拿來整理教育平台的教材檔案。"],
}
SKILL_ANALYSIS = {
    "tagline": "把 PDF 變成可讀的重點", "intro": "讓 AI 助理能讀懂 PDF 檔案，幫你抽出文字、表格並整理成重點，不用自己一頁頁翻。",
    "problem": "PDF 內容難以直接交給 AI 處理。", "triggers": ["使用者要求讀取或整理 PDF 時"],
    "inputs": ["PDF 檔案"], "outputs": ["整理好的文字與表格"], "compatible_tools": ["Claude Code"],
    "dependencies": ["Python 3.10", "pypdf"], "permissions": ["讀寫本機檔案"], "install": ["複製到 ~/.claude/skills"],
    "requirements": ["需要準備：Python 環境"], "summary": "SKILL.md 描述流程，scripts 內有抽取文字的 Python 腳本。",
    "category": "agent-skill", "tags": ["pdf"], "stack": ["Python"], "highlights": ["把重複步驟寫成腳本再由技能呼叫。"],
    "suggested_tags": ["AI 工具"], "fit": ["可以讓教育平台自動整理講義 PDF。"],
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
    entry.write_entry_files(path, fm, entry.render_entry(fm, ANALYSIS, svg_name, user))
    return path
