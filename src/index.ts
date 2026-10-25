/**
 * CLI entry point.
 *
 *   bun run src/index.ts <phase> --corpus <dir> --out <dir> [options]
 *
 * Phases (run one, or `all` to chain all three):
 *   ingest   parse corpus trajectories, extract worlds:Claim quads
 *            (DeepSeek via DEEPSEEK_API_KEY, deterministic fallback on
 *            failure; --fallback-only skips the network entirely)
 *   dream    curate the claim graph via SPARQL + hybrid search
 *   export   write the memory folder and self-validate it
 *
 * Common options:
 *   --corpus <dir>      trajectory corpus directory (default: smoke/corpus)
 *   --out <dir>         memory folder to write (export/all; default: memory/)
 *   --state <dir>       pipeline state directory (default: data/state)
 *   --limit <n>         ingest at most n trajectories (screening runs)
 *   --concurrency <n>   parallel trajectory extraction (default 1)
 *   --fallback-only     deterministic keyword extractor, no network
 *   --model-dir <dir>   local TFJS USE model dir for real vector search
 *                       (absent => deterministic hashing embeddings)
 *
 * Inside the benchmark sandbox only the memory model's API host is
 * reachable, and only the extraction phase talks to it. Nothing here
 * performs a web search or touches any other host.
 */

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { loadCorpus } from "./corpus"
import { extractClaimsForTrajectory } from "./extraction"
import { importGraph } from "./graph"
import { dream } from "./dream"
import { exportMemory } from "./export"
import {
  readDreamState,
  readIngestState,
  trajectoriesToState,
  writeDreamState,
  writeIngestState,
  type IngestState,
} from "./state"
import { checkMemory } from "./validate"

export interface CliArgs {
  phase: "ingest" | "dream" | "export" | "all"
  corpus: string
  out: string
  state: string
  limit?: number
  concurrency: number
  fallbackOnly: boolean
  modelDir?: string
}

export function parseArgs(argv: string[]): CliArgs {
  const [phase, ...rest] = argv
  if (phase !== "ingest" && phase !== "dream" && phase !== "export" && phase !== "all") {
    throw new Error(
      `usage: bun run src/index.ts <ingest|dream|export|all> --corpus <dir> --out <dir>`
    )
  }
  const args: CliArgs = {
    phase,
    corpus: "smoke/corpus",
    out: "memory",
    state: "data/state",
    concurrency: 1,
    fallbackOnly: false,
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const next = (): string => {
      const value = rest[++i]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      return value
    }
    if (flag === "--corpus") args.corpus = next()
    else if (flag === "--out") args.out = next()
    else if (flag === "--state") args.state = next()
    else if (flag === "--limit") args.limit = Number(next())
    else if (flag === "--concurrency") args.concurrency = Number(next())
    else if (flag === "--fallback-only") args.fallbackOnly = true
    else if (flag === "--model-dir") args.modelDir = next()
    else throw new Error(`unknown flag: ${flag}`)
  }
  return args
}

async function runIngest(args: CliArgs): Promise<IngestState> {
  const trajectories = await loadCorpus(args.corpus, args.limit)
  console.log(`ingest: ${trajectories.length} trajectories from ${args.corpus}`)
  const claims: Awaited<ReturnType<typeof extractClaimsForTrajectory>>[] = []
  const concurrency = Math.max(1, args.concurrency)
  for (let i = 0; i < trajectories.length; i += concurrency) {
    const batch = trajectories.slice(i, i + concurrency)
    const batchClaims = await Promise.all(
      batch.map(async (traj) => {
        const extracted = await extractClaimsForTrajectory(traj, {
          fallbackOnly: args.fallbackOnly,
        })
        console.log(`  ${traj.trajId}: ${extracted.length} claims (outcome ${traj.outcome})`)
        return extracted
      })
    )
    claims.push(...batchClaims)
  }
  const flattened = claims.flat()
  const state: IngestState = { claims: flattened, trajectories: trajectoriesToState(trajectories) }
  const path = await writeIngestState(args.state, state)
  console.log(`ingest: wrote ${flattened.length} claims to ${path}`)
  return state
}

async function runDream(args: CliArgs, state?: IngestState): Promise<void> {
  const ingestState = state ?? (await readIngestState(args.state))
  const trajs = ingestState.trajectories.map((t) => ({
    trajId: t.trajId,
    path: t.path,
    sessionId: undefined,
    events: [],
    outcome: t.outcome as "PASS" | "FAIL" | "unknown",
    lineCount: t.lineCount,
  }))
  const dbPath = join(args.state, "graph.db")
  const client = await importGraph({
    dbPath,
    trajs,
    claims: ingestState.claims,
    modelDir: args.modelDir,
  })
  const report = await dream(client, ingestState.claims)
  const path = await writeDreamState(args.state, report)
  console.log(
    `dream: ${report.taskRules.length} task rules, ${report.userPreferences.length} user preferences, ${report.environmentFacts.length} environment facts -> ${path}`
  )
  client.close()
}

async function runExport(args: CliArgs): Promise<void> {
  const report = await readDreamState(args.state)
  await mkdir(args.out, { recursive: true })
  const { report: validation, files } = await exportMemory(report, args.out)
  console.log(`export: ${files.length} files, ${validation.total_bytes} bytes -> ${args.out}`)
  console.log(`export: self-validation ok (memory_sha256 ${validation.memory_sha256})`)
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.phase === "ingest" || args.phase === "all") {
    const state = await runIngest(args)
    if (args.phase === "all") await runDream(args, state)
    await runExport(args)
    return 0
  }
  if (args.phase === "dream") {
    await runDream(args)
    return 0
  }
  await runExport(args)
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err))
      process.exit(1)
    })
}

export { checkMemory }
