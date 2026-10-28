"""DRAFT Harbor adapter for the Wazoo memory agent.

Status: DRAFT, for review and later wiring — NOT yet registered upstream.
This file lives in our repo under `adapter/`; when it is ready it moves to
`src/frontier_memory/agents/wazoo/` in letta-ai/frontiermemory via the
harness-submission PR template. Nothing here is pushed to letta-ai.

Pattern: a Harbor `BaseInstalledAgent` (same shape as the repo's
`agents/openai_sdk.py`):

- `install()` runs during setup, where the internet IS available: installs
  Bun, uploads the pipeline source, and pre-downloads the TFJS Universal
  Sentence Encoder model. Everything the generation sandbox cannot fetch
  later must land here.
- `run()` is the 6-hour generation window, inside which only the memory
  model's API host (api.deepseek.com) is reachable. We exec the Bun pipeline
  (ingest -> dream -> export) with DEEPSEEK_API_KEY passed through.

Rules compliance notes:
- The pipeline contacts only api.deepseek.com. No web tools exist to disable:
  extraction is a plain chat-completions call with tools disabled, and the
  deterministic fallback extractor never touches the network at all.
- `run()` ends with the pipeline's export self-validation; a memory that
  fails the benchmark's own format rules raises before the phase completes,
  so a run cannot finish with an invalid memory folder.
- The agent never sees anything beyond /evidence/inputs/: the corpus path is
  mounted read-only by the task, and no task list is read.

Open questions before upstreaming (tracked in docs/runs/0000-skeleton.md):
- Does Harbor's exec env allow passing secrets, or must DEEPSEEK_API_KEY be
  materialized via the agent env file? (`_get_env` in the SDK agent suggests
  the latter.)
- Where should the TFJS model be cached across the three official runs?
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from pydantic import Field
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions

REMOTE = "/opt/wazoo-memory"
PIPELINE_ENTRY = f"{REMOTE}/src/index.ts"
TFJS_MODEL_DIR = f"{REMOTE}/models/tfjs-use"


class WazooMemoryOptions(InstalledAgentOptions):
    """Tunables for the memory-generation run."""

    # Extraction throughput inside the 6-hour budget: 674 trajectories is the
    # wall-clock risk, not a dollar risk. Measure on the smoke corpus first.
    concurrency: int = Field(default=8, gt=0)
    # Start deterministic (no LLM) only when explicitly asked; default is the
    # real extraction path with the deterministic fallback underneath.
    fallback_only: bool = False
    limit: int | None = Field(default=None, gt=0)


class WazooMemory(BaseInstalledAgent):
    """Runs the embedded Wazoo pipeline inside Harbor's container."""

    @staticmethod
    def name() -> str:
        return "wazoo-memory"

    def version(self) -> str:
        return "0.1.0"

    async def install(self, environment) -> None:
        """Setup phase: internet available. Install Bun and stage the pipeline."""
        install_cmd = (
            "set -eu; "
            "if ! command -v bun >/dev/null 2>&1; then "
            "curl -fsSL https://bun.sh/install | bash; fi; "
            f"export PATH=$HOME/.bun/bin:$PATH; "
            f"cd {REMOTE} && bun install --frozen-lockfile"
        )
        result = await self.exec_as_root(environment, command=install_cmd, timeout_sec=600)
        (self.logs_dir / "setup" / "bun-install.log").write_text(
            (result.stdout or "") + (result.stderr or "")
        )
        # The pipeline source (src/, package.json, bun.lock) is uploaded by the
        # harness framework from the adapter package directory; the TFJS USE
        # weights are fetched here because the generation sandbox cannot fetch
        # them (only the memory model's API host is allowed during run()).
        # URLs match memorybench's scripts/download-tfjs-use.ts exactly: the
        # USE lite graph is a model.json plus 7 weight shards, and the
        # vocabulary lives in a separate GCS bucket.
        model_cmd = (
            f"mkdir -p {TFJS_MODEL_DIR} && "
            "curl -fsSL -o " + f"{TFJS_MODEL_DIR}/model.json" + " "
            "'https://tfhub.dev/tensorflow/tfjs-model/universal-sentence-encoder-lite/1/default/1/model.json?tfjs-format=file' && "
            "curl -fsSL -o " + f"{TFJS_MODEL_DIR}/vocab.json" + " "
            "https://storage.googleapis.com/tfjs-models/savedmodel/universal_sentence_encoder/vocab.json && "
            + " && ".join(
                "curl -fsSL -o "
                + f"{TFJS_MODEL_DIR}/group1-shard{i + 1}of7"
                + " "
                + f"'https://tfhub.dev/tensorflow/tfjs-model/universal-sentence-encoder-lite/1/default/1/group1-shard{i + 1}of7?tfjs-format=file'"
                for i in range(7)
            )
        )
        model_result = await self.exec_as_root(environment, command=model_cmd, timeout_sec=900)
        (self.logs_dir / "setup" / "tfjs-model.log").write_text(
            (model_result.stdout or "") + (model_result.stderr or "")
        )
        # Fail the install if any weight is missing: a partial model loads
        # during run(), wastes part of the 6-hour window, and produces a
        # degraded embedding quality that is hard to notice from the outside.
        verify_cmd = (
            f"test -f {TFJS_MODEL_DIR}/model.json && "
            f"test -f {TFJS_MODEL_DIR}/vocab.json && "
            + " && ".join(
                f"test -f {TFJS_MODEL_DIR}/group1-shard{i + 1}of7" for i in range(7)
            )
        )
        verify = await self.exec_as_root(environment, command=verify_cmd, timeout_sec=60)
        if verify.exit_code != 0:
            raise RuntimeError(
                "TFJS USE model download incomplete; see setup/tfjs-model.log"
            )

    async def run(self, instruction: str, environment, context: Any) -> None:
        """Generation phase: only api.deepseek.com is reachable here."""
        key = self._get_env("DEEPSEEK_API_KEY")
        if not key:
            raise ValueError("DEEPSEEK_API_KEY is required for wazoo-memory")

        command = [
            "export PATH=$HOME/.bun/bin:$PATH;",
            "bun",
            "run",
            PIPELINE_ENTRY,
            "all",
            "--corpus",
            "/evidence/inputs",
            "--out",
            "/memory",
            "--state",
            f"{REMOTE}/state",
            "--model-dir",
            TFJS_MODEL_DIR,
            "--concurrency",
            str(self.options.concurrency),  # type: ignore[attr-defined]
        ]
        if self.options.fallback_only:  # type: ignore[attr-defined]
            command.append("--fallback-only")
        if self.options.limit is not None:  # type: ignore[attr-defined]
            command += ["--limit", str(self.options.limit)]

        failed = False
        try:
            await self.exec_as_agent(
                environment,
                command=" ".join(shlex.quote(part) if " " in part else part for part in command),
                env={"DEEPSEEK_API_KEY": key},
            )
        except BaseException:
            failed = True
            raise
        finally:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            # Collect the pipeline's own validation report for the bundle. The
            # pipeline writes it next to its state under --state; both the
            # state dir and the exported memory land under /opt/wazoo-memory,
            # readable by the agent user that ran the pipeline.
            try:
                await environment.download_file(
                    f"{REMOTE}/state/memory-validation.json",
                    self.logs_dir / "memory-validation.json",
                )
            except Exception:
                if not failed:
                    raise
                self.logger.warning("Could not collect memory validation report", exc_info=True)