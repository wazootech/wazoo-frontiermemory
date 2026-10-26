# Run 0002 — extraction throughput on real data

Date: 2026-10-26
Corpus: `~/workspace/frontier-corpus` (674 files), digest
`c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1` (all 674
checksums re-verified before the run). No corpus data is committed here.

## What ran

- The **real ingest path**: `extractClaimsForTrajectory` (the same function
  `runIngest` calls), instrumented with a new optional `onRun` telemetry
  callback (`src/extraction.ts`) that reports per-trajectory attempts,
  retries, token usage from the API, and fallback status. No simulation.
- Model: `deepseek-v4-flash` (the existing extraction default:
  `EXTRACTION_MODEL_DEFAULT`, `thinking: disabled`, temperature 0,
  `max_tokens` 4000, response_format `json_object`).
- Sample: 20 trajectories selected deterministically (seeded shuffle):
  11 PASS / 9 FAIL, all three formats (13 ATIF, 4 jsonl, 3 OpenCode),
  sizes from 3 KB to 17.7 MB of raw file, **including the 3 largest files in
  the corpus** (t0261, t0176, t0037).
- Concurrency: 4 (`runIngest`'s batched-Promise.all pattern).
- Command: `platform secrets run -- bun scripts/throughput-sample.ts
  <corpusDir> --sample 20 --concurrency 4` (DEEPSEEK_API_KEY from secrets).

## Headline: full corpus fits the 6-hour budget with ~6.5× margin

- Sample wall time (20 trajectories, concurrency 4): **98.2 s**.
- Linear extrapolation to 674 trajectories at the same concurrency:
  **≈ 0.92 h** (55 min).
- 6-hour budget: used ~15%. Threshold of concern (~4.5 h) is not approached;
  **no change to concurrency or settings is needed.** Concurrency 4 is in
  fact conservative — the per-call latency (median ~6 s) is dominated by
  single-call model latency, and 0 transport retries were observed, so
  concurrency 8 would likely halve the time if a run ever needs the headroom.

## Per-trajectory results

| trajId | format | outcome | prompt tok | compl tok | claims | attempts | wall s |
|-----------|------|------|----------:|--------:|-----:|---:|-----:|
| t0261 | atif | FAIL | 1,478,532 | 0 | 12* | 5 | 63.4 |
| t0176 | atif | FAIL | 19,078 | 1,063 | 10 | 1 | 6.0 |
| t0037 | atif | FAIL | 15,588 | 778 | 9 | 1 | 4.4 |
| t0026 | atif | PASS | 23,792 | 2,117 | 23 | 1 | 9.6 |
| t0527 | atif | PASS | 19,988 | 1,685 | 18 | 1 | 7.6 |
| t0309 | atif | PASS | 6,967 | 1,310 | 14 | 1 | 5.6 |
| t0330 | atif | PASS | 7,423 | 830 | 9 | 1 | 4.0 |
| t0230 | jsonl | FAIL | 4,128 | 1,294 | 15 | 1 | 6.1 |
| t0452 | jsonl | FAIL | 1,332 | 1,435 | 17 | 1 | 6.2 |
| t0061 | jsonl | FAIL | 26,254 | 878 | 11 | 1 | 4.8 |
| t0319 | jsonl | PASS | 5,332 | 1,353 | 14 | 1 | 6.1 |
| t0267 | opencode | FAIL | 18,086 | 1,490 | 18 | 1 | 6.5 |
| t0354 | opencode | PASS | 3,265 | 950 | 12 | 1 | 4.3 |
| t0520 | opencode | PASS | 4,657 | 1,404 | 15 | 1 | 5.8 |
| t0304 | atif | FAIL | 55,308 | 2,992 | 31 | 1 | 12.1 |
| t0103 | atif | FAIL | 23,917 | 1,470 | 17 | 1 | 6.5 |
| t0174 | atif | PASS | 38,141 | 1,860 | 21 | 1 | 8.6 |
| t0152 | atif | PASS | 15,823 | 1,647 | 19 | 1 | 7.6 |
| t0403 | atif | PASS | 18,158 | 1,796 | 17 | 1 | 7.6 |
| t0525 | atif | PASS | 1,611 | 846 | 7 | 1 | 3.9 |

\* t0261 fell back to the deterministic extractor — see below. Token counts
are the API-reported `usage` for every call that returned one; no estimate
was needed (every call reported usage).

## Totals

- Prompt tokens: **1,787,380** (of which 1,478,532 — 83% — is the single
  t0261 outlier).
- Completion tokens: **27,198**.
- Claims extracted: **309** (mean 15.5/trajectory; range 7–31; 15.5 mean
  across LLM-extracted trajectories, 12 from the fallback one).
- API attempts: 24 calls for 20 trajectories (1 main call each, +5 on the
  t0261 outlier). **Transport retries with backoff: 0.** Reprompts for
  unparseable JSON: 0. **Fallbacks: 1** (t0261).

## The one failure worth engineering around: t0261

t0261 is the corpus's largest file (17.7 MB, ATIF). Its rendered prompt is
~5.8 MB ≈ 1.48 M tokens, far beyond any sensible context. The run made 5
attempts, the API reported usage for 1.48 M prompt tokens with no usable
completion, and the trajectory fell back to the deterministic extractor
(12 claims). A full-corpus run would hit this on every oversized
trajectory, burning both time and prompt-token cost per attempt.

Recommendation for the real 674-trajectory generation run: cap the prompt.
`ExtractOptions.maxPromptEvents` already exists; setting it to ~200 events
keeps 95.8% of trajectories whole by event count (median trajectory is 28
events, p95 is 179, max is 518) and bounds every prompt within context;
the deterministic fallback still carries the tail. This does not change the
throughput verdict: at 0.92 h extrapolated, even with the cap the corpus
fits the budget with an order of magnitude of margin.

## Cost note

Token counts above are from API usage reports. Per-token pricing was not
part of this run's data, so no cost figure is stated here; the totals above
(≈ 60.2 M prompt tokens / ≈ 0.92 M completion tokens extrapolated to 674,
uncapped) are the inputs for that arithmetic.

## Reproduction

- Script: `scripts/throughput-sample.ts` (sample selection is seeded and
  printed per-trajectory with the summary).
- Telemetry: `ExtractionRunInfo` via `onRun` in `src/extraction.ts`
  (unit-tested; fires exactly once per trajectory, including fallbacks).
