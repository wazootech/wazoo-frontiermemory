/**
 * Corpus parsing: read FrontierMemory trajectory files into typed
 * trajectories.
 *
 * The real corpus (pinned by `SHA256SUMS`) ships three on-disk formats:
 *
 * 1. Event-stream `.jsonl` (Codex-style export; several related shapes): one
 *    JSON object per line. The event-stream shape nests everything under
 *    `payload` (`type: session_meta | event_msg | response_item | world_state
 *    | turn_context`); conversation text lives in `response_item` payloads
 *    (`message`, `custom_tool_call`, `custom_tool_call_output`), while
 *    `event_msg` items are skipped because they either duplicate a real
 *    message (`task_complete.last_agent_message` mirrors the final assistant
 *    message) or carry bookkeeping (`token_count`, `reasoning`,
 *    `item_completed`). The flat dreambench-curation shape carries `text` at
 *    the top level (`user_message`, `agent_message`, `tool_call`). The smoke
 *    fixture's flat Claude Code shape (`message.content` at the top level)
 *    also parses. Rules (`docs/rules.md` upstream) say each trajectory ends
 *    with its verifier result, `PASS` or `FAIL`; the shipped smoke corpus has
 *    no result line, so outcome detection is tolerant: scan for verifier
 *    result fields anywhere in the file, last match wins, default `unknown`.
 * 2. ATIF `.json` (agent-trajectory interchange, `schema_version`
 *    ATIF-v1.2 … v1.7): `{schema_version, session_id, agent, steps[],
 *    final_metrics}` where each step is
 *    `{step_id, timestamp, source, message, tool_calls[], observation,
 *    reasoning_content, ...}` and the outcome is a `user` step whose
 *    message starts with `# Verifier result`.
 * 3. OpenCode session exports `.json` (`{info, messages[]}`, one message
 *    per model turn with typed `parts`): same verifier marker as (2),
 *    carried as the final `user` message.
 *
 * We never modify corpus data and never trust anything beyond the events.
 */

import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { Outcome } from "./ontology"

/** Which on-disk format a trajectory was parsed from. */
export type TrajectoryFormat = "jsonl" | "atif" | "opencode"

export interface TrajectoryEvent {
  /** 1-indexed position of the event within the trajectory. */
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
  /** Total lines (jsonl) or steps/messages (atif/opencode). */
  lineCount: number
  /** Which of the corpus formats this was parsed from. */
  format?: TrajectoryFormat
}

/** Options shared by the structured-format parsers. */
export interface ParseOptions {
  /**
   * Include chain-of-thought (`reasoning_content` on ATIF steps, `reasoning`
   * parts on OpenCode messages) in the rendered text. Off by default: it is
   * huge relative to its extraction value.
   */
  includeReasoning?: boolean
}

interface ParsedLine {
  eventType: string
  speaker: "user" | "assistant" | "other"
  text: string
  timestamp?: string
  cwd?: string
  sessionId?: string
  toolCallId?: string
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

/** Verifier result embedded in message text (`# Verifier result\n\nPASS`). */
function verifierOutcomeFromText(text: string): Outcome | undefined {
  if (!/^#\s*Verifier result/i.test(text)) return undefined
  const body = text.slice(text.indexOf("\n") + 1)
  if (/\bPASS\b/.test(body)) return "PASS"
  if (/\bFAIL\b/.test(body)) return "FAIL"
  return undefined
}

/**
 * Detect a verifier result on one JSONL line. FrontierMemory's rule is that
 * each trajectory "ends with its verifier result (`PASS` or `FAIL`)". The
 * published corpus embeds it as a final user message whose text starts with
 * `# Verifier result`; the smoke corpus does not. We accept the common
 * shapes without guessing harder than that:
 *   - {"result": "PASS"} / {"outcome": "PASS"} / {"verifier_result": "PASS"}
 *   - {"type": "verifier", "result": "PASS"}
 *   - a user/system message whose text starts with `# Verifier result`
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
  const message = record.message as Record<string, unknown> | undefined
  const payload = record.payload as Record<string, unknown> | undefined
  // In the event-stream shape the payload *is* the message when its type is
  // "message"; otherwise it may carry a nested message object.
  const nestedMessage = (
    payload?.type === "message"
      ? payload
      : (payload?.message as Record<string, unknown> | undefined)
  ) as Record<string, unknown> | undefined
  for (const container of [message, nestedMessage]) {
    const text = container ? messageText(container.content) : ""
    const verdict = verifierOutcomeFromText(text)
    if (verdict) return verdict
  }
  // Flat dreambench-curation shape: {type: "user_message", text: "# Verifier result\n\nFAIL"}
  const flatVerdict = verifierOutcomeFromText(typeof record.text === "string" ? record.text : "")
  if (flatVerdict) return flatVerdict
  if (isLastLine) {
    const text = messageText(record.message).trim().toUpperCase()
    if (text === "PASS" || text === "FAIL") return text
  }
  return undefined
}

function parseLine(line: string, isLastLine: boolean, ctx: JsonlContext): ParsedLine | undefined {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!record || typeof record !== "object") return undefined

  const outcomeHit = detectOutcome(record, isLastLine)
  const message = record.message as Record<string, unknown> | undefined
  const payload = record.payload as Record<string, unknown> | undefined
  const nestedMessage = (
    payload?.type === "message"
      ? payload
      : (payload?.message as Record<string, unknown> | undefined)
  ) as Record<string, unknown> | undefined
  const rawRole = ((message ?? nestedMessage)?.role ?? record.role) as string | undefined
  const type = typeof record.type === "string" ? record.type : (rawRole ?? "other")

  const speaker: ParsedLine["speaker"] =
    rawRole === "user" || type === "user" || type === "user_message"
      ? "user"
      : rawRole === "assistant" || type === "assistant" || type === "agent_message"
        ? "assistant"
        : "other"

  // Tool results and other non-text events are still events but carry no
  // conversational text worth extracting.
  let text = ""
  if (message) text = messageText(message.content)
  else if (nestedMessage) text = messageText(nestedMessage.content)
  else if (typeof record.content === "string") text = record.content
  else if (typeof record.text === "string") text = record.text

  // Flat tool_call records ({type: "tool_call", kind/title/status}) render
  // as a compact Tool line like the other formats.
  if (type === "tool_call") {
    const name = str(record.name) ?? str(record.tool) ?? str(record.kind) ?? "tool"
    const detail =
      str(record.command) ?? str(record.input) ?? str(record.title) ?? str(record.query)
    return {
      eventType: type,
      speaker: "other",
      text: `Tool ${name}${detail ? `: ${detail}` : ""}`,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
      cwd: typeof record.cwd === "string" ? record.cwd : ctx.cwd,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : ctx.sessionId,
      outcomeHit: outcomeHit ? { outcome: outcomeHit, source: type } : undefined,
    }
  }

  // Event-stream format: conversation lives inside `payload`. `event_msg`
  // lines are bookkeeping or duplicates of response_item messages; developer
  // messages are static instructions. `session_meta` / `turn_context` seed
  // session id and cwd.
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>
    const payloadType = typeof p.type === "string" ? p.type : ""
    if (type === "session_meta") {
      if (!ctx.sessionId && typeof p.session_id === "string") ctx.sessionId = p.session_id
      if (!ctx.cwd && typeof p.cwd === "string") ctx.cwd = p.cwd
      return undefined
    }
    if (type === "turn_context") {
      if (!ctx.cwd && typeof p.cwd === "string") ctx.cwd = p.cwd
      return undefined
    }
    if (type === "event_msg" || type === "world_state" || payloadType === "reasoning")
      return undefined
    if (payloadType === "message") {
      if (rawRole === "developer" || rawRole === "system") return undefined
      text = messageText(p.content)
    } else if (payloadType === "custom_tool_call") {
      const callId = typeof p.call_id === "string" ? p.call_id : undefined
      const input = typeof p.input === "string" ? p.input : messageText(p.input)
      text = `Tool ${typeof p.name === "string" ? p.name : "tool"}: ${clip(input, 200)}`
      return {
        eventType: payloadType,
        speaker: "other",
        text,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        toolCallId: callId,
        outcomeHit: outcomeHit ? { outcome: outcomeHit, source: type || "record" } : undefined,
      }
    } else if (payloadType === "custom_tool_call_output") {
      // Attach the tool result to its call when we still can; otherwise drop
      // it, a bare observation without its command is noise.
      const callId = typeof p.call_id === "string" ? p.call_id : undefined
      if (callId) ctx.pendingOutputs.set(callId, messageText(p.output))
      return undefined
    } else if (!text) {
      return undefined
    }
  }

  if (!text && speaker === "other" && !outcomeHit) return undefined

  return {
    eventType: type,
    speaker,
    text,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : ctx.cwd,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : ctx.sessionId,
    outcomeHit: outcomeHit ? { outcome: outcomeHit, source: type || "record" } : undefined,
  }
}

interface JsonlContext {
  sessionId?: string
  cwd?: string
  /** tool_call_id -> most recent output text, attached to the call event. */
  pendingOutputs: Map<string, string>
}

export function parseTrajectoryJsonl(contents: string, trajId: string, path: string): Trajectory {
  const lines = contents.split("\n").filter((l) => l.trim().length > 0)
  const events: TrajectoryEvent[] = []
  const ctx: JsonlContext = { pendingOutputs: new Map() }
  let outcome: Outcome = "unknown"
  let outcomeSource: string | undefined

  // Pre-pass: map tool_call_id -> output text so a custom_tool_call event can
  // carry its own observation even though the output line follows it.
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const payload = record?.payload as Record<string, unknown> | undefined
      if (
        payload &&
        payload.type === "custom_tool_call_output" &&
        typeof payload.call_id === "string"
      ) {
        ctx.pendingOutputs.set(payload.call_id, messageText(payload.output))
      }
    } catch {
      // malformed lines are skipped by the main pass too
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i === lines.length - 1, ctx)
    if (!parsed) continue
    if (parsed.sessionId && !ctx.sessionId) ctx.sessionId = parsed.sessionId
    if (parsed.outcomeHit) {
      outcome = parsed.outcomeHit.outcome
      outcomeSource = parsed.outcomeHit.source
      continue
    }
    // If an earlier tool call is waiting for this output, fold it in.
    if (parsed.toolCallId) {
      const obs = ctx.pendingOutputs.get(parsed.toolCallId)
      if (obs) {
        parsed.text += `\nobs: ${clip(obs, OBSERVATION_CLIP)}`
        ctx.pendingOutputs.delete(parsed.toolCallId)
      }
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

  return {
    trajId,
    path,
    sessionId: ctx.sessionId,
    events,
    outcome,
    outcomeSource,
    lineCount: lines.length,
    format: "jsonl",
  }
}

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

/** Observation text is truncated to roughly this many characters. */
const OBSERVATION_CLIP = 300

interface AtifStep {
  step_id?: number | string
  timestamp?: string
  source?: string
  message?: string
  reasoning_content?: string
  tool_calls?: Array<{
    function_name?: string
    arguments?: Record<string, unknown>
  }>
  observation?: unknown
}

interface AtifDocument {
  schema_version?: string
  session_id?: string
  agent?: { name?: string; version?: string; model_name?: string; extra?: { cwds?: string[] } }
  steps?: AtifStep[]
}

/** One readable line per tool call: the most telling argument we can find. */
function describeToolCall(call: NonNullable<AtifStep["tool_calls"]>[number]): string {
  const name = call.function_name ?? "tool"
  const args = call.arguments ?? {}
  const primary =
    str(args.command) ??
    str(args.cmd) ??
    str(args.input) ??
    str(args.file_path) ??
    str(args.path) ??
    str(args.query) ??
    str(args.pattern) ??
    str(args.url) ??
    str(args.description)
  const tail = primary ? `: ${primary}` : ""
  return `Tool ${name}${tail}`
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  return undefined
}

/** Flatten an ATIF observation object into plain text. */
function observationText(observation: unknown): string {
  if (typeof observation === "string") return observation
  if (!observation || typeof observation !== "object") return ""
  const results = (observation as Record<string, unknown>).results
  if (!Array.isArray(results)) return ""
  return results
    .map((r) => {
      if (typeof r === "string") return r
      if (r && typeof r === "object") {
        const content = (r as Record<string, unknown>).content
        if (typeof content === "string") return content
        if (Array.isArray(content)) return messageText(content)
      }
      return ""
    })
    .filter((t) => t.length > 0)
    .join("\n")
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

function atifSpeaker(source: string | undefined): TrajectoryEvent["speaker"] {
  if (source === "user") return "user"
  if (source === "agent") return "assistant"
  return "other" // environment | system | anything else
}

/**
 * Parse one ATIF document into trajectories. Tool-call steps (whose
 * `message` is usually empty) render as a compact `Tool <name>: <args>`
 * line plus a clipped observation; chain-of-thought is skipped unless
 * `includeReasoning` is set. Verifier steps become the trajectory outcome,
 * not events.
 */
export function parseTrajectoryAtif(
  doc: AtifDocument,
  trajId: string,
  path: string,
  options: ParseOptions = {}
): Trajectory {
  const steps = Array.isArray(doc.steps) ? doc.steps : []
  const events: TrajectoryEvent[] = []
  let outcome: Outcome = "unknown"
  let outcomeSource: string | undefined
  const cwd = doc.agent?.extra?.cwds?.[0]

  for (const step of steps) {
    const source = typeof step.source === "string" ? step.source : ""
    const message = typeof step.message === "string" ? step.message : ""

    // Outcome marker: user step `# Verifier result\n\nPASS|FAIL`.
    const verdict = verifierOutcomeFromText(message)
    if (source === "user" && verdict) {
      outcome = verdict
      outcomeSource = "atif_verifier_step"
      continue
    }

    const parts: string[] = []
    if (
      options.includeReasoning &&
      typeof step.reasoning_content === "string" &&
      step.reasoning_content.trim()
    ) {
      parts.push(`[reasoning] ${clip(step.reasoning_content, 600)}`)
    }
    if (message.trim()) parts.push(message)
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (const call of step.tool_calls) parts.push(describeToolCall(call))
      const obs = observationText(step.observation)
      if (obs) parts.push(`obs: ${clip(obs, OBSERVATION_CLIP)}`)
    }
    if (parts.length === 0) continue

    events.push({
      turn: typeof step.step_id === "number" ? step.step_id : events.length + 1,
      speaker: atifSpeaker(source),
      text: parts.join("\n"),
      timestamp: step.timestamp,
      cwd,
      eventType: "atif_step",
    })
  }

  return {
    trajId,
    path,
    sessionId: typeof doc.session_id === "string" ? doc.session_id : undefined,
    events,
    outcome,
    outcomeSource,
    lineCount: steps.length,
    format: "atif",
  }
}

// ---------------------------------------------------------------------------
// OpenCode session export ({info, messages[]})
// ---------------------------------------------------------------------------

interface OpencodeMessage {
  info?: { role?: string; id?: string; time?: { created?: number }; path?: { cwd?: string } }
  parts?: Array<{
    type?: string
    text?: string
    tool?: string
    state?: { input?: Record<string, unknown>; output?: unknown }
  }>
}

interface OpencodeDocument {
  info?: { id?: string }
  messages?: OpencodeMessage[]
}

function parseTrajectoryOpencode(
  doc: OpencodeDocument,
  trajId: string,
  path: string,
  options: ParseOptions = {}
): Trajectory {
  const messages = Array.isArray(doc.messages) ? doc.messages : []
  const events: TrajectoryEvent[] = []
  let outcome: Outcome = "unknown"
  let outcomeSource: string | undefined
  let cwd: string | undefined

  for (const message of messages) {
    const role = message.info?.role ?? ""
    const speaker: TrajectoryEvent["speaker"] =
      role === "user" ? "user" : role === "assistant" ? "assistant" : "other"
    const created = message.info?.time?.created
    const timestamp = typeof created === "number" ? new Date(created).toISOString() : undefined
    if (!cwd && typeof message.info?.path?.cwd === "string") cwd = message.info.path.cwd

    const parts: string[] = []
    for (const part of message.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        parts.push(part.text)
      } else if (part.type === "tool" && part.tool) {
        const input = part.state?.input ?? {}
        const primary =
          str(input.command) ??
          str(input.cmd) ??
          str(input.query) ??
          str(input.url) ??
          str(input.file_path) ??
          str(input.pattern)
        parts.push(`Tool ${part.tool}${primary ? `: ${primary}` : ""}`)
        const out = observationText(part.state?.output)
        if (out) parts.push(`obs: ${clip(out, OBSERVATION_CLIP)}`)
      } else if (
        part.type === "reasoning" &&
        options.includeReasoning &&
        typeof part.text === "string"
      ) {
        parts.push(`[reasoning] ${clip(part.text, 600)}`)
      }
      // step-start / step-finish carry no extraction value.
    }

    const joined = parts.join("\n").trim()
    const verdict = verifierOutcomeFromText(joined)
    if (verdict) {
      outcome = verdict
      outcomeSource = "opencode_verifier_message"
      continue
    }
    if (!joined) continue

    events.push({
      turn: events.length + 1,
      speaker,
      text: joined,
      timestamp,
      cwd,
      eventType: "opencode_message",
    })
  }

  return {
    trajId,
    path,
    sessionId: typeof doc.info?.id === "string" ? doc.info.id : undefined,
    events,
    outcome,
    outcomeSource,
    lineCount: messages.length,
    format: "opencode",
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Parse a corpus file in any of the shipped formats. */
export async function parseTrajectoryFile(
  path: string,
  options: ParseOptions = {}
): Promise<Trajectory> {
  const trajId = basename(path).replace(/\.(jsonl?|JSONL?)$/i, "")
  const contents = await readFile(path, "utf-8")
  if (/\.jsonl$/i.test(path)) return parseTrajectoryJsonl(contents, trajId, path)

  let doc: unknown
  try {
    doc = JSON.parse(contents)
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${String(err).slice(0, 120)})`)
  }
  if (!doc || typeof doc !== "object") throw new Error(`${path}: JSON document is not an object`)
  const record = doc as Record<string, unknown>
  if (Array.isArray(record.steps))
    return parseTrajectoryAtif(doc as AtifDocument, trajId, path, options)
  if (Array.isArray(record.messages))
    return parseTrajectoryOpencode(doc as OpencodeDocument, trajId, path, options)
  throw new Error(`${path}: unrecognized format (no steps[] or messages[] array)`)
}

/**
 * Load every trajectory in a corpus directory (`.jsonl` and `.json`, all
 * three shipped formats), sorted by file name.
 */
export async function loadCorpus(
  corpusDir: string,
  limit?: number,
  options: ParseOptions = {}
): Promise<Trajectory[]> {
  const entries = await readdir(corpusDir)
  const files = entries.filter((f) => /\.jsonl?$/i.test(f)).sort()
  const selected = limit !== undefined ? files.slice(0, limit) : files
  return Promise.all(selected.map((f) => parseTrajectoryFile(join(corpusDir, f), options)))
}

/** Render one event as a compact transcript line for extraction prompts. */
export function formatEventForPrompt(event: TrajectoryEvent): string {
  const stamp = event.timestamp ? ` [${event.timestamp}]` : ""
  return `${event.speaker}${stamp}: ${event.text.replace(/\s+/g, " ").trim()}`
}
