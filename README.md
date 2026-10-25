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
- [ ] Adapter skeleton (Bun project + local pipeline tests)
- [ ] Smoke-corpus end-to-end run
- [ ] Full-corpus screening run + local score
- [ ] Official submission (3 independent runs, `frontier-memory bundle`, PR to letta-ai)

## Rules compliance notes

- Memory model: DeepSeek (extraction + curation) — memory model choice is free per rules.
- Task stage (fixed agents, not ours): task model per rules must be GPT-6 Sol or Opus 5.5.
- Web tools disabled in the memory client; no hosts beyond the model API.
- Every artifact pins the benchmark commit and corpus digest for trace review.
