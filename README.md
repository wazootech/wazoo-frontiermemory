# wazoo-frontiermemory

Wazoo's memory agent for [FrontierMemory](https://github.com/letta-ai/frontiermemory)
(Letta Research, October 2026) — the benchmark that measures whether memory learned
from past agent trajectories improves downstream task performance, rather than
mere recall.

Full design and rationale: `wazootech/wazootech` issue tracker, FrontierMemory
integration issue.

## Why this benchmark, why this architecture

FrontierMemory's contract: a memory agent reads a fixed corpus of 674 labeled
trajectories and writes a memory folder (≤8 MiB, `MEMORY.md` entry point) that a
fixed task agent then uses on 15 memory-dependent tasks. During generation the
sandbox may contact only the memory model's API host — so the Wazoo engine runs
**embedded, in-process, with zero network**:

- `@worlds/sqlite` (bun:sqlite + FTS5 + sqlite-vec) for hybrid keyword + vector search
- `@wazoo/sparql-engine` for structured queries over claims
- TF.js Universal Sentence Encoder for local embeddings

Three phases inside the 6-hour window:

1. **Ingest** — extract facts from the trajectories into a `worlds:Claim` graph,
   each claim carrying provenance (trajectory id, turn, PASS/FAIL outcome).
2. **Dream** — curate via SPARQL + hybrid retrieval: failed-attempt patterns become
   task-contract rules, recurring user feedback becomes user-memory instructions,
   environment facts become pointer notes. FrontierMemory's own finding is that
   imperative, instruction-shaped memory transfers while overfit summaries never
   trigger — that is the thesis this agent is built to exploit.
3. **Export** — write `MEMORY.md` (imperative index), `skills/*.md` with
   "use when…" descriptions, provenance inline; self-validate against the
   benchmark's own format rules before finishing.

## Status

- [x] Benchmark contract verified from source (`docs/rules.md`, adapter code)
- [x] Design scoped (2026-10-25)
- [x] Repository created
- [x] Pipeline skeleton (2026-10-25, `docs/runs/0000-skeleton.md`): ingest → dream → export, tested against the upstream smoke corpus, no network in tests
- [ ] Extraction + curation quality loop (Phase 2) — needs a rotated DEEPSEEK_API_KEY
- [ ] Smoke-corpus end-to-end run on Modal/Docker (Phase 3)
- [ ] Full-corpus screening run + local score
- [ ] Official submission (3 independent runs, `frontier-memory bundle`, PR to letta-ai)

## Usage

Requires [Bun](https://bun.sh) >= 1.2.

```sh
bun install

# Deterministic end-to-end smoke run (no network) against the fixture corpus:
bun run src/index.ts all --corpus test/fixtures/corpus --out /tmp/memory \
  --state /tmp/state --fallback-only

# Real extraction against a corpus directory (DeepSeek; retries + deterministic
# fallback per trajectory):
DEEPSEEK_API_KEY=sk-... bun run src/index.ts all \
  --corpus /evidence/inputs --out memory --state data/state \
  --concurrency 8 --model-dir data/models/tfjs-use
```

Phases can run separately (`ingest`, `dream`, `export`); state is JSON
(`claims.json`, `dream.json`) plus the embedded SQLite claim graph under
`--state`. `export` self-validates the memory folder against the benchmark's
own format rules (ported in `src/validate.ts`, cross-checked against the
benchmark's Python `check_memory` in the test suite) and fails the run rather
than writing an invalid memory.

Inside the benchmark sandbox the only network host is the memory model's API
host (`api.deepseek.com`); TFJS USE weights must be pre-downloaded to
`--model-dir` during adapter setup (see `adapter/README.md`).

## DeepSeek task agent (local A/B only)

`adapter/deepseek_task.py` is a Harbor task agent that runs DeepSeek as the
**task** model, so we can measure whether the memory helps **before spending
task-model money** on GPT-6 Sol or Opus 5.5 runs. It seeds the dream's memory
the same way the benchmark's own `MemoryCodex` does, then drives a
standard-library-only loop (`adapter/deepseek_driver.py`, `urllib` to
`api.deepseek.com`, no `openai` SDK) whose only tool is a bash shell.

> **Not leaderboard-eligible.** Benchmark rules require the task model to be
> GPT-6 Sol or Opus 5.5 for official runs. Scores from this harness are local
> A/B evidence only. Web search is not a tool in this driver (there is
> nothing to disable), and the only host contacted is `api.deepseek.com`.

Local smoke tests (no Docker/Modal needed):

```sh
python3 -m unittest adapter/test_deepseek_task
```

The Harbor wiring itself needs Docker/Modal; see `docs/screening.md` for the
exact commands to run from Ethan's machine.

## Layout

- `src/` — the Bun/TypeScript pipeline (ingest → dream → export)
- `test/` — bun test suite; `test/fixtures/corpus/` is the upstream smoke
  trajectory pinned by SHA256
- `adapter/` — DRAFT Harbor adapter (not yet upstreamed)
- `docs/` — design notes, run records, score reports
- Runs in the benchmark happen on Modal (or Docker) — never assume this repo's
  development machine can reach Modal's gRPC control plane.

## Rules compliance notes

- Memory model: DeepSeek (extraction + curation) — memory model choice is free per rules.
- Task stage (fixed agents, not ours): task model per rules must be GPT-6 Sol or Opus 5.5.
- Web tools disabled in the memory client; no hosts beyond the model API.
- Every artifact pins the benchmark commit and corpus digest for trace review.
