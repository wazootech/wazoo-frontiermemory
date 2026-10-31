/**
 * Task-family classification for the export phase.
 *
 * The corpus is drawn from recurring benchmark task families (pcap traffic
 * stats, word2vec pipelines, solver optimization, ARC grids, dbt modeling,
 * bioinformatics analytics, MCP-backed agentic workplaces, ops tasks, repo
 * work), and memory organized by family reads the way a person works: at the
 * start of a task, find the family that matches the tools and harness in
 * front of you and load its rules first.
 *
 * Classification is fingerprint-based: a fixed, hand-inspectable regex per
 * family runs over claim text (case-insensitive). A trajectory's family is
 * the one matching most of its claims; an item's family is the one shared by
 * the majority (plurality) of its evidence trajectories. Anything with no
 * family lands in the general section.
 */

import type { DreamItem } from "./dream"

export interface Family {
  /** Stable machine id, also used for skill-file slugs and ordering. */
  id: string
  /** Human-facing section title in MEMORY.md. */
  name: string
  /** Claim-text fingerprint (case-insensitive). */
  fingerprint: RegExp
}

/**
 * Families are declared in this order; ties (a claim or trajectory matching
 * several fingerprints equally) resolve to the earliest declared family, so
 * the order is part of the classification contract and must stay sorted.
 */
export const FAMILIES: Family[] = [
  {
    id: "dapt-pcap-network-stats",
    name: "DAPT pcap network stats",
    fingerprint:
      /pcap|network_stats|bidirectional_flow|has_port_scan|is_traffic_benign|protocol_udp/i,
  },
  {
    id: "word2vec-pipeline",
    name: "Word2Vec pipeline builder",
    fingerprint: /word2vec|task_func|gensim|stopwords/i,
  },
  {
    id: "algotune-optimization",
    name: "Solver speedup optimization",
    fingerprint: /solver\.py|speedup|algotune|numba/i,
  },
  {
    // \bARC\b, not bare /arc/i: "research" contains "arc" and once matched a
    // fifth of the corpus. Word boundary + the task's own vocabulary keeps
    // this family to the grid-transform tasks.
    id: "arc-grid-transforms",
    name: "ARC grid transforms",
    fingerprint: /\bARC\b|training examples|test grid/i,
  },
  {
    // "dbt" as a bare substring matches inside "DynamoDBToolboxError"; pin it
    // to word-ish boundaries and the ecosystem's own tokens.
    id: "dbt-data-eng",
    name: "dbt data engineering",
    fingerprint: /\bdbt\b|dbt_|duckdb|stg_/i,
  },
  {
    // "variant" and case-insensitive "CHIP" matched product names ("Tomcat 9
    // Variant 12") and snack foods ("Chocolate Chip"); the family's real
    // vocabulary is bioinformatics-specific.
    id: "analytics-bixbench",
    name: "BixBench bioinformatics analytics",
    fingerprint:
      /miRNA|GSEA|ordinal logit|Zygosity|BixBench|\bCt values?\b|CHIP_[A-Z0-9_]+|cpg[- ]?density/i,
  },
  {
    id: "agentic-mcp-sheets",
    name: "Agentic MCP workplace (world server)",
    fingerprint: /world MCP|sheets MCP|read_tab|tab_index|Teams assistant/i,
  },
  {
    id: "skillsbench-ops",
    name: "SkillsBench ops tasks",
    fingerprint: /ocr-receipts|tesseract|model-investment|PWT|Dataverse/i,
  },
  {
    id: "repo-work-conventions",
    name: "Repo work conventions",
    fingerprint: /AGENTS\.md|monorepo|kebab-case|pnpm/i,
  },
]

/** Earliest-declared family whose fingerprint matches, or undefined. */
export function classifyClaimText(claimText: string): string | undefined {
  for (const family of FAMILIES) {
    if (family.fingerprint.test(claimText)) return family.id
  }
  return undefined
}

/**
 * A trajectory's family: the declared-earliest family among those matching
 * the most of the trajectory's claims. Deliberately claim-count weighted so
 * a one-off word inside an otherwise unrelated trajectory cannot drag it in.
 */
export function classifyTrajectoryTexts(claimTexts: string[]): string | undefined {
  const tally = new Map<string, number>()
  for (const text of claimTexts) {
    const family = classifyClaimText(text)
    if (!family) continue
    tally.set(family, (tally.get(family) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const family of FAMILIES) {
    const count = tally.get(family.id) ?? 0
    if (count > bestCount) {
      best = family.id
      bestCount = count
    }
  }
  return best
}

export interface FamilyClaim {
  trajId: string
  turn: number
  claimText: string
}

/** Classify every trajectory from a flat claim list: trajId -> family id. */
export function buildTrajectoryFamilies(claims: FamilyClaim[]): Map<string, string | undefined> {
  const perTraj = new Map<string, string[]>()
  for (const claim of claims) {
    const texts = perTraj.get(claim.trajId) ?? []
    texts.push(claim.claimText)
    perTraj.set(claim.trajId, texts)
  }
  const families = new Map<string, string | undefined>()
  for (const [trajId, texts] of perTraj) families.set(trajId, classifyTrajectoryTexts(texts))
  return families
}

/**
 * An item's family: the plurality family of its evidence trajectories.
 * "Majority" in the strict sense would strand items whose evidence splits
 * 3-to-2, so plurality wins; an exact tie is genuinely ambiguous and leaves
 * the item family-less (it lands in the general section).
 */
export function familyForItem(
  item: DreamItem,
  trajectoryFamilies: Map<string, string | undefined>
): string | undefined {
  return pluralityFamily(tallyEvidenceFamilies(item, trajectoryFamilies))
}

function tallyEvidenceFamilies(
  item: DreamItem,
  trajectoryFamilies: Map<string, string | undefined>
): Map<string, number> {
  const tally = new Map<string, number>()
  for (const evidence of item.evidence) {
    const family = trajectoryFamilies.get(evidence.trajId)
    if (!family) continue
    tally.set(family, (tally.get(family) ?? 0) + 1)
  }
  return tally
}

/**
 * Plurality over a family tally, fully deterministic: highest count wins,
 * an alphabetical tie-break settles exact ties, and a tie means no family
 * (the item lands in the general section rather than an arbitrary one).
 */
function pluralityFamily(tally: Map<string, number>): string | undefined {
  const ids = [...tally.keys()].sort((a, b) => a.localeCompare(b))
  let best: string | undefined
  let bestCount = 0
  for (const id of ids) {
    const count = tally.get(id) ?? 0
    if (count > bestCount) {
      best = id
      bestCount = count
    }
  }
  if (best === undefined) return undefined
  const ties = ids.filter((id) => (tally.get(id) ?? 0) === bestCount)
  return ties.length > 1 ? undefined : best
}

/**
 * Family scoping for user preferences: a preference is family-owned only
 * when at least `share` (0.8) of its evidence trajectories sit in one
 * family; otherwise it renders in the general section.
 */
export function familyForPreference(
  item: DreamItem,
  trajectoryFamilies: Map<string, string | undefined>
): string | undefined {
  const tally = tallyEvidenceFamilies(item, trajectoryFamilies)
  const classified = [...tally.values()].reduce((a, b) => a + b, 0)
  if (classified === 0) return undefined
  const best = pluralityFamily(tally)
  if (!best) return undefined
  return (tally.get(best) ?? 0) / classified >= 0.8 ? best : undefined
}
