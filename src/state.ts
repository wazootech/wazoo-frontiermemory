/**
 * Pipeline state: the artifact handoff between phases. `ingest` writes
 * `claims.json`, `dream` reads it and writes `dream.json`, `export` reads
 * that and writes the memory folder. Kept as plain JSON under the state dir
 * so each phase can run (and be rerun) on its own inside the 6-hour window.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Claim } from "./extraction"
import type { DreamReport } from "./dream"
import type { Trajectory } from "./corpus"

export interface IngestState {
  claims: Claim[]
  trajectories: Array<{
    trajId: string
    path: string
    outcome: string
    eventCount: number
    lineCount: number
  }>
}

export async function writeIngestState(stateDir: string, state: IngestState): Promise<string> {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, "claims.json")
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8")
  return path
}

export async function readIngestState(stateDir: string): Promise<IngestState> {
  const path = join(stateDir, "claims.json")
  return JSON.parse(await readFile(path, "utf-8")) as IngestState
}

export async function writeDreamState(stateDir: string, report: DreamReport): Promise<string> {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, "dream.json")
  await writeFile(path, JSON.stringify(report, null, 2), "utf-8")
  return path
}

export async function readDreamState(stateDir: string): Promise<DreamReport> {
  const path = join(stateDir, "dream.json")
  return JSON.parse(await readFile(path, "utf-8")) as DreamReport
}

export function trajectoriesToState(trajectories: Trajectory[]): IngestState["trajectories"] {
  return trajectories.map((t) => ({
    trajId: t.trajId,
    path: t.path,
    outcome: t.outcome,
    eventCount: t.events.length,
    lineCount: t.lineCount,
  }))
}
