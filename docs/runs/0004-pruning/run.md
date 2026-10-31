# Run 0004 — evidence-thresholded pruning of the export layer

Date: 2026-10-31
State: `data/state-v11` (not committed; see `pruning-report.json` here for the
decision evidence). Branch: `arlo/pruning`, stacked on PR #13
(`arlo/family-export`, c753393) — pruning changes only what the #13 export
renders, it does not re-extract or re-dream.

## What ran

- `bun run src/index.ts export --state data/state-v11 --out data/memory-pruned`
- Self-validation passed (`memory_sha256 efa9672c…`).
- The full pruning decision report (one entry per curated item: verdict,
  reason code, family) is committed as `pruning-report.json` in this folder.

## Pruning policy (src/pruning.ts)

Verdicts per curated item, config-driven, fully deterministic (ties by
support desc, key asc):

| verdict | rule | renders as |
|---|---|---|
| index | support >= 3 | numbered rule / bullet with `[N trajs]` badge |
| index | support >= 2 with both PASS and FAIL evidence (contested-with-resolution) | same |
| index | support >= 2 all-PASS (verified-works) | same |
| index | always-keep: top-15 by support per kind; sole rule of a family with >= 5 trajectories | same |
| fail-caution | task rule, all evidence FAIL, support < 3 | one-line caution under the family's Known failures, capped 3 per family, chosen by most concrete claim text |
| skill-only | everything else (singletons with a PASS, thin mixed, unlabeled) | skill file only |

No item is deleted: all 2097 curated items keep their skill file with
provenance; the graph is untouched.

## Distribution (measured on state-v11 dream.json)

- taskRules: 535 total, 24 with support >= 3, 474 with support = 1
- userPreferences: 1008 total, 88 with support >= 3
- environmentFacts: 557 total, 49 with support >= 3
- Curated (deduped, answer-screened): 2097 items.

## Verdict buckets (this run)

- **index: 272** — 161 support>=3, 79 contested-with-resolution, 32
  verified-works (top-15 and sole-rule rescues never fired on this data:
  every kind's top-15 already sits at support >= 3).
- **fail-caution: 300** — 281 fail-only singles, 19 support-2 all-FAIL
  (`fail-repeat-caution`, an extension of the stated support=1 rule to the
  same negative-evidence species; documented in the PR).
- **skill-only: 1525** — 737 singletons with a PASS, 788 low-support.

## Before / after (same state, same caps)

| metric | before (#13) | after (pruned) |
|---|---|---|
| MEMORY.md lines | 231 | **177** |
| rendered item lines | 100 | **82** |
| MEMORY.md bytes | 18,264 | 25,822 (support badges) |
| folder bytes | 1,457,215 | 1,467,710 |
| folder files | 2099 | 2099 (nothing deleted) |

The pruned index drops 18 lines under the band ceiling while every rendered
line is now evidence-thresholded. The #13 per-section caps stay as the
render gate: with 272 index-eligible items the caps are what keeps the file
an index, and pruning is what decides *which* items compete for those slots
(previously support-1 singletons won slots).

Per-family rendered lines after pruning (rules / known-failure lines / env /
prefs): Agentic MCP 5/5/2/2; Repo work 5/6/2/2; DAPT pcap 2/5/2/2; Solver
speedup 2/5/2/2; SkillsBench ops 1/2/2/0; Word2Vec 0/0/1/2; General 6/5/4/4.
The dbt, BixBench, and ARC sections from #13 folded into the general section
under pruning: none of their curated items reached the index threshold.

## Tests

80 tests pass (68 pre-existing + 12 pruning additions): verdict rules,
top-15 always-keep (and its prohibition on promoting fail-only rules),
sole-rule rescue, determinism (verdicts + exported bytes), the 120–260 line
band on a state-v11-shaped synthetic corpus (measured 247), and no item
losing its skill file.
