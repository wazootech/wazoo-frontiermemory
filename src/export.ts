/**
 * Export: write the memory folder and self-validate it against the
 * benchmark's own format rules before finishing.
 *
 * Layout (everything beyond `MEMORY.md` is free per docs/rules.md, so we
 * use it):
 *
 *   MEMORY.md          — nonempty imperative index, organized task-family
 *                        first: one section per recurring task family (rules,
 *                        known failures, family environment facts), then the
 *                        general rules that apply everywhere. Task agents load
 *                        this first, so every line is an instruction or a
 *                        pointer, never a summary of the corpus.
 *   skills/<slug>.md   — one file per curated pattern with a "Use when:"
 *                        description (skill-loading is picky; descriptions
 *                        are how files get opened), inline provenance, and,
 *                        for a family's top patterns, resolving details: the
 *                        most concrete supporting claim texts (exact params,
 *                        error strings, file paths).
 *
 * Pruning (src/pruning.ts) gates what renders: only evidence-thresholded
 * high-certainty items carry MEMORY.md lines (each with a compact support
 * badge), verified-failure singletons render as capped one-line cautions
 * under their family's Known failures, and everything else stays in its
 * skill file only. No item is deleted from the graph, and every decision is
 * written to a machine-readable pruning report.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkMemory, ENTRY_FILE, SUMMARY_FILE, type ValidationReport } from "./validate"
import type { DreamItem, DreamReport } from "./dream"
import { isAnswerArtifact, jaccardSimilarity } from "./dream"
import {
  FAMILIES,
  buildTrajectoryFamilies,
  classifyClaimText,
  familyForItem,
  familyForPreference,
  type Family,
  type FamilyClaim,
} from "./families"
import {
  DEFAULT_PRUNING_CONFIG,
  type PruningConfig,
  type PruningDecision,
  type PruningReport,
  pruneItems,
  pruningReport,
} from "./pruning"

export interface ExportOptions {
  /** Include per-claim provenance lines in skill files (default true). */
  provenance?: boolean
  /** Max curated items per kind written to MEMORY.md's general section. */
  maxIndexItems?: number
  /** Overrides for the evidence-thresholded pruning config (src/pruning.ts). */
  pruning?: Partial<PruningConfig>
  /**
   * Claims for family classification (evidence-trajectory fingerprints) and
   * resolving details. Optional: without them, items classify by their own
   * claim text and resolving details are skipped.
   */
  claims?: FamilyClaim[] | undefined
}

const KIND_LABEL: Record<DreamItem["kind"], string> = {
  "task-rule": "Rules",
  "user-preference": "User preferences",
  "environment-fact": "Environment",
}

const KIND_FILE_PREFIX: Record<DreamItem["kind"], string> = {
  "task-rule": "rule",
  "user-preference": "preference",
  "environment-fact": "environment",
}

/** Caps that keep MEMORY.md an index, not a dump (roughly 200 lines). */
const CAPS = {
  familyRules: 5,
  familyFailures: 3,
  familyEnv: 2,
  familyPrefs: 2,
  generalRules: 6,
  generalPrefs: 4,
  generalEnv: 4,
} as const

/** Families with fewer curated items than this fold into the general section. */
const MIN_FAMILY_ITEMS = 3

/**
 * The pruning layer's per-family cap on fail-only caution lines (rules that
 * failed every run they appeared in, below the index threshold). The
 * majority-FAIL rules above the threshold keep the CAPS.familyFailures cap.
 */
const FAIL_CAUTIONS_PER_FAMILY = DEFAULT_PRUNING_CONFIG.failCautionsPerFamily

/** A family needs this many curated rules before top items get resolving details. */
const MIN_FAMILY_RULES_FOR_DETAILS = 5

/** How many of a family's top-supported items get resolving details. */
const DETAIL_ITEMS_PER_FAMILY = 5

export function skillFileName(item: DreamItem, ordinal: number): string {
  const slug =
    item.key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "pattern"
  return `${KIND_FILE_PREFIX[item.kind]}-${String(ordinal).padStart(2, "0")}-${slug}.md`
}

function evidenceLines(item: DreamItem, max = 5): string[] {
  return item.evidence
    .slice(0, max)
    .map(
      (e) => `- Source: trajectory \`${e.trajId}\`, turn ${e.turn} (verifier result: ${e.outcome})`
    )
}

function useWhen(item: DreamItem): string {
  switch (item.kind) {
    case "task-rule":
      return "Use when performing the task, before acting — these are working rules the user enforced."
    case "user-preference":
      return "Use when choosing output format, style, naming, or anything the user expressed a preference about."
    case "environment-fact":
      return "Use when locating files, configs, or commands in this environment."
  }
}

/**
 * Concreteness ranking for resolving details: the goal is the claim text
 * that pins the rule down — exact parameters, error strings, file paths —
 * over a paraphrase. Scored by visible concreteness markers, longest first
 * as the tie-break, fully deterministic.
 */
function concreteness(text: string): number {
  let score = 0
  if (/\d/.test(text)) score += 2
  if (/\/[\w./@+-]{2,}/.test(text)) score += 2
  if (/["'`][^"'`]{3,}["'`]/.test(text)) score += 2
  if (/\b(?:error|failed|reject|return|must be|requires)\b/i.test(text)) score += 1
  return score
}

/**
 * Resolving details for one item: the claim texts most similar to the
 * item's own rule text (same pattern, more specific phrasing) that carry
 * concrete parameters, ranked by concreteness. Bounded by the evidence
 * (trajId, turn) pairs so a detail can never come from an unrelated run.
 */
export function resolvingDetails(item: DreamItem, claims: FamilyClaim[], max = 3): string[] {
  const evidenceKeys = new Set(item.evidence.map((e) => `${e.trajId}/${e.turn}`))
  const candidates: Array<{ text: string; score: number }> = []
  for (const claim of claims) {
    if (!evidenceKeys.has(`${claim.trajId}/${claim.turn}`)) continue
    if (jaccardSimilarity(claim.claimText, item.text) < 0.75) continue
    const text = claim.claimText.replace(/\s+/g, " ").trim()
    if (text.length === 0 || text === item.text) continue
    candidates.push({ text, score: concreteness(text) })
  }
  return candidates
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.text.length - a.text.length ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
    )
    .slice(0, max)
    .map((c) => c.text)
}

function renderSkill(item: DreamItem, file: string, details: string[] = []): string {
  const lines: string[] = []
  lines.push(`# ${item.instruction}`, "")
  lines.push(`**Use when:** ${useWhen(item)}`, "")
  lines.push(item.text, "")
  lines.push(`Pattern key: \`${item.key}\`  ·  Supporting trajectories: ${item.support}`)
  if (details.length > 0) {
    lines.push("", "## Resolving details", "")
    for (const detail of details) lines.push(`- ${detail}`)
  }
  if (item.evidence.length > 0) {
    lines.push("", "## Provenance", "")
    lines.push(...evidenceLines(item))
  }
  lines.push("", `<!-- exported as ${file} -->`, "")
  return lines.join("\n")
}

interface FamilySection {
  family: Family
  rules: DreamItem[]
  knownFailures: DreamItem[]
  /** Fail-only items (verdict fail-caution): one-line cautions, capped per family. */
  failCautions: DreamItem[]
  preferences: DreamItem[]
  envFacts: DreamItem[]
}

/** A rule is a verified-FAIL pattern when FAIL evidence outnumbers PASS. */
function isMajorityFail(item: DreamItem): boolean {
  const fail = item.evidence.filter((e) => e.outcome === "FAIL").length
  const pass = item.evidence.filter((e) => e.outcome === "PASS").length
  return fail > 0 && fail > pass
}

function failCounts(item: DreamItem): { fail: number; total: number } {
  const fail = item.evidence.filter((e) => e.outcome === "FAIL").length
  const pass = item.evidence.filter((e) => e.outcome === "PASS").length
  return { fail, total: fail + pass }
}

/**
 * Item ranking for section caps and detail eligibility: support first (how
 * many distinct trajectories back the pattern), then FAIL-weighted evidence
 * (failures carry the sharpest lessons), then a stable key tie-break.
 */
function itemRank(item: DreamItem): number {
  const fail = item.evidence.filter((e) => e.outcome === "FAIL").length
  const pass = item.evidence.filter((e) => e.outcome === "PASS").length
  return item.support * 1000 + fail * 2 + pass
}

function byRank(a: DreamItem, b: DreamItem): number {
  return (
    itemRank(b) - itemRank(a) ||
    a.key.localeCompare(b.key) ||
    (a.instruction < b.instruction ? -1 : a.instruction > b.instruction ? 1 : 0)
  )
}

interface Organized {
  sections: FamilySection[]
  general: {
    rules: DreamItem[]
    preferences: DreamItem[]
    envFacts: DreamItem[]
    failCautions: DreamItem[]
  }
}

/**
 * Group curated items into family sections plus a general remainder.
 * Families by curated item count (descending, then name); families below
 * MIN_FAMILY_ITEMS fold their items into the general section.
 *
 * With a pruning decision map (src/pruning.ts), only index-verdict items
 * organize into MEMORY.md sections; fail-caution items attach to their
 * family as one-line cautions under Known failures (ordered by concreteness
 * of the pattern's claim text, capped at render time); skill-only items are
 * left out of the index entirely — their skill files still export. Without
 * pruning decisions the call keeps its pre-pruning behavior: every curated
 * item organizes.
 */
export function organizeByFamily(
  report: DreamReport,
  claims?: FamilyClaim[],
  pruning?: Map<string, PruningDecision>
): Organized {
  const allItems = curatedItems(report)
  const trajectoryFamilies = claims
    ? buildTrajectoryFamilies(claims)
    : new Map<string, string | undefined>()

  const familyOf = (item: DreamItem, kind: DreamItem["kind"]): string | undefined => {
    if (trajectoryFamilies.size > 0) {
      return kind === "user-preference"
        ? familyForPreference(item, trajectoryFamilies)
        : familyForItem(item, trajectoryFamilies)
    }
    // Degrade gracefully without a claim list: classify the item's own text.
    return classifyClaimText(`${item.instruction} ${item.text}`)
  }

  const rendered = pruning
    ? allItems.filter((item) => pruning.get(item.key)?.verdict === "index")
    : allItems
  const cautions = pruning
    ? allItems.filter((item) => pruning.get(item.key)?.verdict === "fail-caution")
    : []

  const byFamily = new Map<string, FamilySection>()
  for (const family of FAMILIES) {
    byFamily.set(family.id, {
      family,
      rules: [],
      knownFailures: [],
      failCautions: [],
      preferences: [],
      envFacts: [],
    })
  }
  const general: Organized["general"] = {
    rules: [],
    preferences: [],
    envFacts: [],
    failCautions: [],
  }
  const place = (item: DreamItem): void => {
    const familyId = familyOf(item, item.kind)
    const section = familyId ? byFamily.get(familyId) : undefined
    if (!section) {
      if (item.kind === "task-rule") general.rules.push(item)
      else if (item.kind === "user-preference") general.preferences.push(item)
      else general.envFacts.push(item)
      return
    }
    if (item.kind === "task-rule") {
      section.rules.push(item)
      if (isMajorityFail(item)) section.knownFailures.push(item)
    } else if (item.kind === "user-preference") {
      section.preferences.push(item)
    } else {
      section.envFacts.push(item)
    }
  }
  for (const item of rendered) place(item)
  // Fail-only items carry a family section's caution lines. Ordering puts
  // repeated failures first: a caution backed by multiple failed runs is a
  // pattern, a 1-of-1 is an anecdote — the latter renders only when slots
  // remain, so single-run noise cannot crowd out real negative evidence.
  const evidenceCountOf = (i: DreamItem): number => i.evidence.length
  const cautionOrder = (a: DreamItem, b: DreamItem): number =>
    evidenceCountOf(b) - evidenceCountOf(a) ||
    concreteness(b.text) - concreteness(a.text) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  for (const item of [...cautions].sort(cautionOrder)) {
    const familyId = familyOf(item, item.kind)
    const section = familyId ? byFamily.get(familyId) : undefined
    if (!section) {
      general.failCautions.push(item)
      continue
    }
    section.failCautions.push(item)
  }

  const itemsOf = (s: FamilySection): number =>
    s.rules.length + s.preferences.length + s.envFacts.length
  const sections = [...byFamily.values()]
    .filter((s) => itemsOf(s) >= MIN_FAMILY_ITEMS)
    .sort((a, b) => itemsOf(b) - itemsOf(a) || a.family.name.localeCompare(b.family.name))
  // Fold below-threshold families back into the general section, cautions
  // included: a folded family's failures still render, under general.
  for (const section of byFamily.values()) {
    if (itemsOf(section) >= MIN_FAMILY_ITEMS) continue
    general.rules.push(...section.rules)
    general.preferences.push(...section.preferences)
    general.envFacts.push(...section.envFacts)
    general.failCautions.push(...section.failCautions)
  }
  general.rules.sort(byRank)
  general.preferences.sort(byRank)
  general.envFacts.sort(byRank)
  general.failCautions.sort(cautionOrder)
  for (const section of sections) {
    section.rules.sort(byRank)
    section.knownFailures.sort(byRank)
    section.failCautions.sort(cautionOrder)
    section.preferences.sort(byRank)
    section.envFacts.sort(byRank)
  }
  return { sections, general }
}

function curatedItems(report: DreamReport): DreamItem[] {
  const allItems: DreamItem[] = []
  const seen = new Set<string>()
  for (const item of [...report.taskRules, ...report.userPreferences, ...report.environmentFacts]) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    // The dream instruction forbids memory carrying verbatim answers,
    // patches, diff hunks, or answer strings, in any kind. Screen at the
    // export boundary so the rule holds regardless of how a pattern was
    // curated upstream.
    if (isAnswerArtifact(item.instruction) || isAnswerArtifact(item.text)) continue
    allItems.push(item)
  }
  return allItems
}

/** Compact, deterministic support badge: the distinct trajectories behind the line. */
function supportBadge(item: DreamItem): string {
  return `[${item.support} trajs]`
}

function renderRule(item: DreamItem, skillFiles: Map<DreamItem, string>, index: number): string {
  const file = skillFiles.get(item)
  return `${index + 1}. ${item.instruction} ${supportBadge(item)}${file ? ` — see \`${file}\`` : ""}`
}

function renderKnownFailures(items: DreamItem[]): string[] {
  return items.map((item) => {
    const { fail, total } = failCounts(item)
    return `- Verified FAIL: ${item.instruction} (${fail} of ${total} evidence trajectories failed)`
  })
}

/** Fail-only cautions render in the same one-line style, capped per family.
 *  1-of-1 anecdotes are demoted to a visually lighter form: a task agent must
 *  be able to tell "failed 8 of 11 times" (a trap) from "one agent misread one
 *  task once" (an anecdote) at a glance. */
function renderFailCautions(items: DreamItem[], cap: number): string[] {
  const rendered = items.slice(0, cap)
  return rendered.map((item) => {
    const { fail, total } = failCounts(item)
    if (total >= 2) return renderKnownFailures([item])[0]
    return `- Failed once: ${item.instruction} (1 attempt; anecdote, not a pattern)`
  })
}

function renderMemoryIndex(
  report: DreamReport,
  organized: Organized,
  skillFiles: Map<DreamItem, string>
): string {
  const lines: string[] = []
  lines.push("# Memory", "")
  lines.push(
    `Learned from ${report.stats.trajectories} agent trajectories (${report.stats.pass} PASS, ${report.stats.fail} FAIL, ${report.stats.unknown} unlabeled), organized by task family. At the start of a task, find the family below that matches the task's benchmark, tools, or harness and follow its rules first; otherwise follow the general rules. Every line below is imperative: follow it, and open the linked skill file for provenance before deviating.`,
    ""
  )

  for (const section of organized.sections) {
    lines.push(`## ${section.family.name}`, "")
    if (section.rules.length > 0) {
      lines.push("### Rules", "")
      section.rules
        .slice(0, CAPS.familyRules)
        .forEach((item, i) => lines.push(renderRule(item, skillFiles, i)))
      lines.push("")
    }
    if (section.knownFailures.length > 0 || section.failCautions.length > 0) {
      lines.push("### Known failures", "")
      lines.push(...renderKnownFailures(section.knownFailures.slice(0, CAPS.familyFailures)))
      lines.push(...renderFailCautions(section.failCautions, FAIL_CAUTIONS_PER_FAMILY))
      lines.push("")
    }
    if (section.envFacts.length > 0) {
      lines.push("### Environment", "")
      section.envFacts.slice(0, CAPS.familyEnv).forEach((item) => {
        lines.push(`- ${item.instruction} ${supportBadge(item)}`)
      })
      lines.push("")
    }
    if (section.preferences.length > 0) {
      lines.push("### User preferences", "")
      section.preferences.slice(0, CAPS.familyPrefs).forEach((item) => {
        lines.push(`- ${item.instruction} ${supportBadge(item)}`)
      })
      lines.push("")
    }
  }

  const general = organized.general
  if (
    general.rules.length > 0 ||
    general.preferences.length > 0 ||
    general.envFacts.length > 0 ||
    general.failCautions.length > 0
  ) {
    lines.push("## General working rules", "")
    if (general.rules.length > 0) {
      lines.push("### Rules", "")
      general.rules
        .slice(0, CAPS.generalRules)
        .forEach((item, i) => lines.push(renderRule(item, skillFiles, i)))
      lines.push("")
    }
    // Families below the section threshold fold into the general section;
    // their verified-FAIL patterns keep the same known-failures treatment,
    // and their fail-only cautions fold in with the same cap.
    const generalFailures = general.rules.filter(isMajorityFail)
    const generalFailLines: string[] = []
    if (generalFailures.length > 0) {
      generalFailLines.push(...renderKnownFailures(generalFailures.slice(0, CAPS.familyFailures)))
    }
    generalFailLines.push(...renderFailCautions(general.failCautions, FAIL_CAUTIONS_PER_FAMILY))
    if (generalFailLines.length > 0) {
      lines.push("### Known failures", "")
      lines.push(...generalFailLines)
      lines.push("")
    }
    if (general.preferences.length > 0) {
      lines.push("### User preferences", "")
      general.preferences.slice(0, CAPS.generalPrefs).forEach((item) => {
        lines.push(`- ${item.instruction} ${supportBadge(item)}`)
      })
      lines.push("")
    }
    if (general.envFacts.length > 0) {
      lines.push("### Environment", "")
      general.envFacts.slice(0, CAPS.generalEnv).forEach((item) => {
        lines.push(`- ${item.instruction} ${supportBadge(item)}`)
      })
      lines.push("")
    }
  }

  lines.push(
    "## How this memory was built",
    "",
    `- ${report.stats.claims} claims extracted from the trajectory corpus into a provenance-carrying claim graph.`,
    `- Near-duplicate phrasings were consolidated; each unique rule appears once.`,
    `- Patterns recurring across trajectories were promoted here, organized by task family; rules backed mostly by failed runs also appear under the family's known failures.`,
    `- Provenance per claim: trajectory id, turn, and the trajectory's verifier result (PASS/FAIL).`,
    ""
  )
  return lines.join("\n")
}

/** Write the memory folder. Returns the validation report for the export. */
export async function exportMemory(
  report: DreamReport,
  outDir: string,
  options: ExportOptions = {}
): Promise<{ report: ValidationReport; files: string[]; pruning: PruningReport }> {
  const opts = {
    provenance: true,
    maxIndexItems: 12,
    claims: undefined as FamilyClaim[] | undefined,
    pruning: undefined as Partial<PruningConfig> | undefined,
    ...options,
  }
  const pruningConfig: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, ...opts.pruning }
  await mkdir(join(outDir, "skills"), { recursive: true })

  const allItems = curatedItems(report)
  const trajectoryFamilies = opts.claims
    ? buildTrajectoryFamilies(opts.claims)
    : new Map<string, string | undefined>()
  const familyOf = (item: DreamItem): string | undefined => {
    if (trajectoryFamilies.size > 0) {
      return item.kind === "user-preference"
        ? familyForPreference(item, trajectoryFamilies)
        : familyForItem(item, trajectoryFamilies)
    }
    return classifyClaimText(`${item.instruction} ${item.text}`)
  }
  // Distinct trajectories per family: the always-keep rescue for a family's
  // sole rule is measured against how much real work ran in that family.
  const familyTrajectoryCounts = new Map<string, number>()
  for (const family of trajectoryFamilies.values()) {
    if (!family) continue
    familyTrajectoryCounts.set(family, (familyTrajectoryCounts.get(family) ?? 0) + 1)
  }
  const decisions = pruneItems(allItems, { familyOf, familyTrajectoryCounts }, pruningConfig)
  const pruning = pruningReport(decisions, pruningConfig)

  const organized = organizeByFamily(report, opts.claims, decisions)
  const skillFiles = new Map<DreamItem, string>()
  const written: string[] = []
  // Every curated item gets a skill file so every index line can carry a
  // pointer and no detail is unreachable; the 8 MiB budget is far away and
  // file count matters less than MEMORY.md scannability.
  for (const item of allItems) {
    const file = skillFileName(item, skillFiles.size + 1)
    skillFiles.set(item, `skills/${file}`)
    await writeFile(join(outDir, "skills", file), renderSkill(item, file), "utf-8")
    written.push(`skills/${file}`)
  }

  // Resolving details: for each family with enough curated rules, the top
  // items' skill files get the most concrete supporting claim texts. Needs
  // the claim list; without one, skill files render provenance only.
  if (opts.claims && opts.claims.length > 0) {
    for (const section of organized.sections) {
      if (section.rules.length < MIN_FAMILY_RULES_FOR_DETAILS) continue
      const top = [...section.rules, ...section.preferences, ...section.envFacts]
        .sort(byRank)
        .slice(0, DETAIL_ITEMS_PER_FAMILY)
      for (const item of top) {
        const file = skillFiles.get(item)
        if (!file) continue
        await writeFile(
          join(outDir, file),
          renderSkill(item, file, resolvingDetails(item, opts.claims)),
          "utf-8"
        )
      }
    }
  }

  const memoryMd = renderMemoryIndex(report, organized, skillFiles)
  await writeFile(join(outDir, ENTRY_FILE), memoryMd, "utf-8")

  // Reference task adapters differ in which entry file they seed: the Codex
  // adapter seeds memory_summary.md and copies MEMORY.md into it only when
  // absent; Claude Code and Hermes read MEMORY.md directly. Exporting the
  // summary explicitly means every fixed task agent gets our full index,
  // not an adapter-specific fallback decision.
  await writeFile(join(outDir, SUMMARY_FILE), memoryMd, "utf-8")

  // Self-validate before finishing: a run must not die at the verifier.
  const validation = await checkMemory(outDir)
  if (!validation.ok) {
    throw new Error(`exported memory failed self-validation: ${validation.errors.join("; ")}`)
  }
  return { report: validation, files: [ENTRY_FILE, SUMMARY_FILE, ...written], pruning }
}
