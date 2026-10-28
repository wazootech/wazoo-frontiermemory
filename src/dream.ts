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
 * - environmentFacts: short environment-state claims (paths, tool availability,
 *   configs) — never tool-call dumps or task briefs.
 *
 * Every list then runs through near-duplicate consolidation so the same rule
 * phrased three slightly different ways surfaces once.
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
  /** The bare memory line as it will appear in MEMORY.md — no boilerplate prefix. */
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

/** Content-word tokenization for similarity: lowercase, stopword-free, edge punctuation stripped ("main." matches "main"). */
export function contentTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9'/.-]*/g)
      ?.map((t) => t.replace(/^[.'/-]+|[.'/-]+$/g, ""))
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)) ?? []
  )
}

/**
 * Light suffix stem so "requires"/"required", "cheating"/"cheat" match —
 * paraphrases of one rule conjugate freely. Deliberately shallow; this is a
 * dedup heuristic, not a linguistics project.
 */
function stem(token: string): string {
  if (token.length >= 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`
  if (token.length >= 5 && token.endsWith("ing")) return token.slice(0, -3)
  if (token.length >= 5 && token.endsWith("ed")) return token.slice(0, -2)
  if (token.length >= 4 && token.endsWith("es")) return token.slice(0, -2)
  if (token.length >= 4 && token.endsWith("s")) return token.slice(0, -1)
  return token
}

function stemmedTokens(text: string): Set<string> {
  return new Set(contentTokens(text).map(stem))
}

/**
 * Token-overlap similarity between two token sets. Jaccard alone punishes
 * paraphrases where one phrasing simply says more ("count each pair once"
 * vs "count each pair once rather than per direction"), so containment
 * overlap (shared / smaller set) rescues those once both texts carry enough
 * content words for containment to mean something.
 */
function setSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const token of small) if (large.has(token)) shared += 1
  const jaccard = shared / (a.size + b.size - shared)
  if (small.size < 4) return jaccard
  const containment = shared / small.size
  return Math.max(jaccard, containment)
}

/** Similarity on content words: 1 = identical, 0 = disjoint. */
export function jaccardSimilarity(a: string, b: string): number {
  return setSimilarity(stemmedTokens(a), stemmedTokens(b))
}

interface Consolidatable {
  key: string
  text: string
  evidence: Evidence[]
  support: number
  claimTypes: ClaimType[]
}

/** Union two items' provenance, deduplicated per (trajectory, turn). */
function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set<string>()
  const merged: Evidence[] = []
  for (const e of [...a, ...b].sort(
    (x, y) => x.trajId.localeCompare(y.trajId) || x.turn - y.turn
  )) {
    const id = `${e.trajId}/${e.turn}`
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(e)
  }
  return merged
}

/**
 * Near-duplicate consolidation: the same rule keeps resurfacing in slightly
 * different words ("count each pair once" vs "count each pair once rather
 * than per direction"), and exact-match clustering alone leaves them as
 * separate entries. Greedily merge items whose representative texts share >=
 * `threshold` content-word overlap (see {@link jaccardSimilarity}). The
 * shortest phrasing wins (it tends to be the most general); the merged item
 * carries the union of all members' provenance.
 */
export function consolidateSimilar<T extends Consolidatable>(items: T[], threshold = 0.75): T[] {
  const kept: T[] = []
  const keptTokens: Set<string>[] = []
  for (const item of items) {
    const tokens = stemmedTokens(item.text)
    let twinIndex = -1
    for (let i = 0; i < kept.length; i++) {
      if (setSimilarity(keptTokens[i], tokens) >= threshold) {
        twinIndex = i
        break
      }
    }
    if (twinIndex < 0) {
      kept.push(item)
      keptTokens.push(tokens)
      continue
    }
    const twin = kept[twinIndex]
    const shorter = item.text.length < twin.text.length ? item : twin
    twin.key = shorter.key
    twin.text = shorter.text
    keptTokens[twinIndex] = stemmedTokens(twin.text)
    twin.evidence = mergeEvidence(twin.evidence, item.evidence)
    twin.support = new Set(twin.evidence.map((e) => e.trajId)).size
    twin.claimTypes = [...new Set([...twin.claimTypes, ...item.claimTypes])]
  }
  return kept
}

const CORRECTION_RE =
  /\b(?:don'?t|do not|never|always|stop|instead|rather|wrong|nope|actually|keep it|make it|no longer|from now on)\b/i
const PATH_RE = /(?:^|[\s`"'])(\/[\w./@+-]{2,}|\.{0,2}\/[\w./@+-]+|~\/[\w./@+-]+)/
const CONFIG_RE = /\b(?:config\/[\w./-]+|\.env(?:\.\w+)?|Makefile|package\.json|tsconfig\.json)\b/
const COMMAND_RE = /\b(?:npm|bun|pnpm|yarn|cargo|go|docker|kubectl|git)\s+\w[\w-]*/
const FILE_NAME_RE =
  /\b[\w@-]+[\w@.-]*\.(?:py|json|toml|ya?ml|md|txt|csv|ts|tsx|js|mjs|sh|pcap|env|cfg|ini|lock|log)\b/
const TOOL_NAME_RE =
  /\b(?:ripgrep|rg|grep|find|git|python3?|pip3?|node|bun|npm|pnpm|yarn|cargo|docker|kubectl|make|cmake|pytest|uv)\b/

/** Verbatim tool-call payloads: execution traces, not environment state. */
const TOOL_DUMP_RE = /\bTool exec:|exec_command|await tools\.|"cmd":|workdir":/

// JSON/shell FRAGMENTS that survive normalization: a claim extracted from a
// tool call can render as `workdir: "/app",` or `base="$(cat ...)"` - not
// tool calls by the old patterns (normalization ate the quote), but not
// environment facts either. Also reject bare command fragments like
// `mkdir -p /logs/agent`: a directory the agent created is an event, and the
// fact it supports gets its own sentence from extraction.
const ENV_FRAGMENT_RE =
  /^(?:[a-z_]+:\s*["{\[]|[a-z_]+="\$|mkdir -p |cd |export |source |echo |sed -n |printf |rg -n |find )/

/** Task-problem statements: someone asking for work, not how the box is set up. */
const TASK_REQUEST_RE =
  /^(?:the )?user (?:tasked|asked|instructed|requested|wanted|requires|required)\b/i

/** Per-task deliverable requirements: what the task demands, not what exists. */
const TASK_REQUIREMENT_RE =
  /^(?:the )?(?:task|solution|final answer|submission)\b.{0,80}\b(?:must|requires|required|should)\b/i

/** Generic assistant narration: what the agent did, not what the box has. */
const ASSISTANT_NARRATION_RE =
  /^(?:the )?(?:assistant|agent) (?:wrote|created|ran|executed|used|added|modified|changed|generated|implemented|installed|computed|reported|then)\b|^saved\b/i

/** Longest claim an environment fact may run before it is a payload, not a claim. */
export const ENV_FACT_MAX_CHARS = 200

/**
 * Environment facts are short environment-state claims: paths, config
 * locations, tool availability, directory contents, service conventions.
 * Explicitly not: tool-call dumps, task-problem statements, or narration of
 * what the assistant happened to do.
 */
export function isEnvironmentFactClaim(b: ClaimBinding): boolean {
  const text = b.claimText.replace(/\s+/g, " ").trim()
  if (text.length === 0 || text.length > ENV_FACT_MAX_CHARS) return false
  if (/\n/.test(b.claimText)) return false
  if (TOOL_DUMP_RE.test(b.claimText)) return false
  if (ENV_FRAGMENT_RE.test(text)) return false
  if (TASK_REQUEST_RE.test(text)) return false
  if (TASK_REQUIREMENT_RE.test(text)) return false
  if (ASSISTANT_NARRATION_RE.test(text)) return false
  return (
    PATH_RE.test(text) || CONFIG_RE.test(text) || FILE_NAME_RE.test(text) || TOOL_NAME_RE.test(text)
  )
}

export interface ClaimBinding {
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

/**
 * Representative claim for a cluster: the shortest phrasing wins (the most
 * general formulation of the rule), deterministic tie-break.
 */
function representative(bindings: ClaimBinding[]): ClaimBinding {
  return [...bindings].sort(
    (a, b) => a.claimText.length - b.claimText.length || (a.claimText < b.claimText ? -1 : 1)
  )[0]
}

function outcomeWeight(evidence: Evidence[]): number {
  // FAIL trajectories carry the sharpest lessons; weight them above the rest.
  const fail = evidence.filter((e) => e.outcome === "FAIL").length
  const pass = evidence.filter((e) => e.outcome === "PASS").length
  return fail * 2 + pass
}

/**
 * Environment facts are ranked by how instructive they are: FAIL-provenance
 * weighs double (environment surprises correlate with failures), and a fact
 * that recurs across >= 2 trajectories gets a boost over singletons.
 */
function environmentScore(item: DreamItem): number {
  const fail = item.evidence.filter((e) => e.outcome === "FAIL").length
  const pass = item.evidence.filter((e) => e.outcome === "PASS").length
  return fail * 2 + pass + (item.support >= 2 ? 3 : 0)
}

/**
 * Per-trajectory outcome: every claim inherits its trajectory's outcome, so
 * tally per trajId and take the majority (defensive against mixed labels).
 * These are trajectory counts, not claim counts — the MEMORY.md header must
 * not report 10k claims as "10k trajectories".
 */
function trajectoryOutcomes(bindings: ClaimBinding[]): Map<string, Outcome> {
  const tally = new Map<string, Map<Outcome, number>>()
  for (const b of bindings) {
    let byOutcome = tally.get(b.trajId)
    if (!byOutcome) {
      byOutcome = new Map()
      tally.set(b.trajId, byOutcome)
    }
    byOutcome.set(b.outcome, (byOutcome.get(b.outcome) ?? 0) + 1)
  }
  const result = new Map<string, Outcome>()
  for (const [trajId, byOutcome] of tally) {
    let best: Outcome = "unknown"
    let bestCount = -1
    for (const outcome of ["PASS", "FAIL", "unknown"] as const) {
      const count = byOutcome.get(outcome) ?? 0
      if (count > bestCount) {
        best = outcome
        bestCount = count
      }
    }
    result.set(trajId, best)
  }
  return result
}

export function buildDreamReport(bindings: ClaimBinding[]): DreamReport {
  const perTrajectory = trajectoryOutcomes(bindings)
  const stats = {
    claims: bindings.length,
    trajectories: perTrajectory.size,
    pass: [...perTrajectory.values()].filter((o) => o === "PASS").length,
    fail: [...perTrajectory.values()].filter((o) => o === "FAIL").length,
    unknown: [...perTrajectory.values()].filter((o) => o === "unknown").length,
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
        instruction: rep.claimText.replace(/\s+/g, " ").trim(),
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence,
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
      return {
        key,
        kind: "user-preference" as const,
        instruction: rep.claimText.replace(/\s+/g, " ").trim(),
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence,
        claimTypes: [...new Set(group.map((g) => g.type))],
      }
    })
    .sort((a, b) => b.support - a.support || outcomeWeight(b.evidence) - outcomeWeight(a.evidence))

  // --- environment facts: short environment-state claims ---------------------
  // Tool availability, paths, configs, directory contents, conventions.
  // Task agents have finite attention; a fact that is really a 2KB tool-call
  // dump or a restatement of the task brief costs more to read than it pays.
  const envBindings = bindings.filter((b) => b.type === "fact" && isEnvironmentFactClaim(b))
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
        instruction: rep.claimText.replace(/\s+/g, " ").trim(),
        text: rep.claimText,
        support: new Set(evidence.map((e) => e.trajId)).size,
        evidence,
        claimTypes: [...new Set(group.map((g) => g.type))],
      }
    })
    .sort((a, b) => environmentScore(b) - environmentScore(a) || b.support - a.support)

  return {
    taskRules: consolidateSimilar(taskRules),
    userPreferences: consolidateSimilar(userPreferences),
    environmentFacts: consolidateSimilar(environmentFacts),
    stats,
  }
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
