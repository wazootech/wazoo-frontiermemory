# Run 0001 — corpus-wide parse validation

Date: 2026-10-26
Corpus: `~/workspace/frontier-corpus` (674 files), pinned by `SHA256SUMS`,
digest `c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1`.
All 674 files re-verified against the pin before this run (`sha256sum -c`,
0 mismatches). No corpus data is committed to this repo.

## What ran

- `src/corpus.ts` as of this branch: `parseTrajectoryFile` dispatches on
  extension and content shape. Parse only — no LLM calls, no network.
- Command: `bun scripts/parse-validate.ts <corpusDir>` (script in this repo;
  it prints the JSON stats this report summarizes).
- Versions: bun 1.3.x runtime, TypeScript 5.9, branch `feat/adapter-skeleton`.

## Result: 674 / 674 parsed (100%), 0 failures

Total rendered events: **30,969**. Verifier outcome detected for **every**
trajectory: **184 PASS / 490 FAIL / 0 unknown**.

The corpus is **three** formats, not the two the task brief described — the
558 `.json` files split into ATIF documents and 21 OpenCode session exports
(`{info, messages[]}`). Discovering the third format is part of this run's
finding; the parser now covers all three.

### Per-format counts

| Format     | Files | Events | PASS | FAIL | unknown |
|------------|------:|-------:|-----:|-----:|--------:|
| `jsonl`    |   116 |  4,203 |   28 |   88 |       0 |
| `atif`     |   537 | 26,230 |  153 |  384 |       0 |
| `opencode` |    21 |    536 |    3 |   18 |       0 |
| **total**  | **674** | **30,969** | **184** | **490** | **0** |

## Format notes discovered during validation

1. **ATIF spans more schema versions than v1.2**: 322 files are `ATIF-v1.7`,
   134 `ATIF-v1.2`, 64 `ATIF-v1.5`, 17 `ATIF-v1.6`. The step shape is stable
   across them; the parser keys on `steps[]`, not the version string. Agent
   mix: terminus-2 (179), claude-code (145), mini-swe-agent (100), codex (75),
   opencode (21), gemini-cli (17).
2. **The 116 `.jsonl` files are not one shape.** Two families:
   - Codex-style event stream (`type: response_item` payloads with
     `message` / `custom_tool_call` / `custom_tool_call_output`): 45 files.
     The verifier result is the final `response_item` message
     (`role: "user"`, text `# Verifier result\n\n<PASS|FAIL>`).
   - Flat dreambench-curation shape (top-level `text` on `user_message` /
     `agent_message` / `tool_call` records): 71 files, e.g.
     `{"metadata":{"schema":"dreambench-verifier-result-v1",...},"role":"user","text":"# Verifier result\n\nFAIL","type":"user_message"}`.
   Before this run the parser's outcome detection covered only the first
   family's shapes (and the smoke fixture), so 71 trajectories would have
   carried `unknown` outcomes into extraction; now all three text carriers
   (`message.content`, `payload[.message].content`, flat `text`) are checked
   and every file resolves.
3. **`event_msg` payloads are never extracted**: `task_complete`
   `.last_agent_message` duplicates the final assistant `response_item`
   message (verified 8/8 in a 20-file sample), and `token_count` /
   `reasoning` / `item_completed` are bookkeeping. Extracting them would
   double-count turns.
4. Tool-call shapes vary widely across agents (`command`, `cmd`, `input`,
   `file_path`, `query`, `pattern`, `url`, `title`, bare `keystrokes` …). The
   compact renderer picks the most telling argument per call; observations
   (`observation.results[].content` in ATIF, `custom_tool_call_output` in
   jsonl, tool-part `state.output` in OpenCode) are clipped to ~300 chars.
5. Outcome distribution is FAIL-heavy overall (490 vs 184); the split varies
   by family (event-stream jsonl: 28 PASS / 88 FAIL; ATIF: 153 / 384;
   OpenCode: 3 / 18).

## Verifier-marker coverage check

A scan of every file's final records confirmed each of the 674 trajectories
ends with (or contains exactly one) `# Verifier result` record: 537 ATIF
verifier user-steps (153 PASS / 384 FAIL), 116 jsonl verifier messages
(45 event-stream + 71 flat, 28 PASS / 88 FAIL), 21 OpenCode verifier
messages (3 PASS / 18 FAIL).

## Files

- Parser: `src/corpus.ts` (dispatch + ATIF + OpenCode + verifier detection)
- Validation script: `scripts/parse-validate.ts`
- Tests: `test/corpus.test.ts` — trimmed real ATIF fixture (`t0002`, first
  6 steps + verifier step, ~9 KB), a synthetic OpenCode fixture, and a
  mixed `.json` + `.jsonl` directory assertion.
