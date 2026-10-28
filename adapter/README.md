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

Resolved (2026-10-28, against harbor==0.24.0 source):

- `_get_env` / secret pass-through: `_resolve_env` checks, in order, the
  options' `Env`-annotated fields, the agent's `extra_env` kwarg, and the
  host `os.environ`; `exec_as_agent(env=...)` passes per-exec env straight
  into `environment.exec`. Passing `DEEPSEEK_API_KEY` via `env=` in
  `exec_as_agent` is correct and matches the openai_sdk reference.
- TFJS USE URLs now match `scripts/download-tfjs-use.ts` exactly
  (model.json + 7 shards from tfhub.dev, vocab.json from GCS), and
  `install()` verifies all nine files exist before run().
- The pipeline source upload was missing (the old comment claimed the
  harness framework did it — it does not): `install()` now uploads
  package.json/bun.lock/bunfig.toml/tsconfig.json plus the whole src/ tree
  to $REMOTE, the same way upstream adapters upload their drivers.
- Web-tool disabling is structural here (no tools exist in the pipeline), but
  the submission must still state it explicitly in `SUBMISSION.json`.
