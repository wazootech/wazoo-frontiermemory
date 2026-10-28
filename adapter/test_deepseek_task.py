"""Smoke tests for the DeepSeek task driver — no Docker, no Modal, no network.

    python3 -m unittest adapter/test_deepseek_task.py

Covers what can be tested in a plain sandbox:
- request formatting and response parsing against a local mock HTTP server
- memory-seeding logic (upload plan + MEMORY.md-first entry check) on temp dirs
- completion-marker detection
These do NOT exercise Harbor itself; the real harness wiring is validated on
Ethan's machine (see adapter/README.md).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import deepseek_driver as driver  # noqa: E402


class MockDeepSeek(HTTPServer):
    """Serves canned chat-completions responses and records the last request."""

    def __init__(self, responses: list[dict]):
        self.responses = responses
        self.requests: list[dict] = []
        super().__init__(("127.0.0.1", 0), Handler)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        server: MockDeepSeek = self.server
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        server.requests.append({"auth": self.headers.get("Authorization"), "body": body})
        response = server.responses[len(server.requests) - 1]
        payload = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # keep test output quiet
        pass


def tool_response(calls: list[tuple[str, str]], usage=(10, 0, 5)) -> dict:
    return {
        "choices": [{"message": {
            "content": "", "tool_calls": [
                {"id": f"call_{i}", "type": "function",
                 "function": {"name": "bash", "arguments": json.dumps({"command": cmd})}}
                for i, (name, cmd) in enumerate(calls)
            ]}}],
        "usage": {"prompt_tokens": usage[0],
                  "prompt_tokens_details": {"cached_tokens": usage[1]},
                  "completion_tokens": usage[2]},
    }


def text_response(text: str, usage=(10, 0, 5)) -> dict:
    return {"choices": [{"message": {"content": text, "tool_calls": None}}],
            "usage": {"prompt_tokens": usage[0],
                      "prompt_tokens_details": {"cached_tokens": usage[1]},
                      "completion_tokens": usage[2]}}


class RequestFormatAndParsing(unittest.TestCase):
    def test_loop_sends_system_user_and_tool_results(self):
        server = MockDeepSeek([
            tool_response([("bash", "echo hello")]),
            text_response("all done"),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            httpd = threading.Thread(target=server.serve_forever, daemon=True)
            httpd.start()
            try:
                logs = Path(tmp) / "logs"
                env = dict(os.environ, DEEPSEEK_API_KEY="sk-test")
                env["DEEPSEEK_API_KEY"] = "sk-test"
                old = os.environ.get("DEEPSEEK_API_KEY")
                os.environ["DEEPSEEK_API_KEY"] = "sk-test"
                try:
                    rc = driver.main([
                        "--model", "deepseek-v4-flash",
                        "--instruction", "Write hello world to /workspace/hello.txt.",
                        "--logs", str(logs),
                        "--api-base", f"http://127.0.0.1:{server.server_port}",
                        "--max-turns", "5",
                        "--completion-marker", "",
                    ])
                finally:
                    if old is not None:
                        os.environ["DEEPSEEK_API_KEY"] = old
                    else:
                        os.environ.pop("DEEPSEEK_API_KEY", None)
                server.shutdown()
                self.assertEqual(rc, 0)
            finally:
                server.server_close()

            request = server.requests[0]
            self.assertEqual(request["auth"], "Bearer sk-test")
            messages = request["body"]["messages"]
            self.assertEqual(messages[0]["role"], "system")
            self.assertIn("bash", json.dumps(request["body"]["tools"]))
            self.assertEqual(messages[1], {"role": "user", "content": "Write hello world to /workspace/hello.txt."})
            # the second request carries the assistant tool call and the tool result
            self.assertEqual(len(server.requests), 2)
            messages = server.requests[1]["body"]["messages"]
            self.assertEqual(messages[2]["tool_calls"][0]["function"]["name"], "bash")
            self.assertEqual(messages[3]["role"], "tool")
            self.assertIn("hello", messages[3]["content"])
            self.assertEqual(request["body"]["model"], "deepseek-v4-flash")

            result = json.loads((Path(tmp) / "logs" / "deepseek-task-result.json").read_text())
            self.assertEqual(result["stop_reason"], "final-answer")
            self.assertEqual(result["usage"], {"input_tokens": 20, "cached_input_tokens": 0, "output_tokens": 10})
            self.assertEqual(result["final_message"], "all done")
            trajectory = json.loads((Path(tmp) / "logs" / "trajectory.json").read_text())
            self.assertEqual(trajectory["schema_version"], "ATIF-v1.8")
            self.assertEqual(trajectory["steps"][0]["message"], "Write hello world to /workspace/hello.txt.")

    def test_completion_marker_stops_the_loop(self):
        marker = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
        server = MockDeepSeek([tool_response([("bash", f"echo {marker}")])])
        with tempfile.TemporaryDirectory() as tmp:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            old = os.environ.get("DEEPSEEK_API_KEY")
            os.environ["DEEPSEEK_API_KEY"] = "sk-test"
            try:
                rc = driver.main([
                    "--model", "deepseek-v4-flash", "--instruction", "do the thing",
                    "--logs", str(tmp), "--api-base", f"http://127.0.0.1:{server.server_port}",
                    "--max-turns", "5",
                ])
            finally:
                if old is not None:
                    os.environ["DEEPSEEK_API_KEY"] = old
                else:
                    os.environ.pop("DEEPSEEK_API_KEY", None)
            server.shutdown()
            server.server_close()
            self.assertEqual(rc, 0)
            self.assertEqual(len(server.requests), 1)  # only one API round-trip
            result = json.loads((Path(tmp) / "deepseek-task-result.json").read_text())
            self.assertEqual(result["stop_reason"], "completion-marker")

    def test_missing_key_fails_fast(self):
        old = os.environ.pop("DEEPSEEK_API_KEY", None)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                rc = driver.main(["--model", "x", "--instruction", "t", "--logs", tmp])
            self.assertEqual(rc, 2)
        finally:
            if old is not None:
                os.environ["DEEPSEEK_API_KEY"] = old

    def test_run_bash_reports_exit_code_and_output(self):
        result = driver.run_bash("echo out && echo err 1>&2 && false", cwd=None)
        self.assertEqual(result["exit_code"], 1)
        self.assertIn("out", result["output"])
        self.assertIn("err", result["output"])


class MemorySeeding(unittest.TestCase):
    def test_upload_plan_lists_all_regular_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "memory"
            (root / "skills").mkdir(parents=True)
            (root / "MEMORY.md").write_text("# index\n- [x](skills/x.md)")
            (root / "skills" / "x.md").write_text("rule one")
            (root / ".hidden").write_text("must be ignored")
            os.symlink("MEMORY.md", root / "link.md")
            plan = driver.build_upload_plan(root)
            self.assertEqual([target for _, target in plan], ["MEMORY.md", "skills/x.md"])

    def test_entry_index_requires_nonempty_memory_md(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertFalse(driver.entry_index(root))  # missing
            (root / "MEMORY.md").write_text("")
            self.assertFalse(driver.entry_index(root))  # empty
            (root / "MEMORY.md").write_text("# index")
            self.assertTrue(driver.entry_index(root))

    def test_marker_detection(self):
        self.assertTrue(driver.find_completion_marker(
            "done\nCOMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT", "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"))
        self.assertFalse(driver.find_completion_marker("not yet", "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"))
        self.assertFalse(driver.find_completion_marker("anything", ""))  # empty marker disables detection


if __name__ == "__main__":
    unittest.main()
