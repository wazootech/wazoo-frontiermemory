/**
 * Corpus-wide parse validation (deliverable: docs/runs/0001-corpus-parse.md).
 *
 * Parses every trajectory file in a corpus directory with the real loader
 * (parse only, no LLM, no network) and prints aggregate stats as JSON:
 *
 *   bun scripts/parse-validate.ts <corpusDir>
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { parseTrajectoryFile } from "../src/corpus"

interface FileStat {
  file: string
  ok: boolean
  error?: string
  format?: string
  events?: number
  lineCount?: number
  outcome?: string
}

const dir = process.argv[2]
if (!dir) {
  console.error("usage: bun scripts/parse-validate.ts <corpusDir>")
  process.exit(1)
}

const started = Date.now()
const entries = (await readdir(dir)).filter((f) => /\.jsonl?$/i.test(f)).sort()
const stats: FileStat[] = []
let totalEvents = 0

for (const file of entries) {
  const path = join(dir, file)
  try {
    const traj = await parseTrajectoryFile(path)
    totalEvents += traj.events.length
    stats.push({
      file,
      ok: true,
      format: traj.format,
      events: traj.events.length,
      lineCount: traj.lineCount,
      outcome: traj.outcome,
    })
  } catch (err) {
    stats.push({ file, ok: false, error: String(err).slice(0, 300) })
  }
}

const byFormat: Record<string, number> = {}
const outcomes: Record<string, number> = {}
const formatOutcomes: Record<string, Record<string, number>> = {}
let parsed = 0
const failures: FileStat[] = []

for (const s of stats) {
  if (s.ok) {
    parsed++
    byFormat[s.format ?? "unknown"] = (byFormat[s.format ?? "unknown"] ?? 0) + 1
    outcomes[s.outcome ?? "unknown"] = (outcomes[s.outcome ?? "unknown"] ?? 0) + 1
    const fo = (formatOutcomes[s.format ?? "unknown"] ??= {})
    fo[s.outcome ?? "unknown"] = (fo[s.outcome ?? "unknown"] ?? 0) + 1
  } else {
    failures.push(s)
  }
}

console.log(
  JSON.stringify(
    {
      corpusDir: dir,
      totalFiles: entries.length,
      parsed,
      failed: entries.length - parsed,
      totalEvents,
      byFormat,
      outcomes,
      formatOutcomes,
      failures: failures.slice(0, 10),
      wallMs: Date.now() - started,
    },
    null,
    2
  )
)
