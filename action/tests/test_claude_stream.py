import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _path import FIXTURES, SCRIPTS
import claude_stream

OK = (FIXTURES / "stream_ok.jsonl").read_text().splitlines()


class ClaudeStreamTest(unittest.TestCase):
    def test_counts_tools(self):
        tools = claude_stream.summarize(OK)["tools"]
        self.assertEqual(tools["by_name"], {"Read": 2, "mcp__deepwiki__ask_question": 1, "Write": 1})
        self.assertEqual(tools["calls"], 4)
        self.assertTrue(tools["deepwiki"])
        self.assertEqual(tools["files_read"], 1)

    def test_result_text_truncated_to_2000(self):
        r = claude_stream.summarize(OK)["result"]
        self.assertEqual(len(r["result_text"]), 2000)
        self.assertNotIn("result", r)

    def test_session_id_kept(self):
        r = claude_stream.summarize(OK)["result"]
        self.assertEqual(r["session_id"], "sid-1")
        self.assertEqual(r["num_turns"], 3)

    def test_bad_line_skipped(self):
        s = claude_stream.summarize(["garbage", *OK, "{not json"])
        self.assertEqual(s["tools"]["calls"], 4)

    def test_no_result_exit_2(self):
        out = Path(tempfile.mkdtemp()) / "run.json"
        p = subprocess.run([sys.executable, str(SCRIPTS / "claude_stream.py"),
                            str(FIXTURES / "stream_noresult.jsonl"), str(out)])
        self.assertEqual(p.returncode, 2)
        self.assertIsNone(json.loads(out.read_text())["result"])

    def test_cli_merges_multiple_streams(self):
        out = Path(tempfile.mkdtemp()) / "run.json"
        ok = str(FIXTURES / "stream_ok.jsonl")
        p = subprocess.run([sys.executable, str(SCRIPTS / "claude_stream.py"), ok, ok, out.as_posix()])
        self.assertEqual(p.returncode, 0)
        rec = json.loads(out.read_text())
        self.assertEqual(rec["tools"]["by_name"]["Read"], 4)
        self.assertEqual(rec["tools"]["calls"], 8)
        self.assertEqual(rec["tools"]["files_read"], 1)
        self.assertEqual(rec["result"]["session_id"], "sid-1")
        self.assertEqual(rec["rounds_logged"], 2)

    def test_cli_last_result_wins_even_if_last_stream_lacks_one(self):
        out = Path(tempfile.mkdtemp()) / "run.json"
        p = subprocess.run([sys.executable, str(SCRIPTS / "claude_stream.py"), str(FIXTURES / "stream_ok.jsonl"),
                            str(FIXTURES / "stream_noresult.jsonl"), str(out)])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(json.loads(out.read_text())["result"]["session_id"], "sid-1")

    def _error_cli(self, record):
        run = Path(tempfile.mkdtemp()) / "run.json"
        if record is not None:
            run.write_text(json.dumps(record), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPTS / "claude_stream.py"), "--error", str(run)],
                              capture_output=True, text=True, encoding="utf-8")

    def test_auth_failure_is_reported_as_claude_error_not_missing_summary(self):
        rec = claude_stream.summarize((FIXTURES / "stream_auth401.jsonl").read_text().splitlines())
        msg = claude_stream.claude_error(rec)
        self.assertIn("401 Invalid bearer token", msg)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN", msg)
        self.assertNotIn("summary.json", msg)
        p = self._error_cli(rec)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), msg)

    def test_successful_run_has_no_claude_error(self):
        rec = claude_stream.summarize((FIXTURES / "stream_ok.jsonl").read_text().splitlines())
        self.assertIsNone(claude_stream.claude_error(rec))
        p = self._error_cli(rec)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, "")

    def test_missing_or_resultless_run_record_is_a_claude_error(self):
        for record in (None, {"result": None}):
            p = self._error_cli(record)
            self.assertEqual(p.returncode, 0)
            self.assertIn("no result event", p.stdout)


if __name__ == "__main__":
    unittest.main()
