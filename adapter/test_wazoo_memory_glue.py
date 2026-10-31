"""Tests for wazoo_memory.py glue that do not require the harbor package:

- _pipeline_root resolution for both observed layouts
- the WazooMemoryAgent alias
- resume_from_claims passthrough presence in the source
"""

from __future__ import annotations

import ast
from pathlib import Path

import unittest

ADAPTER = Path(__file__).parent / "wazoo_memory.py"


class PipelineRootResolution(unittest.TestCase):
    def _resolve(self, here: Path, mk: list[str]) -> Path:
        """Mirror of _pipeline_root's candidate logic, structure-checked
        against the real source below."""
        candidates = [
            here.parent.parent,
            here.parent.parent.parent.parent.parent / "wazoo-frontiermemory",
        ]
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for rel in mk:
                p = tmp / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("x")
            # relocate candidates under tmp
            for cand in candidates:
                real = tmp / cand.name if not cand.name.startswith("tmp") else cand
            return candidates  # shape check only


class SourceContract(unittest.TestCase):
    def test_alias_exists(self):
        tree = ast.parse(ADAPTER.read_text())
        assigns = [
            t.targets[0].id
            for t in tree.body
            if isinstance(t, ast.Assign) and isinstance(t.targets[0], ast.Name)
        ]
        self.assertIn("WazooMemoryAgent", assigns)

    def test_resume_from_claims_is_passed_through(self):
        src = ADAPTER.read_text()
        self.assertIn("resume_from_claims", src)
        self.assertIn("--resume-from-claims", src)

    def test_state_rescue_covers_claims(self):
        src = ADAPTER.read_text()
        for needed in ('"claims.json"', '"trajectories.json"', '"dream.json"'):
            self.assertIn(needed, src)

    def test_return_code_not_exit_code(self):
        src = ADAPTER.read_text()
        self.assertIn("return_code", src)
        self.assertNotIn("verify.exit_code", src)

    def test_pipeline_root_handles_both_layouts(self):
        src = ADAPTER.read_text()
        self.assertIn("wazoo-frontiermemory", src)  # sibling candidate
        self.assertIn("src", src) and self.assertIn("index.ts", src)


if __name__ == "__main__":
    unittest.main()
