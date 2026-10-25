/**
 * Corpus parsing: read FrontierMemory trajectory JSONL files into typed
 * trajectories.
 *
 * The corpus is a folder of `.jsonl` files, one trajectory per file, pinned
 * by `SHA256SUMS`. Each line is a transcript event in Claude Code's export
 * format (`type: "user" | "assistant"`, a `message` envelope, `sessionId`,
 * `timestamp`, `cwd`). Rules (`docs/rules.md` upstream) say each trajectory
 * ends with its verifier result, `PASS` or `FAIL`; the shipped smoke corpus
 * has no result line, so outcome detection is tolerant: scan for verifier
 * result fields anywhere in the file, last match wins, default `unknown`.
 *
 * We never modify corpus data and never trust anything beyond the events.
 */

import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { Outcome } from "./ontology"

export interface TrajectoryEvent {
  /** 1-indexed position of the event line within the trajectory. */
  turn: number
  speaker: "user" | "assistant" | "other"
  text: string
  timestamp?: string
  cwd?: string
  /** Raw event type field, kept for provenance/debugging. */
  eventType: string
}

export interface Trajectory {
  /** File stem, used as the trajectory id everywhere (provenance, logs). */
  trajId: string
  path: string
  sessionId?: string
  events: TrajectoryEvent[]
  outcome: Outcome
  /** Where the outcome was detected, when it was. */
  outcomeSource?: string
  /** Total JSONL lines including any the parser could not use. */
  lineCount: number
}

interface ParsedLine {
  eventType: string
  speaker: "user" | "assistant" | "other"
  text: string
  timestamp?: string
  cwd?: string
  sessionId?: string
  outcomeHit?: { outcome: Outcome; source: string }
}

/** Pull plain text out of a Claude Code message content field. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>
          if (typeof p.text === "string") return p.text
          if (typeof p.content === "string") return p.content
        }
        return ""
      })
      .filter((t) => t.length > 0)
      .join("\n")
  }
  if (content && typeof content === "object") {
    const p = content as Record<string, unknown>
    if (typeof p.content === "string") return p.content
  }
  return ""
}

/**
 * Detect a verifier result on one JSONL line. FrontierMemory's rule is that
 * each trajectory "ends with its verifier result (`PASS` or `FAIL`)". The
 * published corpus embeds it; the smoke corpus does not. We accept the
 * common shapes without guessing harder than that:
 *   - {"result": "PASS"} / {"outcome": "PASS"} / {"verifier_result": "PASS"}
 *   - {"type": "verifier", "result": "PASS"}
 *   - a final user/system event whose text is exactly PASS/FAIL
 */
function detectOutcome(record: Record<string, unknown>, isLastLine: boolean): Outcome | undefined {
  for (const key of ["result", "outcome", "verifier_result", "verifierResult"]) {
    const value = record[key]
    if (value === "PASS" || value === "FAIL") return value
    if (value && typeof value === "object") {
      const inner = (value as Record<string, unknown>).result
      if (inner === "PASS" || inner === "FAIL") return inner
    }
  }
  const type = typeof record.type === "string" ? record.type : ""
  if (/verif/i.test(type) || /verif/i.test(String(record.role ?? ""))) {
    const text = messageText(record.message).trim().toUpperCase()
    if (text === "PASS" || text === "FAIL") return text
  }
  if (isLastLine) {
    const text = messageText(record.message).trim().toUpperCase()
    if (text === "PASS" || text === "FAIL") return text
  }
  return undefined
}

function parseLine(line: string, isLastLine: boolean): ParsedLine | undefined {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!record || typeof record !== "object") return undefined

  const outcomeHit = detectOutcome(record, isLastLine)
  const message = record.message as Record<string, unknown> | undefined
  const rawRole = (message?.role ?? record.role) as string | undefined
  const type = typeof record.type === "string" ? record.type : (rawRole ?? "other")

  const speaker: ParsedLine["speaker"] =
    rawRole === "user" || type === "user"
      ? "user"
      : rawRole === "assistant" || type === "assistant"
        ? "assistant"
        : "other"

  // Tool results and other non-text events are still events but carry no
  // conversational text worth extracting.
  let text = ""
  if (message) text = messageText(message.content)
  else if (typeof record.content === "string") text = record.content
  if (!text && speaker === "other" && !outcomeHit) return undefined

  return {
    eventType: type,
    speaker,
    text,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    outcomeHit: outcomeHit ? { outcome: outcomeHit, source: type || "record" } : undefined,
  }
}

export function parseTrajectoryJsonl(contents: string, trajId: string, path: string): Trajectory {
  const lines = contents.split("\n").filter((l) => l.trim().length > 0)
  const events: TrajectoryEvent[] = []
  let sessionId: string | undefined
  let outcome: Outcome = "unknown"
  let outcomeSource: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i === lines.length - 1)
    if (!parsed) continue
    if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId
    if (parsed.outcomeHit) {
      outcome = parsed.outcomeHit.outcome
      outcomeSource = parsed.outcomeHit.source
      continue
    }
    events.push({
      turn: events.length + 1,
      speaker: parsed.speaker,
      text: parsed.text,
      timestamp: parsed.timestamp,
      cwd: parsed.cwd,
      eventType: parsed.eventType,
    })
  }

  return { trajId, path, sessionId, events, outcome, outcomeSource, lineCount: lines.length }
}

export async function parseTrajectoryFile(path: string): Promise<Trajectory> {
  const trajId = basename(path).replace(/\.jsonl$/i, "")
  const contents = await readFile(path, "utf-8")
  return parseTrajectoryJsonl(contents, trajId, path)
}

/** Load every `.jsonl` trajectory in a corpus directory, sorted by file name. */
export async function loadCorpus(corpusDir: string, limit?: number): Promise<Trajectory[]> {
  const entries = await readdir(corpusDir)
  const files = entries.filter((f) => f.toLowerCase().endsWith(".jsonl")).sort()
  const selected = limit !== undefined ? files.slice(0, limit) : files
  return Promise.all(selected.map((f) => parseTrajectoryFile(join(corpusDir, f))))
}

/** Render one event as a compact transcript line for extraction prompts. */
export function formatEventForPrompt(event: TrajectoryEvent): string {
  const stamp = event.timestamp ? ` [${event.timestamp}]` : ""
  return `${event.speaker}${stamp}: ${event.text.replace(/\s+/g, " ").trim()}`
}
