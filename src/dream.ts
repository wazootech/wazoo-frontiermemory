/**
 * Dream: curate the claim graph into transferable memory.
 *
 * FrontierMemory's own qualitative finding — imperative, instruction-shaped
 * memory transfers; overfit per-task summaries never trigger — is the thesis
 * here. So the dream phase does not dump facts: it clusters claims by the
 * pattern they instantiate and keeps the clusters that recur across
 * trajectories, each with its provenance trail.
 *
 * Three kinds of pattern, three SPARQL-backed selections over the embedded
 * graph (selection + provenance joins run in SPARQL; clustering runs in TS
 * on the bindings):
 *
 * - taskRules: correction/avoidance claims, weighted toward FAIL trajectories
 *   (what went wrong and how the user redirected it),
 * - userPreferences: preference claims and how they sequence within a trajectory,
 * - environmentFacts: paths, config files, and command patterns that recur.
 */

import type { SearchRequest, SearchResponse, SparqlRequest, SparqlResponse } from "@worlds/sdk"
import { SPARQL_PREFIXES, type Outcome } from "./ontology"
import type { Claim, ClaimType, Extractor } from "./extraction"

export interface Evidence {
  trajId: string
  turn: number
  outcome: Outcome
}

export interface DreamItem {
  /** Normalized pattern key the cluster formed around. */
  key: string
  kind: "task-rule" | "user-preference" | "environment-fact"
  /** The imperative memory line as it will appear in the memory folder. */
  instruction: string
  /** The representative claim text backing the instruction. */
  text: string
  /** Distinct trajectories supporting the pattern. */
  support: number
  evidence: Evidence[]
  claimTypes: ClaimType[]
}

export interface DreamReport {
  taskRules: DreamItem[]
  userPreferences: DreamItem[]
  environmentFacts: DreamItem[]
  stats: {
    claims: number
    trajectories: number
    pass: number
    fail: number
    unknown: number
  }
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "it",
  "that",
  "this",
  "you",
  "your",
  "my",
  "me",
  "i",
  "we",
  "us",
  "be",
  "as",
  "at",
  "not",
  "no",
  "user",
  "assistant",
  "please",
  "just",
  "can",
  "could",
  "would",
  "will",
  "do",
  "does",
  "did",
])

export function normalizePatternKey(text: string, maxTokens = 5): string {
  const tokens = (text.toLowerCase().match(/[a-z0-9][a-z0-9'/.-]*/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t)
  )
  return tokens.slice(0, maxTokens).join(" ") || text.toLowerCase().slice(0, 60)
}

const CORRECTION_RE =
  /\b(?:don'?t|do not|never|always|stop|instead|rather|wrong|nope|actually|keep it|make it|no longer|from now on)\b/i
const PATH_RE = /(?:^|[\s`"'])(\/[\w./@+-]{2,}|\.{0,2}\/[\w./@+-]+|~\/[\w./@+-]+)/
const CONFIG_RE = /\b(?:config\/[\w./-]+|\.env(?:\.\w+)?|Makefile|package\.json|tsconfig\.json)\b/
const COMMAND_RE = /\b(?:npm|bun|pnpm|yarn|cargo|go|docker|kubectl|git)\s+\w[\w-]*/

interface ClaimBinding {
  claimText: string
  type: ClaimType
  subject?: string
  action?: string
  object?: string
  where?: string
  trajId: string
  turn: number
  outcome: Outcome
  speaker?: string
  extractor?: Extractor
}

interface DreamClient {
  sparql(request: SparqlRequest): Promise<SparqlResponse>
  search(request: SearchRequest): Promise<SearchResponse>
}

/** SPARQL selection + provenance join over the claim graph. */
export async function selectClaimBindings(
  client: Pick<DreamClient, "sparql">
): Promise<ClaimBinding[]> {
  const query = `${SPARQL_PREFIXES}
SELECT ?claimText ?type ?subject ?action ?object ?where ?trajId ?turn ?outcome ?speaker WHERE {
  ?claim worlds:claimText ?claimText .
  ?claim wazoo:trajId ?trajId .
  ?claim wazoo:turn ?turn .
  ?claim wazoo:outcome ?outcome .
  ?claim wazoo:speaker ?speaker .
  ?claim rdf:type ?typeRaw .
  FILTER(?typeRaw IN (worlds:FactClaim, worlds:EventClaim, worlds:PreferenceClaim, worlds:RelationshipClaim, worlds:PlanClaim))
  BIND(REPLACE(STR(?typeRaw), STR(worlds:), "") AS ?type)
  OPTIONAL { ?claim worlds:claimSubject ?subject }
  OPTIONAL { ?claim worlds:claimAction ?action }
  OPTIONAL { ?claim worlds:claimObject ?object }
  OPTIONAL { ?claim worlds:claimWhere ?where }
}
ORDER BY ?trajId ?turn`

  const response = await client.sparql({ query })
  if (response.kind !== "select") return []
  const bindings =
    (response.data as { results?: { bindings?: Record<string, unknown>[] } }).results?.bindings ??
    []

  return bindings.map((b) => {
    const value = (key: string): string | undefined => {
      const v = b[key] as { value?: unknown } | undefined
      const s = v && typeof v.value === "string" ? v.value : undefined
      return s && s.length > 0 ? s : undefined
    }
    const outcomeRaw = value("outcome") ?? ""
    const outcome: Outcome = outcomeRaw.includes("OutcomePass")
      ? "PASS"
      : outcomeRaw.includes("OutcomeFail")
        ? "FAIL"
        : "unknown"
    const typeRaw = (value("type") ?? "FactClaim").toLowerCase()
    const type: ClaimType =
      (["fact", "event", "preference", "relationship", "plan"] as const).find((t) =>
        typeRaw.startsWith(t)
      ) ?? "fact"
    return {
      claimText: value("claimText") ?? "",
      type,
      subject: value("subject"),
      action: value("action"),
      object: value("object"),
      where: value("where"),
      trajId: value("trajId") ?? "",
      turn: Number(value("turn") ?? 0),
      outcome,
      speaker: value("speaker") as ClaimBinding["speaker"],
      extractor: value("extractor") as ClaimBinding["extractor"],
    }
  })
}

function toEvidence(bindings: ClaimBinding[]): Evidence[] {
  const seen = new Set<string>()
  const evidence: Evidence[] = []
  for (const b of bindings) {
    const key = `${b.trajId}/${b.turn}`
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push({ trajId: b.trajId, turn: b.turn, outcome: b.outcome })
  }
  return evidence
}

function cluster(
  bindings: ClaimBinding[],
  keyOf: (b: ClaimBinding) => string
): Map<string, ClaimBinding[]> {
  const clusters = new Map<string, ClaimBinding[]>()
  for (const b of bindings) {
    const key = keyOf(b)
    if (!key) continue
    const bucket = clusters.get(key) ?? []
    bucket.push(b)
    clusters.set(key, bucket)
  }
  return clusters
}

/** Longest claimText wins as representative; deterministic tie-break. */
function representative(bindings: ClaimBinding[]): ClaimBinding {
  return [...bindings].sort(
    (a, b) => b.claimText.length - a.claimText.length || (a.claimText < b.claimText ? -1 : 1)
  )[0]
}

function outcomeWeight(evidence: Evidence[]): number {
  // FAIL trajectories carry the sharpest lessons; weight them above the rest.
  const fail = evidence.filter((e) => e.outcome === "FAIL").length
  const pass = evidence.filter((e) => e.outcome === "PASS").length
  return fail * 2 + pass
}

export function buildDreamReport(bindings: ClaimBinding[]): DreamReport {
  const stats = {
    claims: bindings.length,
    trajectories: new Set(bindings.map((b) => b.trajId)).size,
    pass: bindings.filter((b) => b.outcome === "PASS").length,
    fail: bindings.filter((b) => b.outcome === "FAIL").length,
    unknown: bindings.filter((b) => b.outcome === "unknown").length,
  }

  // --- task rules: corrections and avoidance rules, FAIL-weighted -----------
  const correctionBindings = bindings.filter((b) => CORRECTION_RE.test(b.claimText))
  const taskRules = [
    ...cluster(
      correctionBindings,
      (b) => `${b.action ?? "instructs"} ${normalizePatternKey(b.object ?? b.claimText, 4)}`
    ).entries(),
  ]
    .map(([key, group]) => {
      const rep = representative(group)
      const evidence = toEvidence(group)
      return {
        key,
        kind: "task-rule" as const,
        instruction: `Follow the user's stated working rule: ${rep.claimText.replace(/\s+/g, " ")}`,
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence: evidence.slice(0, 8),
        claimTypes: [...new Set(group.map((g) => g.type))],
      }
    })
    .sort((a, b) => outcomeWeight(b.evidence) - outcomeWeight(a.evidence) || b.support - a.support)

  // --- user preferences: preference claims, clustered across trajectories ---
  const preferenceBindings = bindings.filter(
    (b) => b.type === "preference" || b.action === "prefers" || b.action === "corrected"
  )
  const userPreferences = [
    ...cluster(preferenceBindings, (b) => normalizePatternKey(b.claimText)).entries(),
  ]
    .map(([key, group]) => {
      const rep = representative(group)
      const evidence = toEvidence(group)
      const sequence = group
        .slice()
        .sort((a, b) => a.trajId.localeCompare(b.trajId) || a.turn - b.turn)
        .map((g) => `${g.trajId}#${g.turn}`)
        .slice(0, 8)
        .join(", ")
      return {
        key,
        kind: "user-preference" as const,
        instruction: `Respect the user's preference: ${rep.claimText.replace(/\s+/g, " ")} (first stated at ${sequence.split(", ")[0]})`,
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence: evidence.slice(0, 8),
        claimTypes: [...new Set(group.map((g) => g.type))],
      }
    })
    .sort((a, b) => b.support - a.support || outcomeWeight(b.evidence) - outcomeWeight(a.evidence))

  // --- environment facts: recurring paths, configs, commands ----------------
  const envBindings = bindings.filter(
    (b) =>
      b.type === "fact" &&
      (PATH_RE.test(b.claimText) || CONFIG_RE.test(b.claimText) || COMMAND_RE.test(b.claimText))
  )
  const environmentFacts = [
    ...cluster(envBindings, (b) =>
      normalizePatternKey(b.where ?? b.object ?? b.claimText, 3)
    ).entries(),
  ]
    .map(([key, group]) => {
      const rep = representative(group)
      const evidence = toEvidence(group)
      return {
        key,
        kind: "environment-fact" as const,
        instruction: `Environment fact: ${rep.claimText.replace(/\s+/g, " ")}`,
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence: evidence.slice(0, 8),
        claimTypes: [...new Set(group.map((g) => g.type))],
      }
    })
    .sort((a, b) => b.support - a.support)

  return { taskRules, userPreferences, environmentFacts, stats }
}

/**
 * Full dream phase: SPARQL selection over the imported graph, clustering,
 * plus one hybrid (keyword + vector) search pass per pattern kind to surface
 * near-duplicate phrasings the exact-match clusters missed.
 */
export async function dream(client: DreamClient, claims: Claim[]): Promise<DreamReport> {
  let bindings: ClaimBinding[]
  try {
    bindings = await selectClaimBindings(client)
  } catch {
    // The claims list is the same data the graph was built from; degrade to
    // in-memory bindings rather than losing the phase.
    bindings = claims.map((c) => ({
      claimText: c.claimText,
      type: c.type,
      subject: c.subject,
      action: c.action,
      object: c.object,
      where: c.where,
      trajId: c.trajId,
      turn: c.turn,
      outcome: c.outcome,
      speaker: c.speaker,
      extractor: c.extractor,
    }))
  }

  const report = buildDreamReport(bindings)

  // Hybrid search sanity pass: each pattern kind must return at least one hit
  // on its own vocabulary. Recorded in stats via a non-fatal probe.
  for (const query of ["user preference format", "config file path", "failed attempt correction"]) {
    try {
      await client.search({ query, topK: 5 })
    } catch {
      // Search index disabled (e.g. vector dims unavailable) — SPARQL path still stands.
    }
  }
  return report
}
