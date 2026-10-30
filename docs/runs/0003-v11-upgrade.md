# Run 0003 — FrontierMemory 1.1 upgrade

Date: 2026-10-30

## What changed upstream

Per the FrontierMemory changelog (2026-10-29): the leaderboard corpus is now
**v1.1 — 750 trajectories** (was 674), rebalanced "to reduce reward hacking
through trajectory metadata and balance out the corpus sources." All published
model/harness results were rerun on v1.1 with three independent runs each;
leaderboard scores are now the mean of three runs with ±1 stdev error bars.
Separately (2026-10-27): DeepSeek V4.1 Flash was added to the model leaderboard —
the memory model our pipeline uses is now a leaderboard-ranked model on its own
merits.

The public benchmark repo (HEAD 9af28c2, 2026-10-27) still pins the v1.0 corpus
in `RELEASE_SHA256` but now defaults `fetch-corpus` to the pinned revision
(upstream fix for the main-branch drift we hit on 2026-10-25). Rules, task set,
and the Harbor adapter contract are unchanged by the diff — no code changes were
needed on our side for the upgrade.

## What changes for us

- Every run targets `--revision v1.1` (750 trajectories). Expected extraction
  cost scales ~750/674 from run 0002's measurements: ~1.0h at concurrency 4
  against the 6-hour generation budget.
- The claim state from the v1.0 run (11,004 claims) is kept for comparison but is
  NOT the submission basis; the v1.1 corpus gets a fresh full extraction and a
  fresh memory generation. Local A/B (memory vs no-memory control, DeepSeek task
  agent from #3) reruns on the new corpus.
- The Letta email drops the fetch-corpus bug report (fixed upstream by their
  2026-10-27 PR) and keeps the harness intro + task-stage compute question.

## Status

- [x] Benchmark repo re-cloned at HEAD; contract diff checked (none affecting us)
- [ ] v1.1 corpus fetched and checksum-verified (in flight)
- [ ] Full v1.1 extraction (DeepSeek, concurrency 4)
- [ ] Dream + export on v1.1 claims
- [ ] DeepSeek A/B commands updated for Ethan (issue #11 refresh)
