/**
 * Extraction throughput test on real corpus data
 * (deliverable: docs/runs/0002-extraction-throughput.md).
 *
 * Picks a representative sample (mix of PASS/FAIL, all three formats, varied
 * sizes, always including the 3 largest files), runs the REAL ingest
 * extraction path (extractClaimsForTrajectory, DeepSeek API) at a fixed
 * concurrency, and prints per-trajectory + summary JSON:
 *
 *   bun scripts/throughput-sample.ts <corpusDir> [--sample 20] [--concurrency 4]
 *
 * Requires DEEPSEEK_API_KEY in the environment (run via `platform secrets run`).
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { loadCorpus } from "../src/corpus"
import {
  extractClaimsForTrajectory,
  EXTRACTION_MODEL_DEFAULT,
  type ExtractionRunInfo,
} from "../src/extraction"

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error(
    "usage: bun scripts/throughput-sample.ts <corpusDir> [--sample 20] [--concurrency 4]"
  )
  process.exit(1)
}
const getFlag = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : dflt
}
const SAMPLE = getFlag("sample", 20)
const CONCURRENCY = getFlag("concurrency", 4)
const model = process.env.EXTRACTION_MODEL ?? EXTRACTION_MODEL_DEFAULT

// Deterministic PRNG so the sample is reproducible across runs.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

interface Candidate {
  trajId: string
  format: string
  outcome: string
  bytes: number
  events: number
}

// Pass 1: file sizes; pass 2: parse once (parse is cheap, ~1.6s for 674).
const entries = (await readdir(dir)).filter((f) => /\.(jsonl?)$/i.test(f)).sort()
const sizes = new Map<string, number>()
for (const f of entries) sizes.set(f, (await stat(join(dir, f))).size)
const trajs = await loadCorpus(dir)
const candidates: Candidate[] = trajs.map((t) => ({
  trajId: t.trajId,
  format: t.format ?? "unknown",
  outcome: t.outcome,
  bytes: sizes.get(`${t.trajId}${t.format === "jsonl" ? ".jsonl" : ".json"}`) ?? 0,
  events: t.events.length,
}))

// Sample selection: 3 largest files, then fill deterministically for a mix of
// PASS/FAIL, all three formats, and varied sizes (quartile rotation).
function selectSample(cands: Candidate[], n: number): Candidate[] {
  const rand = lcg(0x5eed)
  const shuffled = [...cands]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const byBytes = [...cands].sort((a, b) => b.bytes - a.bytes)
  const chosen = new Map<string, Candidate>()
  for (const c of byBytes.slice(0, 3)) chosen.set(c.trajId, c)

  const quartile = (c: Candidate): number => {
    const rank = byBytes.findIndex((x) => x.trajId === c.trajId)
    return Math.min(3, Math.floor((rank / cands.length) * 4))
  }
  const quotas = { jsonl: 3, opencode: 2 } // minimums; atif fills the rest
  const counts: Record<string, number> = { jsonl: 0, opencode: 0, atif: 0 }
  for (const c of chosen.values()) counts[c.format] = (counts[c.format] ?? 0) + 1

  // Rotation over (format, outcome, size-quartile) keys keeps the mix spread.
  const groups = new Map<string, Candidate[]>()
  for (const c of shuffled) {
    if (chosen.has(c.trajId)) continue
    const key = `${c.format}/${c.outcome}/q${quartile(c)}`
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  const keys = [...groups.keys()].sort()
  let keyIdx = 0
  let pass = [...chosen.values()].filter((c) => c.outcome === "PASS").length
  while (chosen.size < n && keyIdx < keys.length * 40) {
    const key = keys[keyIdx % keys.length]
    keyIdx++
    const list = groups.get(key)
    if (!list || list.length === 0) continue
    const c = list.shift()!
    // keep outcomes roughly balanced, keep format minimums satisfiable
    const wouldPass = pass + (c.outcome === "PASS" ? 1 : 0)
    const failCount = chosen.size + 1 - wouldPass
    if (Math.abs(wouldPass - failCount) > 2) continue
    if (c.format !== "atif" && counts[c.format] >= quotas[c.format] + 1) continue
    chosen.set(c.trajId, c)
    counts[c.format] = (counts[c.format] ?? 0) + 1
    if (c.outcome === "PASS") pass = wouldPass
  }
  // Fill any remainder with whatever is left (keeps sample at exactly n).
  for (const c of shuffled) {
    if (chosen.size >= n) break
    if (!chosen.has(c.trajId)) chosen.set(c.trajId, c)
  }
  return [...chosen.values()]
}

const sample = selectSample(candidates, SAMPLE)
const byId = new Map(trajs.map((t) => [t.trajId, t]))

interface RunRecord extends ExtractionRunInfo {
  outcome: string
  format: string
  bytes: number
  events: number
  claims: number
  wallMs: number
}

const records: RunRecord[] = []
const started = Date.now()
for (let i = 0; i < sample.length; i += CONCURRENCY) {
  const batch = sample.slice(i, i + CONCURRENCY)
  const batchResults = await Promise.all(
    batch.map(async (c) => {
      const traj = byId.get(c.trajId)!
      const t0 = Date.now()
      let info: ExtractionRunInfo | undefined
      const claims = await extractClaimsForTrajectory(traj, {
        model,
        onRun: (x) => (info = x),
      })
      return {
        trajId: c.trajId,
        outcome: c.outcome,
        format: c.format,
        bytes: c.bytes,
        events: c.events,
        claims: claims.length,
        wallMs: Date.now() - t0,
        ...(info ?? { trajId: c.trajId, attempts: 0, retries: 0, fallback: true, charsIn: 0 }),
      } satisfies RunRecord
    })
  )
  records.push(...batchResults)
  const done = records.length
  console.error(
    `progress: ${done}/${sample.length} trajectories (${Math.round((Date.now() - started) / 1000)}s)`
  )
}

const wallMs = Date.now() - started
const estTokens = (r: RunRecord): number =>
  (r.promptTokens ?? Math.round(r.charsIn / 4)) + (r.completionTokens ?? 0)
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const sortedWalls = records.map((r) => r.wallMs).sort((a, b) => a - b)
const medianWall = sortedWalls[Math.floor(sortedWalls.length / 2)] ?? 0

const summary = {
  model,
  concurrency: CONCURRENCY,
  sampleSize: sample.length,
  corpusFiles: candidates.length,
  wallMs,
  perTrajectory: records.map((r) => ({
    trajId: r.trajId,
    format: r.format,
    outcome: r.outcome,
    bytes: r.bytes,
    events: r.events,
    claims: r.claims,
    attempts: r.attempts,
    retries: r.retries,
    fallback: r.fallback,
    promptTokens: r.promptTokens ?? Math.round(r.charsIn / 4),
    completionTokens: r.completionTokens ?? Math.round(r.charsIn / 4) * 0,
    estimatedTokens: estTokens(r),
    wallMs: r.wallMs,
  })),
  totals: {
    promptTokens: sum(records.map((r) => r.promptTokens ?? Math.round(r.charsIn / 4))),
    completionTokens: sum(records.map((r) => r.completionTokens ?? 0)),
    claims: sum(records.map((r) => r.claims)),
    attempts: sum(records.map((r) => r.attempts)),
    retries: sum(records.map((r) => r.retries)),
    fallbacks: records.filter((r) => r.fallback).length,
  },
  wallPerTrajectory: {
    medianMs: medianWall,
    meanMs: Math.round(wallMs / (sample.length / CONCURRENCY) / CONCURRENCY),
  },
  extrapolation: {
    method: "linear: sample wall time at this concurrency scaled by 674/sample",
    fullCorpusMs: Math.round((wallMs * candidates.length) / sample.length),
    fullCorpusHours: Number(((wallMs * candidates.length) / sample.length / 3_600_000).toFixed(2)),
  },
}
console.log(JSON.stringify(summary, null, 2))
