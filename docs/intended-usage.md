# FrontierMemory intended usage, verified from source

Study of letta-ai/frontiermemory (@ 9af28c2), letta-ai/letta-code, and the
letta-ai/letta shell, 2026-10-28. Every claim below was read from the cited
file, not inferred. Purpose: the practices our pipeline must follow because
Letta's own agents and reference adapters follow them.

## The contract

- Two stages. Memory generation: read the 674-trajectory corpus, write a
  memory folder, 6h limit, only the memory model's API host reachable, web
  tools off. Task: fixed task agents (Codex / Claude Code / Hermes) solve 15
  memory-dependent tasks with our memory; a no-memory control runs the same.
  Score is strict per-task pass on each task's verifier
  (`src/frontier_memory/score.py`: reward >= 1.0).
- Memory format (`src/frontier_memory/memory.py`, `check_memory`):
  free-form UTF-8 folder, <= 8 MiB, nonempty top-level `MEMORY.md`, no
  dotfiles or symlinks. There is no required structure beyond the entry file.

## What "intended usage" actually is

1. **Memory is written once, offline, before any task runs.** There is no
   online update and no sleep-time compute during eval. The benchmark tests
   pre-consolidation, not incremental memory. Our ingest/dream/export
   three-phase design matches this exactly.
2. **The dream instruction is the quality bar**
   (`src/frontier_memory/dream_task/instruction.md`): balance semantic
   curation with procedural skill extraction, and — binding on us — "do not
   copy final answers, patches, diff hunks, answer strings". Trace review
   invalidates submissions whose task trials look like they got answers from
   outside the memory (`docs/rules.md` §Submissions).
3. **Seed the native entry points of the fixed task agents.** The reference
   adapters show the convention:
   - `agents/codex.py`: seeds `$CODEX_HOME/memories/memory_summary.md`;
     a memory without that file gets `MEMORY.md` copied into it.
   - `agents/claude_code.py`: seeds Claude Code auto-memory
     (`MEMORY.md` under `$CLAUDE_CONFIG_DIR/projects/<project>/memory/`).
   - `agents/hermes.py`: exports `/learn` skills with a deterministic
     `MEMORY.md` index.
   Our `MEMORY.md` index + `skills/*.md` with "Use when:" descriptions
   matches the Hermes/sdk_dream shape. We now also export
   `memory_summary.md` so the Codex path gets the full index instead of an
   adapter-side fallback copy.
4. **Letta's own system is the same shape.** `letta-code` stores markdown
   memfs (top-level `MEMORY.md`, `src/agent/memory-format.ts`), reflection
   (sleep-time) writes to it on a step-count trigger
   (`src/cli/helpers/memory-reminder.ts`), and memory subagents render the
   `/memory/` tree for editing. Letta Dream ≈ offline reflection writing the
   format its own task harness reads natively. Our mirror of that: write the
   memory in the format the fixed task agents already read.
5. **Official submission mechanics** (`docs/submitting-a-harness.md`,
   `docs/rules.md`): a Harbor adapter package at
   `src/frontier_memory/agents/<name>/` in a PR to letta-ai; 3 independent
   runs (fresh memory each) x 3 attempts x 15 tasks; task model pinned to
   GPT-6 Sol or Opus 5.5; `frontier-memory bundle` with memory digest
   chaining (every task trial must reference the submitted memory's sha256);
   emailed to research@letta.com; Letta independently verifies.

## What this means for our pipeline (checklist)

- [x] Offline three-phase pipeline (ingest -> dream -> export), no runtime
      updates — already our design.
- [x] Imperative, instruction-shaped memory — already our dream thesis;
      the benchmark's own qualitative finding is that overfit summaries
      never trigger.
- [x] Self-validation against `check_memory` — ported in `src/validate.ts`.
- [x] Export `memory_summary.md` alongside `MEMORY.md` — added 2026-10-28
      (src/export.ts); test updated.
- [ ] Answer-artifact rejection beyond env facts: `dream.ts` rejects
      JSON/shell fragments in environment facts (PR #4) but task rules and
      user preferences should also be screened against the
      no-answers/no-diffs/no-hunks rule before export.
- [ ] Provenance wording: keep trajectory/turn/outcome inline (current) and
      make sure no rendered skill file ever contains a literal answer,
      patch, or diff hunk from the corpus.
- [ ] Official submission adapter (Harbor package) — `adapter/` is still
      DRAFT and local-A/B only; the official memory-agent adapter is a
      separate deliverable.
- [ ] Memory digest chaining on bundle day: our export already computes
      per-file sha256 (`validate.ts memoryDigest`); the bundle must
      reference the same digest through all 45 task trials.
