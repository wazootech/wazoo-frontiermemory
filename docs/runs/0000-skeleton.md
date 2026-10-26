# Run 0000 — adapter skeleton

- **Date:** 2026-10-25
- **Scope:** Phase 1 of the integration plan (`~/Documents/frontiermemory-integration-scope.md`): pipeline skeleton + smoke-corpus proof, no benchmark runs (no Docker/Modal on this machine).
- **Corpus:** `smoke/corpus` from letta-ai/frontiermemory, trajectory `claude-code-intro.jsonl`, pinned by SHA256 `74feb99375be89e406b71d2e1a9530c3c328ca975b37987ae26e2aff6aed2dd8` (fixture copied to `test/fixtures/corpus/`, hash asserted in `test/corpus.test.ts`).

## Package versions

Toolchain:

- bun 1.4.4 (sandbox; adapter installs current Bun in-container)
- typescript ^5.9.3, prettier ^3.7.4

Dependencies (bun.lock pins exact resolutions):

| Package | Spec | Resolved |
| --- | --- | --- |
| @worlds/sdk | npm:@jsr/worlds__sdk@^0.9.0 | 0.9.x |
| @worlds/sqlite | npm:@jsr/worlds__sqlite@^0.7.1 | 0.7.3 |
| @wazoo/sparql-engine | npm:@jsr/wazoo__sparql-engine@^0.4.2 | 0.4.x (via @worlds/sqlite) |

JSR packages resolve through `@jsr:registry=https://npm.jsr.io` (`.npmrc`);
`bunfig.toml` pins `minimumReleaseAge = 604800` like wazoo-memorybench.

## What was built

- `src/corpus.ts` — parses the real trajectory JSONL format (Claude Code
  transcript events), tolerant verifier-result detection (`PASS`/`FAIL`), 1-indexed turns.
- `src/extraction.ts` — DeepSeek extraction (OpenAI-compatible endpoint,
  `thinking: disabled` top-level, `response_format: json_object`, bounded
  retries) + deterministic keyword fallback extractor. Provenance on every
  claim: `trajId`, `turn`, `outcome`, `extractor`.
- `src/graph.ts` — `worlds:Claim` quads serialized as Turtle and imported
  into embedded `@worlds/sqlite` (bun:sqlite + FTS5 + sqlite-vec, zero
  network). Deterministic 256-dim hash embeddings for offline/test runs;
  TFJS USE (512-dim) when `--model-dir` points at local weights.
- `src/dream.ts` — SPARQL selection + provenance joins, clustering into
  task rules (FAIL-weighted), user preference sequences, environment facts;
  hybrid search probe per pattern kind.
- `src/export.ts` — `MEMORY.md` imperative index + `skills/*.md` with
  "Use when:" descriptions and inline provenance; self-validates before finishing.
- `src/validate.ts` — faithful TS port of the benchmark's
  `src/frontier_memory/memory.py::check_memory` (dotfiles, symlinks, UTF-8,
  8 MiB, nonempty MEMORY.md, memory_digest). `test/validate.test.ts`
  cross-checks the port against the actual Python `check_memory()` from the
  local benchmark clone, including the SHA-256 `memory_sha256` digest.

## Verification

- `bun run typecheck` — clean.
- `bun test` — 31 tests pass against the real smoke trajectory, no network.
- `bun run format:check` — clean.
- End-to-end CLI smoke (deterministic mode):
  `bun run src/index.ts all --corpus test/fixtures/corpus --out /tmp/smoke-memory --state /tmp/smoke-state --fallback-only`
  → 15 claims, 2 task rules / 3 user preferences / 8 environment facts,
  14-file memory, self-validation ok.

## Not done here (by design)

- No benchmark runs: no Docker/Modal on this machine (Phase 3 needs Modal
  credentials or a Docker host).
- No real DeepSeek extraction run yet: the current key 401s at DeepSeek
  itself; rotation pending (scope doc decision 1).
- No upstream PR to letta-ai: `adapter/wazoo_memory.py` is a draft kept here.
