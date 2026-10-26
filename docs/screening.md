# Screening-run runbook (Modal, run from Ethan's machine)

This agent's sandbox cannot reach Modal's gRPC control plane (verified 2026-10-25:
`modal` CLI fails through every available proxy mode; egress is HTTP/HTTPS-only).
The benchmark orchestration therefore runs on a machine with normal egress. This
document is the exact recipe. Commands verified against `src/frontier_memory/cli.py`
of letta-ai/frontiermemory (repo commit `49bea0f`).

## One-time setup (Ethan's machine)

```bash
git clone https://github.com/letta-ai/frontiermemory && cd frontiermemory
git clone https://github.com/wazootech/wazoo-frontiermemory
cp -r wazoo-frontiermemory/adapter/wazoo_memory.py src/frontier_memory/agents/wazoo_memory.py
# (until the harness-submission PR lands, the draft adapter rides in-tree)

uv venv --python 3.12 && source .venv/bin/activate
uv pip install -e .

export HF_TOKEN=...            # token for the gated corpus
export DEEPSEEK_API_KEY=...    # memory model (our pipeline's client)
export OPENAI_API_KEY=...      # task agent (gpt-6-sol via codex harness)
modal token new                # or MODAL_TOKEN_ID/MODAL_TOKEN_SECRET
```

**Corpus revision matters:** the benchmark pins corpus digest
`c7d31214…`, but the HF dataset's `main` branch is now v1.1 (2026-10-24) and does
NOT match. `fetch-corpus` defaults to `main`, so pass `--revision v1.0`
explicitly. (`fetch-corpus` verifies every file and refuses on digest mismatch.)

```bash
frontier-memory fetch-corpus --out data/corpus/joint-674 --revision v1.0
```

## The three commands (screening, memory-only submission)

```bash
# 1) Memory generation: our pipeline inside the Harbor sandbox,
#    only api.deepseek.com reachable. ~1h expected (measured extrapolation
#    0.92h at concurrency 4; budget is 6h).
frontier-memory generate-memory --corpus data/corpus/joint-674 \
  --harness frontier_memory.agents.wazoo_memory:WazooMemoryAgent \
  -m deepseek/deepseek-v4-flash \
  --allow-host api.deepseek.com \
  -e modal --job-name wazoo-screen-memory-1

# 2) Task stage with that memory: fixed codex agent, GPT-6 Sol, 3 attempts.
frontier-memory run-tasks --harness codex -m openai/gpt-6-sol \
  --memory jobs/wazoo-screen-memory-1 \
  -e modal -k 3 --job-name wazoo-screen-tasks-1

# 3) No-memory control (same settings, no --memory) for the delta.
frontier-memory run-tasks --harness codex -m openai/gpt-6-sol \
  -e modal -k 3 --job-name wazoo-screen-control-1

# Then, locally:
frontier-memory check-memory jobs/wazoo-screen-memory-1
frontier-memory score jobs/wazoo-screen-tasks-1
frontier-memory score jobs/wazoo-screen-control-1
```

Notes:
- The exact DeepSeek model handle (`deepseek/…`) should be confirmed against
  litellm's slug for the model our extraction config used locally before
  running step 1; `-m` is what the submission records, while the pipeline
  itself authenticates via `DEEPSEEK_API_KEY`.
- `-k 3` is the rules-mandated 3 attempts per task. Screening is 15 tasks × 3
  attempts × 2 (memory + control).
- Official submission later: 3 independent runs of all of the above, each with
  fresh memory generation, plus `frontier-memory bundle` per run.
