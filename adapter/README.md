# adapter/ — DRAFT Harbor adapter

`wazoo_memory.py` is a draft Harbor `BaseInstalledAgent` following the same
shape as `letta-ai/frontiermemory`'s `agents/openai_sdk.py` (`install()` runs
with internet to stage Bun + the TFJS USE weights; `run()` is the 6-hour
generation window where only `api.deepseek.com` is reachable).

**This is not pushed to letta-ai.** When it is wired and tested against the
smoke task, it moves into that repo under
`src/frontier_memory/agents/wazoo/` via the harness-submission PR template.

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
