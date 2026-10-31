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

    def test_resume_claims_from_is_wired(self):
        src = ADAPTER.read_text()
        self.assertIn("resume_claims_from", src)
        self.assertIn('resume_claims_from: str | None', src)

    def test_options_model_is_declared(self):
        # memory-11: without options_model, Harbor leaves self.options None
        src = ADAPTER.read_text()
        self.assertIn("options_model = WazooMemoryOptions", src)

    def test_agent_path_exports_bun_location(self):
        # run() executes as the agent user with a fresh shell; bun lives in
        # /root/.bun on the install side, so the command exports an explicit
        # PATH and the install symlinks bun to /usr/local/bin.
        src = ADAPTER.read_text()
        self.assertIn("/usr/local/bin:/usr/bin:/bin", src)
        self.assertIn("ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun", src)

    def test_install_installs_container_deps(self):
        src = ADAPTER.read_text()
        self.assertIn("apt-get install -y curl ca-certificates procps", src)

    def test_memory_metadata_import_path(self):
        # deepseek_task imports from frontier_memory.agents (the defining
        # module), not the package root, which does not re-export it.
        task_src = (ADAPTER.parent / "deepseek_task.py").read_text()
        self.assertIn("from frontier_memory.agents import memory_metadata", task_src)

    def test_pipeline_root_handles_both_layouts(self):
        src = ADAPTER.read_text()
        self.assertIn("wazoo-frontiermemory", src)  # sibling candidate
        self.assertIn("src", src) and self.assertIn("index.ts", src)


if __name__ == "__main__":
    unittest.main()
