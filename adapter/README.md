# adapter/ — DRAFT Harbor adapter

Two DRAFT Harbor `BaseInstalledAgent` adapters following the same shape as
`letta-ai/frontiermemory`'s `agents/openai_sdk.py`:

- `wazoo_memory.py`: memory generation (`install()` runs with internet to
  stage Bun + the TFJS USE weights; `run()` is the 6-hour generation window
  where only `api.deepseek.com` is reachable).
- `deepseek_task.py` + `deepseek_driver.py`: a DeepSeek **task** agent for
  local A/B runs (memory seeded like `MemoryCodex`, stdlib driver loop, bash
  tool, token metering). Not leaderboard-eligible; see `docs/screening.md`.
  Tests: `python3 -m unittest adapter.test_deepseek_task` (mock HTTP server,
  no Docker/Modal needed).

**Neither is pushed to letta-ai.** When wired and tested against the smoke
task, they move into that repo under `src/frontier_memory/agents/` via the
harness-submission PR template. To use the DeepSeek task agent locally, copy
both files to that path and pass
`--harness frontier_memory.agents.deepseek_task:DeepseekTaskAgent`.

Known gaps before upstreaming:

- `--concurrency` is accepted by the CLI but the pipeline is currently
  sequential per trajectory (skeleton); parallel extraction lands with the
  Phase 2 quality loop.
- `_get_env` / secret pass-through semantics need verification against the
  Harbor version the benchmark pins.
- The TFJS USE download URLs in `install()` need to match the exact weights
  memorybench's `scripts/download-tfjs-use.ts` fetches (it also caches to a
  local model dir) — reuse that script's URLs, not hand-rolled ones.
- Web-tool disabling is structural here (no tools exist in the pipeline), but
  the submission must still state it explicitly in `SUBMISSION.json`.
