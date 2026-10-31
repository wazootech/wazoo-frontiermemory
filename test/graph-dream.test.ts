import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadCorpus } from "../src/corpus"
import { extractClaimsFallback } from "../src/extraction"
import type { Claim } from "../src/extraction"
import type { Trajectory } from "../src/corpus"
import { importGraph, serializeGraph } from "../src/graph"
import { dream, buildDreamReport, normalizePatternKey } from "../src/dream"

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus")

describe("claim graph import + SPARQL provenance", () => {
  let client: Awaited<ReturnType<typeof importGraph>>
  let claims: ReturnType<typeof extractClaimsFallback>

  beforeAll(async () => {
    const traj = (await loadCorpus(FIXTURE_CORPUS))[0]
    claims = extractClaimsFallback(traj)
    client = await importGraph({
      dbPath: ":memory:",
      trajs: [traj],
      claims,
      searchIndexOnImport: "incremental",
    })
  })

  test("imported claims round-trip through SPARQL with full provenance", async () => {
    const response = await client.sparql({
      query: `PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
PREFIX wazoo: <https://wazoo.dev/ns/frontiermemory#>
SELECT ?claimText ?trajId ?turn ?outcome WHERE {
  ?claim worlds:claimText ?claimText .
  ?claim wazoo:trajId ?trajId .
  ?claim wazoo:turn ?turn .
  ?claim wazoo:outcome ?outcome .
}`,
    })
    if (response.kind !== "select") throw new Error("expected select")
    const bindings = (response.data as { results: { bindings: Record<string, unknown>[] } }).results
      .bindings
    expect(bindings.length).toBe(claims.length)
    const first = bindings[0] as Record<string, { value: string }>
    expect(first.trajId.value).toBe("claude-code-intro")
    expect(Number(first.turn.value)).toBeGreaterThan(0)
    expect(first.outcome.value).toContain("OutcomeUnknown")
  })

  test("trajectory metadata is queryable", async () => {
    const valid = await client.sparql({
      query: `PREFIX schema: <http://schema.org/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX wazoo: <https://wazoo.dev/ns/frontiermemory#>
SELECT ?trajId (COUNT(?msg) AS ?eventCount) WHERE {
  ?msg prov:wasGeneratedBy ?traj .
  ?traj wazoo:trajId ?trajId .
  ?traj a wazoo:Trajectory .
} GROUP BY ?trajId`,
    })
    expect(valid.kind).toBe("select")
    if (valid.kind !== "select") throw new Error("expected select")
    const bindings = (valid.data as { results: { bindings: Record<string, unknown>[] } }).results
      .bindings
    expect(bindings).toHaveLength(1)
  })

  test("hybrid search runs over the imported graph (deterministic embeddings)", async () => {
    const response = await client.search({ query: "changelog format bullets", topK: 5 })
    expect(response).toBeDefined()
    // The deterministic embedder guarantees keyword recall at minimum; the
    // smoke trajectory contains "format works" and changelog/bullet talk.
    expect((response.results ?? []).length).toBeGreaterThan(0)
  })
})

describe("dream phase", () => {
  let traj: Awaited<ReturnType<typeof loadCorpus>>[number]
  let claims: ReturnType<typeof extractClaimsFallback>

  beforeAll(async () => {
    traj = (await loadCorpus(FIXTURE_CORPUS))[0]
    claims = extractClaimsFallback(traj)
  })

  test("normalizePatternKey drops stopwords and is stable", () => {
    const a = normalizePatternKey("Keep it to a few bullets about changes I'd care about")
    const b = normalizePatternKey("keep it to a few bullets about changes")
    expect(a).toBe(b)
  })

  test("buildDreamReport clusters with provenance and stats", () => {
    const bindings = claims.map((c) => ({
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
    const report = buildDreamReport(bindings)
    expect(report.stats.claims).toBe(claims.length)
    expect(report.stats.trajectories).toBe(1)
    const all = [...report.taskRules, ...report.userPreferences, ...report.environmentFacts]
    for (const item of all) {
      expect(item.support).toBeGreaterThanOrEqual(1)
      expect(item.instruction.length).toBeGreaterThan(10)
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(item.claimTypes.length).toBeGreaterThan(0)
    }
    // The smoke trajectory's preference statements must surface as user preferences.
    const prefTexts = report.userPreferences.map((p) => p.text).join(" ")
    expect(prefTexts.length).toBeGreaterThan(0)
  })

  test("full dream runs over the imported graph and degrades gracefully", async () => {
    const client = await importGraph({ dbPath: ":memory:", trajs: [traj], claims })
    const report = await dream(client, claims)
    expect(report.stats.claims).toBe(claims.length)
    expect(Array.isArray(report.taskRules)).toBeTrue()
    expect(Array.isArray(report.userPreferences)).toBeTrue()
    expect(Array.isArray(report.environmentFacts)).toBeTrue()
    client.close()
  })
})

describe("lone-surrogate sanitization (wazoo-ab-memory-10 regression)", () => {
  test("serializes claims containing lone surrogates without parser errors", async () => {
    const claim: Claim = {
      id: "urn:claim:surr:1",
      type: "fact",
      subject: "x",
      action: "did",
      object: "y",
      claimText: "The output file \ud83c was written successfully.",
      speaker: "assistant",
      extractor: "llm",
      trajId: "tX",
      turn: 3,
      outcome: "FAIL",
    }
    const turtle = serializeGraph([], [claim])
    // the escaped surrogate pair is gone; U+FFFD stands in
    expect(turtle).not.toMatch(/\\ud83c/i)
    expect(turtle).toContain("\uFFFD")
  })

  test("keeps VALID surrogate pairs intact", () => {
    const claim: Claim = {
      id: "urn:claim:surr:2",
      type: "fact",
      subject: "x",
      action: "did",
      object: "y",
      claimText: "Wrote the results file with a rocket \ud83d\ude80 emoji.",
      speaker: "assistant",
      extractor: "llm",
      trajId: "tX",
      turn: 4,
      outcome: "PASS",
    }
    const turtle = serializeGraph([], [claim])
    expect(turtle).toContain("\ud83d\ude80")
  })
})

describe("deep surrogate sanitization (wazoo-ab-memory-12 regression)", () => {
  test("covers event text nested inside trajectory events[]", async () => {
    const traj: Trajectory = {
      trajId: "tSurr",
      path: "tSurr.json",
      sessionId: "s",
      events: [
        {
          turn: 2,
          speaker: "assistant",
          text: "Saved report \ud83c for review.",
          eventType: "message",
        },
      ],
      outcome: "FAIL",
      lineCount: 3,
    }
    const turtle = serializeGraph([traj], [])
    expect(turtle).not.toMatch(/\\ud83c/i)
    expect(turtle).toContain("\uFFFD")
  })

  test("keeps valid emoji pairs nested in events", () => {
    const traj: Trajectory = {
      trajId: "tSurr2",
      path: "tSurr2.json",
      sessionId: "s",
      events: [
        { turn: 1, speaker: "assistant", text: "shipped \ud83d\ude80", eventType: "message" },
      ],
      outcome: "PASS",
      lineCount: 2,
    }
    const turtle = serializeGraph([traj], [])
    expect(turtle).toContain("\ud83d\ude80")
  })
})
