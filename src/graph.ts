/**
 * Claim graph: serialize claims + trajectories as Turtle and import into an
 * embedded `@worlds/sqlite` store (bun:sqlite + FTS5 + sqlite-vec, zero
 * network — the rules-clean configuration).
 *
 * Same shapes memorybench emits: schema:Conversation per trajectory,
 * schema:Message per event, and one worlds:*Claim node per claim wired with
 * prov:wasDerivedFrom to its trajectory plus the Wazoo provenance extension
 * (wazoo:trajId, wazoo:turn, wazoo:outcome).
 */

import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { createSqliteWorldsSdk, type SqliteWorldsSdk } from "@worlds/sqlite"
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service"
import {
  PROV,
  RDF,
  SCHEMA,
  TURTLE_PREFIXES,
  WAZOO,
  WORLDS,
  CLAIM_TYPE_BY_NAME,
  outcomeTerm,
  type Outcome,
} from "./ontology"
import type { Claim } from "./extraction"
import type { Trajectory } from "./corpus"

export const DETERMINISTIC_EMBEDDING_DIMENSIONS = 256
export const TFJS_USE_EMBEDDING_DIMENSIONS = 512

/**
 * Deterministic hash embedding for tests and offline runs: no network, no
 * model files, stable across processes. Token n-grams hashed into a fixed
 * 256-dim bag; good enough to exercise the vector index end to end and to
 * keep `bun test` hermetic. The real run swaps in TFJS USE via --model-dir.
 */
export class DeterministicEmbeddingService implements EmbeddingService {
  readonly dimensions = DETERMINISTIC_EMBEDDING_DIMENSIONS

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text))
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0)
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    for (const token of tokens) {
      vec[hashToken(token) % this.dimensions] += 1
      for (let i = 0; i < token.length - 2; i++) {
        vec[hashToken(token.slice(i, i + 3)) % this.dimensions] += 0.5
      }
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1
    return vec.map((v) => v / norm)
  }
}

function hashToken(token: string): number {
  const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 8)
  return parseInt(hash, 16)
}

/**
 * TFJS Universal Sentence Encoder from a local model directory (model.json +
 * vocab.json), pre-downloaded during adapter install() — inside the
 * generation sandbox there is no network beyond the model API host, so the
 * weights must already be on disk.
 */
export async function loadTfjsUseEmbeddingService(modelDir: string): Promise<EmbeddingService> {
  const mod = await import("@worlds/sdk/tfjs-use")
  const service = new mod.UniversalSentenceEncoderEmbeddingService({
    modelUrl: join(modelDir, "model.json"),
    vocabUrl: join(modelDir, "vocab.json"),
  }) as unknown as EmbeddingService
  // Fail HERE with a named file, not deep inside import with the SDK's generic
  // "failed to vectorize literal chunk blocks" (observed on a real Modal run:
  // tfhub had served an HTML error page as model.json, and the true cause was
  // unreadable under three wrapping layers). One real embed on load: if the
  // model is corrupt this throws in seconds, naming the file.
  try {
    await service.embed(["pipeline model smoke test"])
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.slice(0, 300) : String(cause)
    throw new Error(
      `TFJS USE model at ${modelDir} failed a load-time embed; the corpus run is ` +
        `aborted BEFORE extraction so no budget is burned. Most likely a stub or ` +
        `error page among model.json / vocab.json / the 7 shards (the adapter's ` +
        `install verifies sizes, but re-download to be sure). Underlying error: ${detail}`,
      { cause }
    )
  }
  return service
}

export async function createGraphClient(opts: {
  dbPath: string
  modelDir?: string
  /** Reuse an open handle (tests). */
  db?: Database
  searchIndexOnImport?: "incremental" | "disabled"
}): Promise<SqliteWorldsSdk> {
  if (opts.modelDir) {
    const embeddingService = await loadTfjsUseEmbeddingService(opts.modelDir)
    return createSqliteWorldsSdk({
      path: opts.dbPath,
      db: opts.db ?? new Database(opts.dbPath),
      embeddingService,
      vectorDimensions: TFJS_USE_EMBEDDING_DIMENSIONS,
      searchIndexOnImport: opts.searchIndexOnImport ?? "incremental",
    })
  }
  return createSqliteWorldsSdk({
    path: opts.dbPath,
    db: opts.db ?? new Database(opts.dbPath),
    embeddingService: new DeterministicEmbeddingService(),
    vectorDimensions: DETERMINISTIC_EMBEDDING_DIMENSIONS,
    searchIndexOnImport: opts.searchIndexOnImport ?? "incremental",
  })
}

function turtleLiteral(value: string): string {
  return JSON.stringify(value)
}

function turtleInt(value: number): string {
  return `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`
}

export function trajectoryUrn(trajId: string): string {
  return `urn:traj:${trajId}`
}

export function eventUrn(trajId: string, turn: number): string {
  return `urn:traj:${trajId}/msg/${turn}`
}

export function serializeTrajectory(traj: Trajectory): string {
  const trajUri = trajectoryUrn(traj.trajId)
  const lines: string[] = []
  lines.push(`<${trajUri}> a schema:Conversation, wazoo:Trajectory ;`)
  lines.push(`  wazoo:trajId ${turtleLiteral(traj.trajId)} ;`)
  lines.push(`  wazoo:outcome <${outcomeTerm(traj.outcome)}> ;`)
  if (traj.sessionId) lines.push(`  schema:name ${turtleLiteral(traj.sessionId)} ;`)
  lines.push(`  prov:wasDerivedFrom ${turtleLiteral(traj.path)} .`)
  for (const event of traj.events) {
    const uri = eventUrn(traj.trajId, event.turn)
    lines.push(`<${uri}> a schema:Message ;`)
    lines.push(`  schema:text ${turtleLiteral(event.text)} ;`)
    lines.push(`  schema:position ${turtleInt(event.turn)} ;`)
    lines.push(`  schema:author ${turtleLiteral(event.speaker)} ;`)
    lines.push(`  prov:wasGeneratedBy ${trajUri} .`)
    if (event.timestamp)
      lines.push(`<${uri}> schema:dateCreated ${turtleLiteral(event.timestamp)} .`)
    if (event.cwd) lines.push(`<${uri}> schema:name ${turtleLiteral(event.cwd)} .`)
  }
  return lines.join("\n")
}

export function serializeClaim(claim: Claim): string {
  const type = CLAIM_TYPE_BY_NAME[claim.type] ?? WORLDS.FactClaim
  const lines: string[] = []
  lines.push(`<${claim.id}> a rdf:Statement, worlds:Claim, <${type}> ;`)
  lines.push(`  worlds:claimSubject ${turtleLiteral(claim.subject)} ;`)
  lines.push(`  worlds:claimText ${turtleLiteral(claim.claimText)} ;`)
  if (claim.action) lines.push(`  worlds:claimAction ${turtleLiteral(claim.action)} ;`)
  if (claim.object) lines.push(`  worlds:claimObject ${turtleLiteral(claim.object)} ;`)
  if (claim.when) lines.push(`  worlds:claimWhen ${turtleLiteral(claim.when)} ;`)
  if (claim.where) lines.push(`  worlds:claimWhere ${turtleLiteral(claim.where)} ;`)
  lines.push(`  worlds:status <${WORLDS.Active}> ;`)
  lines.push(`  prov:wasDerivedFrom <${trajectoryUrn(claim.trajId)}> ;`)
  lines.push(`  wazoo:trajId ${turtleLiteral(claim.trajId)} ;`)
  lines.push(`  wazoo:turn ${turtleInt(claim.turn)} ;`)
  lines.push(`  wazoo:outcome <${outcomeTerm(claim.outcome)}> ;`)
  lines.push(`  wazoo:speaker ${turtleLiteral(claim.speaker)} ;`)
  lines.push(`  wazoo:extractor ${turtleLiteral(claim.extractor)} .`)
  return lines.join("\n")
}

/**
 * The SPARQL engine's Turtle parser rejects \u escapes in the surrogate range
 * with "Invalid Unicode escape (surrogate code point)" (turtle-generated.ts
 * decodeUchar). Extraction text can contain lone surrogates as literal
 * characters (emoji split by naive upstream truncation); JSON.stringify
 * serializes such a string with the literal escape \ud83c, and import then
 * dies on it - observed on a real full-corpus Modal run (wazoo-ab-memory-10,
 * after ~56 minutes including the full extraction spend: worst-case cost,
 * zero artifact). Fix at the serialization boundary: pair any lone surrogate
 * with the replacement character so the Turtle stays parseable while the
 * provenance records what happened.
 */
const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g
const LONE_LOW = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g
export function sanitizeLoneSurrogates(text: string): string {
  return text.replace(LONE_HIGH, "\uFFFD").replace(LONE_LOW, (_m, lead) => `${lead}\uFFFD`)
}

export function serializeGraph(trajs: Trajectory[], claims: Claim[]): string {
  const blocks = [TURTLE_PREFIXES, ""]
  for (const traj of trajs) blocks.push(serializeTrajectory(sanitize(traj)), "")
  for (const claim of claims) blocks.push(serializeClaim(sanitize(claim)), "")
  return blocks.join("\n")
}

function sanitize<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === "string" ? sanitizeLoneSurrogates(v) : v,
    ])
  ) as T
}

/** Import claims into a fresh embedded store. Returns the open client. */
export async function importGraph(opts: {
  dbPath: string
  trajs: Trajectory[]
  claims: Claim[]
  modelDir?: string
  searchIndexOnImport?: "incremental" | "disabled"
}): Promise<SqliteWorldsSdk> {
  await mkdir(dirname(opts.dbPath), { recursive: true })
  const client = await createGraphClient({
    dbPath: opts.dbPath,
    modelDir: opts.modelDir,
    searchIndexOnImport: opts.searchIndexOnImport,
  })
  await client.import({
    source: {
      kind: "serialized",
      data: serializeGraph(opts.trajs, opts.claims),
      contentType: "text/turtle",
    },
  })
  return client
}

export { RDF, PROV, SCHEMA, WORLDS, WAZOO, type Outcome }
