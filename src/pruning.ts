/**
 * Evidence-thresholded pruning for the export layer ("cut, don't compress").
 *
 * The dream phase over a large corpus curates thousands of patterns, most
 * backed by a single trajectory. Rendering all of them turns MEMORY.md into
 * a dump; deleting them throws away negative evidence the benchmark's gold
 * memory keeps. Pruning is the export boundary between the two: it assigns
 * every curated item a verdict and only high-certainty items render in
 * MEMORY.md, while the graph (and every item's skill file) keeps everything.
 *
 * Verdicts:
 *   index        — renders in MEMORY.md (rules, preferences, environment).
 *   fail-caution — does NOT render as a rule; aggregated as a one-line
 *                  caution under its family's Known failures (one or two bad
 *                  runs is not a contract, but the lesson is worth a line).
 *   skill-only   — skill file only; never in MEMORY.md. No item is deleted.
 *
 * Every decision is deterministic: thresholds on (support, evidence
 * outcomes), always-keep rescues, and ties broken by (support desc, key asc).
 */

import type { DreamItem } from "./dream"

export interface PruningConfig {
  /** Minimum distinct supporting trajectories for an item to render. */
  minIndexSupport: number
  /** Minimum support for the contested-with-resolution and verified-works species. */
  speciesSupport: number
  /** Always-keep: the top N items by support per kind, whatever their evidence. */
  topPerKind: number
  /** Always-keep: a rule that is the only rule of a family with at least this many trajectories. */
  soleRuleFamilyTrajectories: number
  /** Max one-line fail cautions rendered per family's Known failures subsection. */
  failCautionsPerFamily: number
}

export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  minIndexSupport: 3,
  speciesSupport: 2,
  topPerKind: 15,
  soleRuleFamilyTrajectories: 5,
  failCautionsPerFamily: 3,
}

export type PruningVerdict = "index" | "fail-caution" | "skill-only"

/** Machine-readable reason codes; the pruning report's `reason` field. */
export const REASONS = {
  supportThreshold: "support-gte-3",
  contested: "contested-with-resolution",
  verifiedWorks: "verified-works",
  topPerKind: "top15-by-support",
  soleRule: "sole-rule-of-family",
  failSingle: "fail-only-single",
  failRepeat: "fail-repeat-caution",
  singleton: "singleton-pass",
  lowSupport: "low-support",
  noOutcome: "no-evidence-outcome",
} as const

export interface PruningDecision {
  key: string
  kind: DreamItem["kind"]
  support: number
  verdict: PruningVerdict
  reason: (typeof REASONS)[keyof typeof REASONS]
  /** Family id the item classifies into, when one exists. */
  family?: string
}

export interface PruningReport {
  config: PruningConfig
  summary: {
    total: number
    index: number
    failCaution: number
    skillOnly: number
    byReason: Record<string, number>
  }
  /** One entry per curated item, sorted by (kind, key) for stable diffs. */
  decisions: PruningDecision[]
}

export interface PruningContext {
  /** Family id for an item (may be undefined: item lands in the general section). */
  familyOf: (item: DreamItem) => string | undefined
  /** Distinct trajectories classified into each family id. */
  familyTrajectoryCounts: Map<string, number>
}

interface EvidenceShape {
  support: number
  fail: number
  pass: number
}

function shape(item: DreamItem): EvidenceShape {
  const fail = item.evidence.filter((e) => e.outcome === "FAIL").length
  const pass = item.evidence.filter((e) => e.outcome === "PASS").length
  return { support: item.support, fail, pass }
}

/** All evidence labeled FAIL, at least one entry. */
function allFail(s: EvidenceShape): boolean {
  return s.fail > 0 && s.pass === 0
}

/** All evidence labeled PASS, at least one entry. */
function allPass(s: EvidenceShape): boolean {
  return s.pass > 0 && s.fail === 0
}

/**
 * Assign a verdict to every item.
 *
 * High-certainty (index): support >= minIndexSupport; or, at speciesSupport,
 * contested-with-resolution (both PASS and FAIL evidence — the pattern was
 * tried, broke, and the fixed form won) or verified-works (all-PASS — the
 * pattern worked everywhere it was tried). Always-keep rescues: the top
 * `topPerKind` items by support per kind, and a rule that is the sole rule
 * of a family with >= soleRuleFamilyTrajectories trajectories (a small
 * family must not render empty for lack of recurrence).
 *
 * Fail-only cautions: task rules whose evidence is all FAIL below the index
 * threshold. A verified failure is not an instruction, so it never renders
 * as a rule; it renders as a caution line under Known failures (capped per
 * family at render time). support=1 is the "verified failed once" species;
 * support=2 is the same negative evidence, repeated — both caution, with
 * distinct reason codes.
 *
 * Everything else (singletons with any PASS, thin mixed evidence, unlabeled
 * evidence) is skill-only: it stays in the graph and on disk, just out of
 * the index.
 */
export function pruneItems(
  items: DreamItem[],
  context: PruningContext,
  config: PruningConfig = DEFAULT_PRUNING_CONFIG
): Map<string, PruningDecision> {
  const decisions = new Map<string, PruningDecision>()
  for (const item of items) decisions.set(item.key, decide(item, context, config))

  // Always-keep rescues, applied over the raw verdicts. Both operate on the
  // same (support desc, key asc) ordering so they cannot disagree.
  const byKind = new Map<DreamItem["kind"], DreamItem[]>()
  for (const item of items) {
    const list = byKind.get(item.kind) ?? []
    list.push(item)
    byKind.set(item.kind, list)
  }
  for (const [, list] of byKind) {
    list.sort(bySupportDesc)
    for (const item of list.slice(0, config.topPerKind)) {
      const decision = decisions.get(item.key)
      if (decision && decision.verdict === "skill-only") {
        decisions.set(item.key, {
          ...decision,
          verdict: "index",
          reason: REASONS.topPerKind,
        })
      }
    }
  }

  // Sole rule of a family with enough trajectories: rescue skill-only rules
  // so the family's Rules subsection is not starved. Fail-caution rules are
  // left alone: they already render as the family's caution lines, and
  // promoting a verified failure to an instruction would misstate it.
  const rulesPerFamily = new Map<string, DreamItem[]>()
  for (const item of items) {
    if (item.kind !== "task-rule") continue
    const family = context.familyOf(item)
    if (!family) continue
    const list = rulesPerFamily.get(family) ?? []
    list.push(item)
    rulesPerFamily.set(family, list)
  }
  for (const [family, rules] of rulesPerFamily) {
    if (rules.length !== 1) continue
    if ((context.familyTrajectoryCounts.get(family) ?? 0) < config.soleRuleFamilyTrajectories) {
      continue
    }
    const decision = decisions.get(rules[0].key)
    if (decision && decision.verdict === "skill-only") {
      decisions.set(rules[0].key, { ...decision, verdict: "index", reason: REASONS.soleRule })
    }
  }

  return decisions
}

function decide(
  item: DreamItem,
  context: PruningContext,
  config: PruningConfig
): PruningDecision {
  const s = shape(item)
  const family = context.familyOf(item)
  const base = { key: item.key, kind: item.kind, support: item.support, family }

  if (s.support >= config.minIndexSupport) {
    return { ...base, verdict: "index", reason: REASONS.supportThreshold }
  }
  if (s.support >= config.speciesSupport && s.fail > 0 && s.pass > 0) {
    return { ...base, verdict: "index", reason: REASONS.contested }
  }
  if (s.support >= config.speciesSupport && allPass(s)) {
    return { ...base, verdict: "index", reason: REASONS.verifiedWorks }
  }
  if (item.kind === "task-rule" && allFail(s) && s.support < config.minIndexSupport) {
    return {
      ...base,
      verdict: "fail-caution",
      reason: s.support === 1 ? REASONS.failSingle : REASONS.failRepeat,
    }
  }
  if (s.pass > 0) {
    // A singleton with a PASS: the pattern worked once. Skill file only —
    // one good run is a lead, not a rule.
    return { ...base, verdict: "skill-only", reason: REASONS.singleton }
  }
  if (s.fail === 0 && s.pass === 0) {
    return { ...base, verdict: "skill-only", reason: REASONS.noOutcome }
  }
  return { ...base, verdict: "skill-only", reason: REASONS.lowSupport }
}

/** Deterministic item ordering behind every cap and rescue: support desc, key asc. */
function bySupportDesc(a: DreamItem, b: DreamItem): number {
  return b.support - a.support || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/** Roll the decision map into the machine-readable report. */
export function pruningReport(
  decisions: Map<string, PruningDecision>,
  config: PruningConfig
): PruningReport {
  const all = [...decisions.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
  const byReason: Record<string, number> = {}
  let index = 0
  let failCaution = 0
  let skillOnly = 0
  for (const decision of all) {
    byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1
    if (decision.verdict === "index") index += 1
    else if (decision.verdict === "fail-caution") failCaution += 1
    else skillOnly += 1
  }
  return {
    config,
    summary: { total: all.length, index, failCaution, skillOnly, byReason },
    decisions: all,
  }
}
