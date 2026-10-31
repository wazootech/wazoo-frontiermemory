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

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs as utilParseArgs } from "node:util"
import { loadCorpus } from "./corpus"
import { extractClaimsForTrajectory } from "./extraction"
import { importGraph } from "./graph"
import { dream } from "./dream"
import { exportMemory, type ExportOptions } from "./export"
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

const USAGE = `usage: bun run src/index.ts <ingest|dream|export|all> --corpus <dir> --out <dir>`

/**
 * Cap on rendered extraction-prompt events (run 0002). Keeps every call
 * within model context; oversized trajectories fall back to the
 * deterministic extractor for the events past the cap.
 */
const EXTRACTION_MAX_PROMPT_EVENTS = 200

export function parseArgs(argv: string[]): CliArgs {
  // Bun's node:util shim (and its types) only implements the config-only form
  // of util.parseArgs, which reads process.argv.slice(2) and ignores the
  // optional argv parameter that stock Node accepts. Route the caller's argv
  // through process.argv for the duration of the call so both runtimes behave.
  const saved = process.argv
  process.argv = [saved[0] ?? "bun", saved[1] ?? "src/index.ts", ...argv]
  let parsed
  try {
    parsed = utilParseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        corpus: { type: "string", default: "smoke/corpus" },
        out: { type: "string", default: "memory" },
        state: { type: "string", default: "data/state" },
        limit: { type: "string" },
        concurrency: { type: "string", default: "1" },
        "fallback-only": { type: "boolean", default: false },
        "model-dir": { type: "string" },
      },
    })
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${USAGE}`)
  } finally {
    process.argv = saved
  }
  const values = parsed.values as Record<
    "corpus" | "out" | "state" | "limit" | "concurrency" | "model-dir" | "fallback-only",
    string | boolean | undefined
  >
  const [phase] = parsed.positionals
  if (phase !== "ingest" && phase !== "dream" && phase !== "export" && phase !== "all") {
    throw new Error(USAGE)
  }
  return {
    phase,
    corpus: String(values.corpus),
    out: String(values.out),
    state: String(values.state),
    limit: values.limit === undefined ? undefined : Number(values.limit),
    concurrency: Number(values.concurrency),
    fallbackOnly: Boolean(values["fallback-only"]),
    modelDir: values["model-dir"] === undefined ? undefined : String(values["model-dir"]),
  }
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
          // Run 0002 finding: the corpus's largest trajectory (t0261, 17.7 MB)
          // renders a ~1.48 M-token prompt that can never complete; capping
          // prompt events keeps 95.8% of trajectories whole (median 28
          // events, p95 179, max 518), bounds every call within context, and
          // lets the deterministic fallback carry the tail.
          maxPromptEvents: EXTRACTION_MAX_PROMPT_EVENTS,
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
  // The claim list sits beside dream.json in the state dir and feeds family
  // classification and resolving details; its absence degrades the export,
  // never blocks it (an export-only re-run must keep working).
  let claims: ExportOptions["claims"]
  try {
    claims = (await readIngestState(args.state)).claims
  } catch {
    claims = undefined
  }
  const { report: validation, files } = await exportMemory(report, args.out, { claims })
  console.log(`export: ${files.length} files, ${validation.total_bytes} bytes -> ${args.out}`)
  console.log(`export: self-validation ok (memory_sha256 ${validation.memory_sha256})`)
  // Persist the self-validation report for the run record and, on the
  // benchmark, for the submission bundle (Harbor downloads it from the
  // adapter's logs dir after run()).
  const validationPath = join(args.state, "memory-validation.json")
  await writeFile(validationPath, JSON.stringify({ ...validation, files }, null, 2) + "\n")
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
