"""Harbor task agent: DeepSeek as the TASK model, with a dream's memory seeded.

    frontier-memory run-tasks -a frontier_memory.agents.deepseek_task:DeepseekTaskAgent \
        -m deepseek/deepseek-v4-flash --memory jobs/<memory-job> -e modal -k 1 \
        --allow-host api.deepseek.com

The agent copies the memory folder into the task container the same way
``frontier_memory.agents.codex:MemoryCodex`` does (validated with
``frontier_memory.memory.check_memory``; every file uploaded under its relative
path, and ``frontier_memory.memory`` already guarantees a non-empty
``MEMORY.md`` entry point at the top of the folder). The driver
(``deepseek_driver.py``, standard library only — no ``openai`` SDK, no pip)
reads ``MEMORY.md`` first, then solves the task with a bash tool over
DeepSeek's OpenAI-compatible chat-completions endpoint, using ``urllib`` to
talk to ``api.deepseek.com`` and nothing else.

Web search is not a tool in this driver — there is nothing to disable — and
the only host contacted is ``api.deepseek.com``.

Usage metering: the driver sums every response's token counts into
``<logs>/deepseek-task-result.json``; ``populate_context_post_run`` moves those
numbers into the Harbor trial context.

**This harness is for LOCAL A/B evidence only.** Benchmark rules require the
task model to be GPT-6 Sol or Opus 5.5 for official runs; scores produced with
a DeepSeek task agent are NOT leaderboard-eligible. Its purpose is to answer
"does the memory help?" before spending task-model money.

On Ethan's machine this file pair is copied into the benchmark repo and run as:

    cp wazoo-frontiermemory/adapter/deepseek_task.py  src/frontier_memory/agents/deepseek_task.py
    cp wazoo-frontiermemory/adapter/deepseek_driver.py src/frontier_memory/agents/deepseek_driver.py
    frontier-memory run-tasks --tasks smoke/task \
        --harness frontier_memory.agents.deepseek_task:DeepseekTaskAgent \
        -m deepseek/deepseek-v4-flash -e modal -k 1 \
        --memory jobs/<memory-job> --allow-host api.deepseek.com
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, override

from pydantic import Field
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.models.agent.context import AgentContext

from frontier_memory import memory_metadata
from frontier_memory.memory import check_memory

REMOTE = "/opt/wazoo-deepseek-task"


class DeepseekTaskOptions(InstalledAgentOptions):
    memory_dir: str | None = Field(default=None, description="Host folder seeded into the task container.")
    max_turns: int = Field(default=50, gt=0, description="Tool-iteration cap per trial.")
    seconds: float = Field(default=0.0, ge=0, description="Driver wall-time budget; 0 defers to Harbor's timeout.")
    completion_marker: str | None = Field(default=None, description="Task completion marker; defaults to the benchmark convention.")


class DeepseekTaskAgent(BaseInstalledAgent):
    """DeepSeek chat-completions loop with a seeded memory, inside Harbor's container."""

    capabilities = AgentCapabilities(atif=True)
    options_model = DeepseekTaskOptions
    options: DeepseekTaskOptions

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        name = self.model_name or ""
        if name.startswith("deepseek/"):
            self._api_model = name[len("deepseek/"):]
        elif "/" in name:
            raise ValueError(f"wazoo-deepseek-task requires a deepseek/<model> handle, got {name!r}")
        else:
            self._api_model = name
        self._memory_dir = Path(self.options.memory_dir).expanduser().resolve() if self.options.memory_dir else None
        self._memory_report: dict[str, Any] | None = None
        if self._memory_dir is not None:
            self._memory_report = check_memory(self._memory_dir)
            if not self._memory_report["ok"]:
                raise ValueError(f"invalid memory {self._memory_dir}: {self._memory_report['errors']}")

    @staticmethod
    @override
    def name() -> str:
        return "wazoo-deepseek-task"

    async def install(self, environment) -> None:
        here = Path(__file__).resolve().parent
        await self.exec_as_root(environment, command=f"mkdir -p {shlex.quote(REMOTE)}")
        await environment.upload_file(here / "deepseek_driver.py", f"{REMOTE}/deepseek_driver.py")

    async def run(self, instruction: str, environment, context: AgentContext) -> None:
        key = self._get_env("DEEPSEEK_API_KEY")
        if not key:
            raise ValueError("DEEPSEEK_API_KEY is required for wazoo-deepseek-task")
        # Seed memory exactly the way MemoryCodex does: every file under its
        # relative path, owned by the agent user, cleaned up afterwards.
        remote_memory = f"{REMOTE}/memory"
        if self._memory_dir is not None and self._memory_report is not None:
            uploads = [(rel, rel) for rel in (entry["path"] for entry in self._memory_report["files"])]
            remote_dirs = sorted({(PurePosixPath(remote_memory) / target).parent.as_posix() for _, target in uploads})
            await self.exec_as_root(
                environment, command="mkdir -p " + " ".join(shlex.quote(d) for d in remote_dirs)
            )
            for source, target in uploads:
                await environment.upload_file(self._memory_dir / source, (PurePosixPath(remote_memory) / target).as_posix())
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment, command=f"chown -R {shlex.quote(str(environment.default_user))} {shlex.quote(REMOTE)}"
                )
        command = (
            f"python3 {REMOTE}/deepseek_driver.py"
            f" --model {shlex.quote(self._api_model)}"
            f" --instruction {shlex.quote(instruction)}"
            f" --logs {shlex.quote(str(self.environment_logs_dir))}"
            f" --max-turns {self.options.max_turns}"
        )
        if self._memory_dir is not None:
            command += f" --memory {shlex.quote(remote_memory)}"
        if self.options.seconds:
            command += f" --seconds {self.options.seconds}"
        if self.options.completion_marker:
            command += f" --completion-marker {shlex.quote(self.options.completion_marker)}"
        failed = False
        try:
            await self.exec_as_agent(environment, command=command, env={"DEEPSEEK_API_KEY": key})
        except BaseException:
            failed = True
            raise
        finally:
            # Persist usage/failure metadata even if the driver exits nonzero.
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            try:
                logs = str(self.environment_logs_dir)
                await environment.download_file(f"{logs}/deepseek-task-result.json", self.logs_dir / "deepseek-task-result.json")
                await environment.download_file(f"{logs}/trajectory.json", self.logs_dir / "trajectory.json")
                self.populate_context_post_run(context)
            except Exception:
                if not failed:
                    raise
                self.logger.warning("Could not collect DeepSeek driver metadata", exc_info=True)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "deepseek-task-result.json"
        if not path.is_file():
            return
        result = json.loads(path.read_text())
        usage = result.get("usage") or {}
        if usage.get("input_tokens"):
            context.n_input_tokens = usage["input_tokens"]
            context.n_output_tokens = usage.get("output_tokens")
            context.n_cache_tokens = usage.get("cached_input_tokens")
        context.metadata = {**(context.metadata or {}), "wazoo_deepseek_task": {
            "stop_reason": result.get("stop_reason"), "turns": result.get("turns"),
            **memory_metadata(self._memory_report),
        }}

