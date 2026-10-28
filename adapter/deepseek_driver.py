"""Task-driver loop for the Wazoo DeepSeek task agent (standard library only).

Runs INSIDE the Harbor task container as ``python3 deepseek_driver.py ...``.
It talks only to the DeepSeek OpenAI-compatible chat-completions endpoint with
``urllib`` (no ``openai`` SDK, no pip installs) and executes the agent's bash
commands locally with ``subprocess`` — the container's own shell, which is what
``environment.exec`` reaches from the host side.

What it does per trial:

1. Seeded memory: the Harbor agent copied the memory folder to ``--memory``
   (see ``deepseek_task.py``). The driver reads ``MEMORY.md`` FIRST and puts
   its content in the system prompt, then tells the model where the rest of
   the folder lives so it can open other files with its bash tool.
2. Agent loop: system prompt = generic task-agent instructions, user message
   = the task instruction, one tool (``bash``), at most ``--max-turns``
   iterations or ``--seconds`` of wall time.
3. Completion: if the instruction defines a completion marker (the benchmark
   convention is ``COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT``), the driver stops
   the loop as soon as that string shows up in a tool result or the final
   message. Otherwise it runs until the budget is spent and records the last
   assistant message as the final summary.
4. Metering: every chat-completions response's usage is summed and written to
   ``<logs>/deepseek-task-result.json``; a minimal ATIF trajectory goes to
   ``<logs>/trajectory.json``.

This harness is for LOCAL A/B evidence only. Scores from a DeepSeek task
agent are NOT leaderboard-eligible: the benchmark requires GPT-6 Sol or
Opus 5.5 for official task runs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ENTRY_FILE = "MEMORY.md"
DEFAULT_COMPLETION_MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
DEFAULT_API_BASE = "https://api.deepseek.com"
MAX_OUTPUT_CHARS = 20_000
RETRYABLE = {429, 500, 502, 503, 504}
SYSTEM_PROMPT = """You are a general task-solving agent working inside a Linux sandbox with a shell.

Solve the task given in the user message. Write and run code, inspect files, and
use whatever is installed in the container. Work step by step until the task is
done.

A memory folder written by another agent is mounted at {memory}. It contains
lessons and rules distilled from similar past tasks. Read it before starting
(the entry point is {entry}) and follow any rule in it that applies to this
task. The entry point's index points at the other files; open any of them with
your shell when its description looks relevant.

You have exactly one tool, `bash`: give it a shell command, it returns stdout,
stderr and the exit code. Finish by ensuring the task's required artifacts
exist on disk; the grader checks the filesystem, not your prose."""

MEMORY_PROMPT = "Memory folder: {memory}\nEntry point: {entry}\n(Its full text is included above.)"
NO_MEMORY_PROMPT = "No memory folder is mounted for this run."

TOOLS = [{
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Run a shell command inside the task container.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The shell command to run."}},
            "required": ["command"],
        },
    },
}]


def build_upload_plan(memory_root: Path) -> list[tuple[Path, str]]:
    """(source, relative target) pairs for every regular file in a memory folder.

    Mirrors what frontier_memory's ``check_memory`` accepts: regular UTF-8
    files, no dot-files. The caller uploads each to ``<remote>/<target>``.
    """
    plan: list[tuple[Path, str]] = []
    for path in sorted(memory_root.rglob("*")):
        if any(part.startswith(".") for part in path.relative_to(memory_root).parts):
            continue
        if path.is_file() and not path.is_symlink():
            plan.append((path, path.relative_to(memory_root).as_posix()))
    return plan


def entry_index(memory_root: Path) -> bool:
    """True when ``MEMORY.md`` exists at the top of the folder and is not empty."""
    entry = memory_root / ENTRY_FILE
    return entry.is_file() and not entry.is_symlink() and entry.read_text().strip() != ""


def find_completion_marker(text: str, marker: str) -> bool:
    return bool(marker) and marker in text


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated {len(text) - limit} chars]"


def run_bash(command: str, cwd: str | None) -> dict:
    try:
        proc = subprocess.run(["bash", "-lc", command], capture_output=True, text=True, cwd=cwd, timeout=600)
        return {"exit_code": proc.returncode, "output": _truncate((proc.stdout or "") + (proc.stderr or ""))}
    except subprocess.TimeoutExpired:
        return {"exit_code": 124, "output": "bash: command timed out after 600s"}
    except Exception as exc:  # noqa: BLE001 - surface anything to the model
        return {"exit_code": 1, "output": f"bash tool error: {exc}"}


def chat(api_base: str, key: str, model: str, payload: dict, attempts: int = 5) -> dict:
    """POST one chat-completions request, retrying transient failures."""
    url = f"{api_base.rstrip('/')}/chat/completions"
    body = json.dumps(payload).encode()
    backoff = 2.0
    last = ""
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}",
        })
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:500]}"
            if exc.code not in RETRYABLE or attempt == attempts:
                raise RuntimeError(f"DeepSeek API failed: {last}") from exc
        except Exception as exc:  # noqa: BLE001 - network layer, retry then raise
            last = f"{type(exc).__name__}: {exc}"
            if attempt == attempts:
                raise RuntimeError(f"DeepSeek API failed: {last}") from exc
        time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)
    raise RuntimeError(f"DeepSeek API failed: {last}")  # pragma: no cover


def assistant_tool_calls(message: dict) -> list[dict]:
    calls = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            arguments = {}
        calls.append({"id": call.get("id") or f"call_{len(calls)}",
                      "name": function.get("name") or "bash", "arguments": arguments})
    return calls


def atif_trajectory(instruction: str, steps: list[dict], model: str) -> dict:
    timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    trace = [{"source": "user", "message": instruction}, *steps]
    return {
        "schema_version": "ATIF-v1.8",
        "session_id": "deepseek-task-driver",
        "agent": {"name": "wazoo-deepseek-task", "version": "unknown", "model_name": model},
        "steps": [{"step_id": i, "timestamp": timestamp, **step} for i, step in enumerate(trace, start=1)],
        "extra": {"source": "deepseek_driver.py", "native_status": "completed"},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="DeepSeek model handle without a vendor prefix")
    parser.add_argument("--instruction", required=True, help="the task instruction text")
    parser.add_argument("--memory", default=None, help="remote path of the seeded memory folder")
    parser.add_argument("--logs", required=True, help="folder for result.json and trajectory.json")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--max-turns", type=int, default=50)
    parser.add_argument("--seconds", type=float, default=0.0, help="wall-time budget; 0 = none (Harbor enforces)")
    parser.add_argument("--completion-marker", default=DEFAULT_COMPLETION_MARKER)
    args = parser.parse_args(argv)

    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        print("deepseek_driver: DEEPSEEK_API_KEY is required", file=sys.stderr)
        return 2
    logs = Path(args.logs)
    logs.mkdir(parents=True, exist_ok=True)
    cwd = "/workspace" if os.path.isdir("/workspace") else None

    memory_note = NO_MEMORY_PROMPT
    entry_text = ""
    if args.memory:
        memory_root = Path(args.memory)
        if not entry_index(memory_root):
            print(f"deepseek_driver: no non-empty {ENTRY_FILE} at the top of {memory_root}", file=sys.stderr)
            return 2
        entry_text = (memory_root / ENTRY_FILE).read_text()
        memory_note = MEMORY_PROMPT.format(memory=memory_root, entry=memory_root / ENTRY_FILE)
    system_prompt = SYSTEM_PROMPT.format(memory=args.memory or "(none)", entry=ENTRY_FILE) + "\n\n" + memory_note
    if entry_text:
        system_prompt += f"\n\n{ENTRY_FILE} content:\n\n{entry_text}"

    messages: list[dict] = [{"role": "system", "content": system_prompt},
                            {"role": "user", "content": args.instruction}]
    usage = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    steps: list[dict] = []
    final = ""
    reason = "max-turns" if args.max_turns > 0 else "no-limit"
    deadline = time.monotonic() + args.seconds if args.seconds > 0 else None

    for turn in range(1, args.max_turns + 1):
        if deadline is not None and time.monotonic() >= deadline:
            reason = "time-budget"
            break
        payload = {"model": args.model, "messages": messages, "tools": TOOLS}
        response = chat(args.api_base, key, args.model, payload)
        choice = (response.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        counts = response.get("usage") or {}
        usage["input_tokens"] += int(counts.get("prompt_tokens") or 0)
        usage["cached_input_tokens"] += int((counts.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
        usage["output_tokens"] += int(counts.get("completion_tokens") or 0)
        calls = assistant_tool_calls(message)
        if not calls:
            final = message.get("content") or ""
            steps.append({"source": "agent", "message": final})
            reason = "final-answer"
            break
        steps.append({"source": "agent", "message": message.get("content") or "",
                      "tool_calls": [{"tool_call_id": c["id"], "function_name": c["name"],
                                      "arguments": c["arguments"]} for c in calls]})
        messages.append({"role": "assistant", "content": message.get("content") or "",
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"],
                                                      "arguments": json.dumps(c["arguments"])}} for c in calls]})
        for call in calls:
            command = str(call["arguments"].get("command") or "")
            result = run_bash(command, cwd)
            steps.append({"source": "tool", "name": "bash",
                          "observation": {"results": [{"source_call_id": call["id"],
                                                       "content": result["output"],
                                                       "extra": {"is_error": result["exit_code"] != 0,
                                                                 "exit_code": result["exit_code"]}}]}})
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": f"exit_code={result['exit_code']}\n{result['output']}"})
            if args.completion_marker and find_completion_marker(result["output"], args.completion_marker):
                final = result["output"]
                reason = "completion-marker"
                break
        if reason == "completion-marker":
            break
    else:
        reason = "max-turns"

    (logs / "deepseek-task-result.json").write_text(json.dumps({
        "model": args.model, "turns": len(steps), "stop_reason": reason, "usage": usage,
        "final_message": final, "memory_seeded": bool(args.memory),
        "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }, indent=2))
    (logs / "trajectory.json").write_text(json.dumps(atif_trajectory(args.instruction, steps, args.model), indent=2))
    print(f"deepseek_driver: stopped after {len(steps)} steps ({reason}); usage={usage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
