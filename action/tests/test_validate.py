import json
import unittest

from _path import FIXTURES
import taxonomy
import validate

CATS = taxonomy.names(taxonomy.DEFAULT)
OK = json.loads((FIXTURES / "summary_ok.json").read_text(encoding="utf-8"))
SVG_OK = (FIXTURES / "svg_ok.svg").read_text(encoding="utf-8")


def summary_with(**changes):
    d = dict(OK)
    d.update(changes)
    return json.dumps(d, ensure_ascii=False)


def svg_with(fragment):
    return SVG_OK.replace("</svg>", fragment + "</svg>")


class SummaryTest(unittest.TestCase):
    def test_summary_ok(self):
        self.assertEqual(validate.validate_summary(json.dumps(OK, ensure_ascii=False), CATS), [])

    def test_summary_rejects_two_json_values(self):
        one = json.dumps(OK, ensure_ascii=False)
        self.assertTrue(validate.validate_summary(one + "\n" + one, CATS))

    def test_summary_rejects_english_only(self):
        self.assertTrue(validate.validate_summary(summary_with(summary="An English only summary that is long enough."), CATS))

    def test_summary_rejects_extra_key(self):
        d = dict(OK, extra=1)
        self.assertTrue(validate.validate_summary(json.dumps(d, ensure_ascii=False), CATS))

    def test_summary_rejects_six_tags(self):
        self.assertTrue(validate.validate_summary(summary_with(tags=["a", "b", "c", "d", "e", "f"]), CATS))

    def test_summary_rejects_uppercase_tag(self):
        self.assertTrue(validate.validate_summary(summary_with(tags=["MCP"]), CATS))

    def test_summary_rejects_unknown_category(self):
        self.assertTrue(validate.validate_summary(summary_with(category="agent-runtime"), CATS))

    def test_summary_rejects_one_highlight(self):
        self.assertTrue(validate.validate_summary(summary_with(highlights=["只有一點值得借鏡的地方而已。"]), CATS))

    def test_summary_rejects_empty_stack(self):
        self.assertTrue(validate.validate_summary(summary_with(stack=[]), CATS))

    def test_summary_rejects_non_object(self):
        self.assertTrue(validate.validate_summary("[1, 2]", CATS))
        self.assertTrue(validate.validate_summary("not json", CATS))

    def test_summary_requires_intro_and_examples(self):
        d = {k: v for k, v in OK.items() if k != "intro"}
        self.assertTrue(validate.validate_summary(json.dumps(d, ensure_ascii=False), CATS))
        self.assertTrue(validate.validate_summary(summary_with(intro="Plain English intro that is long enough to pass."), CATS))
        self.assertTrue(validate.validate_summary(summary_with(examples=[]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(examples=["例如一。", "例如二二。", "例如三三三。"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(examples=["例如" + "很長" * 70]), CATS))

    def test_summary_requirements_rules(self):
        d = {k: v for k, v in OK.items() if k != "requirements"}
        self.assertTrue(validate.validate_summary(json.dumps(d, ensure_ascii=False), CATS))
        self.assertTrue(validate.validate_summary(summary_with(requirements=[]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(requirements=["一", "二二二二", "三三三三", "四四四四", "五五五五"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(requirements=["Windows only"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(requirements=["平台" + "很長" * 60]), CATS))
        self.assertEqual(validate.validate_summary(summary_with(requirements=["不需安裝，直接閱讀"]), CATS), [])

    def test_summary_tagline_rules(self):
        d = {k: v for k, v in OK.items() if k != "tagline"}
        self.assertTrue(validate.validate_summary(json.dumps(d, ensure_ascii=False), CATS))
        self.assertTrue(validate.validate_summary(summary_with(tagline="短"), CATS))
        self.assertTrue(validate.validate_summary(summary_with(tagline="這句副標寫得實在太長了已經超過二十個字的上限"), CATS))
        self.assertTrue(validate.validate_summary(summary_with(tagline="English only tagline"), CATS))


class SvgTest(unittest.TestCase):
    def test_svg_ok_example_passes(self):
        for name in ("svg_ok.svg", "svg_livesummary.svg", "svg_openchatx.svg"):
            with self.subTest(name=name):
                self.assertEqual(validate.validate_svg((FIXTURES / name).read_text(encoding="utf-8")), [])

    def test_svg_rejects_each_fixture(self):
        bad = {
            "script": '<script>alert(1)</script>',
            "onload": '<rect x="0" y="0" width="1" height="1" onload="alert(1)"/>',
            "foreign": '<foreignObject><div>x</div></foreignObject>',
            "ext_href": '<use href="https://evil.example/x.svg#a"/>',
            "style_import": '<style>@import url(http://evil.example/x.css);</style>',
            "image": '<image href="http://evil.example/p.png"/>',
            "fill_url": '<rect x="0" y="0" width="1" height="1" fill="url(http://evil.example/#g)"/>',
            "style_attr": '<rect x="0" y="0" width="1" height="1" style="fill:red"/>',
            "data_uri": '<use href="data:image/svg+xml;base64,AAAA"/>',
        }
        for name, frag in bad.items():
            with self.subTest(name=name):
                self.assertTrue(validate.validate_svg(svg_with(frag)))
        doctype = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>' + SVG_OK.split("?>", 1)[-1]
        self.assertTrue(validate.validate_svg(doctype))
        self.assertTrue(validate.validate_svg("<svg"))

    def test_svg_rejects_oversize(self):
        self.assertTrue(validate.validate_svg(svg_with("<!--" + "x" * (2 * 1024 * 1024) + "-->")))

    def test_svg_allows_internal_href_and_url_hash(self):
        frag = '<use href="#icon-x"/><path d="M0 0" marker-end="url(#ah)"/>'
        self.assertEqual(validate.validate_svg(svg_with(frag)), [])

    def test_svg_rejects_css_escape_and_strict_paint_grammar(self):
        bad = [
            '<path d="M0 0" marker-end="\\75 rl(https://example.com/track.svg#ah)"/>',
            '<path d="M0 0" marker-end="url(#ah) url(https://e/x)"/>',
            '<rect x="0" y="0" width="1" height="1" fill="u\\rl(http://e)"/>',
            '<rect x="0" y="0" width="1" height="1" fill="expression(alert(1))"/>',
            '<rect x="0" y="0" width="1" height="1" stroke="red;background:url(http://e)"/>',
            '<text x="0" y="0" font-family="a\x01b">x</text>',
        ]
        for frag in bad:
            with self.subTest(frag=frag):
                self.assertTrue(validate.validate_svg(svg_with(frag)))

    def test_svg_accepts_palette_paint_values(self):
        frag = '<rect x="0" y="0" width="1" height="1" fill="none" stroke="#1a1a1a"/><circle cx="1" cy="1" r="1" fill="#FAF8F4"/>'
        self.assertEqual(validate.validate_svg(svg_with(frag)), [])

class SummaryV2Test(unittest.TestCase):
    def skill(self, **changes):
        from helpers import SKILL_ANALYSIS
        d = dict(SKILL_ANALYSIS)
        d.update(changes)
        return validate.validate_summary(json.dumps(d, ensure_ascii=False), CATS, "skill")

    def test_skill_ok_and_repo_shape_rejected_for_skill(self):
        self.assertEqual(self.skill(), [])
        self.assertTrue(validate.validate_summary(json.dumps(OK, ensure_ascii=False), CATS, "skill"))
        self.assertTrue(self.skill(examples=["多出來的例子欄位不屬於 skill。"]))
        self.assertTrue(validate.validate_summary("{}", CATS, "gist"))

    def test_skill_optional_lists_may_be_empty(self):
        self.assertEqual(self.skill(inputs=[], outputs=[], compatible_tools=[], dependencies=[], permissions=[],
                                    install=[], stack=[], highlights=["只有一點值得借鏡的地方。"]), [])

    def test_skill_field_rules(self):
        for bad in (dict(triggers=[]), dict(compatible_tools=["VS Code"]), dict(compatible_tools=["Codex", "Codex"]),
                    dict(dependencies=["x"]), dict(install=["步" * 161]), dict(inputs=["only english"]),
                    dict(permissions=["a"] * 7)):
            with self.subTest(bad=bad):
                self.assertTrue(self.skill(**bad))

    def test_inferred_fields(self):
        self.assertTrue(validate.validate_summary(summary_with(suggested_tags=["不在字彙"]), CATS))
        self.assertEqual(validate.validate_summary(summary_with(suggested_tags=["客語"]), CATS, vocab=["客語"]), [])
        self.assertTrue(validate.validate_summary(summary_with(suggested_tags=["程式類", "程式類"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(suggested_tags=["簡報類", "程式類", "語音類", "AI 工具", "教育應用"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(fit=[]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(fit=["english only fit sentence"]), CATS))
        self.assertTrue(validate.validate_summary(summary_with(problem="短"), CATS))


class CliTest(unittest.TestCase):
    def test_summary_cli_survives_malformed_taxonomy(self):
        import subprocess, sys, tempfile
        from pathlib import Path
        from _path import SCRIPTS
        tmp = Path(tempfile.mkdtemp()) / "taxonomy.yml"
        tmp.write_text("categories: [unterminated\n", encoding="utf-8")
        p = subprocess.run([sys.executable, str(SCRIPTS / "validate.py"), "summary", str(FIXTURES / "summary_ok.json"),
                            "--taxonomy", str(tmp)], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
