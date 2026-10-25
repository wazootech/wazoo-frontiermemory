/**
 * Claim extraction: turn trajectories into `worlds:Claim` assertions with
 * trajectory provenance.
 *
 * Two extractors, deliberately:
 *
 * 1. `extractClaimsLlm` — DeepSeek via the standard OpenAI-compatible
 *    endpoint, prompted for a JSON array of claims. Bounded retries; on
 *    exhaustion or an empty/garbled response we fall through to (2) rather
 *    than dying: memorybench's extraction is fatal on error and that is the
 *    wrong default inside a 6-hour generation budget.
 * 2. `extractClaimsFallback` — deterministic keyword-based extraction, no
 *    network, fully testable. Also the extraction path for
 *    `--fallback-only` runs and for unit tests.
 *
 * Every claim carries: trajId, turn, outcome (the trajectory's verifier
 * result), and which extractor produced it.
 */

import type { Outcome } from "./ontology"
import { formatEventForPrompt, type Trajectory, type TrajectoryEvent } from "./corpus"
import { DeepSeekClient, withRetries } from "./deepseek"

export type ClaimType = "fact" | "event" | "preference" | "relationship" | "plan"
export type Extractor = "llm" | "fallback"

export interface Claim {
  id: string
  type: ClaimType
  subject: string
  action?: string
  object?: string
  claimText: string
  when?: string
  where?: string
  /** Provenance: trajectory file stem. */
  trajId: string
  /** Provenance: 1-indexed event position the claim came from. */
  turn: number
  /** Provenance: the trajectory's verifier result. */
  outcome: Outcome
  speaker: "user" | "assistant" | "other"
  extractor: Extractor
}

export const EXTRACTION_MODEL_DEFAULT = "deepseek-v4-flash"
export const EXTRACTION_MAX_TOKENS = 4000
export const EXTRACTION_MAX_RETRIES = 4
export const EXTRACTION_BASE_DELAY_MS = 2000

export interface ExtractOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Skip the LLM entirely (deterministic mode; also the unit-test path). */
  fallbackOnly?: boolean
  /** Cap on user+assistant turns sent to the model per trajectory. */
  maxPromptEvents?: number
}

export async function extractClaimsForTrajectory(
  traj: Trajectory,
  options: ExtractOptions = {}
): Promise<Claim[]> {
  if (options.fallbackOnly) return extractClaimsFallback(traj)
  try {
    const claims = await extractClaimsLlm(traj, options)
    if (claims.length > 0) return claims
  } catch {
    // Bounded retries exhausted — fall through to the deterministic extractor.
  }
  return extractClaimsFallback(traj)
}

function conversationText(traj: Trajectory, maxEvents?: number): string {
  const events = maxEvents ? traj.events.slice(0, maxEvents) : traj.events
  return events.map((e) => `[turn ${e.turn}] ${formatEventForPrompt(e)}`).join("\n")
}

export function buildExtractionPrompt(traj: Trajectory, maxEvents?: number): string {
  return `You are a memory-extraction system for an agent-memory benchmark. Read one agent trajectory (a user and an assistant working on a task) and extract the durable facts, preferences, plans, events, and relationships it reveals as a JSON array. This memory will later be used by a different agent on different tasks, so extract what TRANSFERS: working rules, user preferences, environment facts, and what went wrong — not a summary of the conversation.

Trajectory id: ${traj.trajId}
Trajectory verifier result: ${traj.outcome}
Participants: "user" (the human) and "assistant" (the agent)

<trajectory>
${conversationText(traj, maxEvents)}
</trajectory>

Extract each item as a JSON object with these fields:
- "type": one of "fact", "event", "preference", "relationship", "plan"
- "subject": who or what the assertion is about ("user" for the human, "assistant" for the agent, otherwise the entity's name)
- "action": (optional) verb phrase, e.g. "prefers", "asked to reuse", "runs"
- "object": (optional) target or detail, e.g. "one-line changelog entries"
- "claimText": a single self-contained sentence stating the assertion, independently searchable, including all key entities and paths
- "when": (optional) absolute date or timeframe if stated
- "where": (optional) location or path if stated

Rules:
- Extract ONLY what the trajectory explicitly shows. Resolve "the user" to "user".
- Prefer instruction-shaped assertions the way the user phrased them ("keep it to a few bullets", "don't schedule anything") over neutral paraphrases.
- A preference stated while correcting a failed attempt is still a preference; the FAIL outcome is recorded separately as provenance, do not invent extra claims about failure.
- Each distinct assertion exactly once. Do not restate the same fact in different words.
- claimText must be a complete sentence, e.g. "User wants daily summaries limited to a few bullets about changes they would care about."

Respond with ONLY a JSON array. No markdown fences, no commentary.`
}

/** Parse the model's JSON array into validated claims. Throws on garbage. */
export function parseLlmClaims(raw: string, traj: Trajectory): Claim[] {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
  const start = trimmed.indexOf("[")
  const end = trimmed.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON array in LLM response")
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error("LLM response is not an array")

  const claims: Claim[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const claimText = typeof rec.claimText === "string" ? rec.claimText.trim() : ""
    if (!claimText) continue
    const type = normalizeType(rec.type)
    const eventIndex = typeof rec.turn === "number" ? rec.turn : traj.events.length
    claims.push({
      id: claimId(traj.trajId, eventIndex, claimText),
      type,
      subject: typeof rec.subject === "string" && rec.subject.trim() ? rec.subject.trim() : "user",
      action: str(rec.action),
      object: str(rec.object),
      claimText,
      when: str(rec.when),
      where: str(rec.where),
      trajId: traj.trajId,
      turn: Math.max(1, eventIndex),
      outcome: traj.outcome,
      speaker: "user",
      extractor: "llm",
    })
  }
  return claims
}

function str(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : ""
  return s.length > 0 ? s : undefined
}

function normalizeType(value: unknown): ClaimType {
  const s = typeof value === "string" ? value.toLowerCase() : ""
  if (s === "event") return "event"
  if (s === "preference") return "preference"
  if (s === "relationship") return "relationship"
  if (s === "plan") return "plan"
  return "fact"
}

async function extractClaimsLlm(traj: Trajectory, options: ExtractOptions): Promise<Claim[]> {
  const client = new DeepSeekClient({ apiKey: options.apiKey, baseUrl: options.baseUrl })
  const raw = await withRetries(
    () =>
      client.chatCompletion({
        model: options.model ?? process.env.EXTRACTION_MODEL ?? EXTRACTION_MODEL_DEFAULT,
        prompt: buildExtractionPrompt(traj, options.maxPromptEvents),
        maxTokens: EXTRACTION_MAX_TOKENS,
        temperature: 0,
        responseFormat: "json_object" as const,
        thinking: "disabled",
      }),
    { maxRetries: EXTRACTION_MAX_RETRIES, baseDelayMs: EXTRACTION_BASE_DELAY_MS }
  ).then((r) => r.text)

  let claims: Claim[]
  try {
    claims = parseLlmClaims(raw, traj)
  } catch {
    // json_object mode should keep this rare; one reprompt round before fallback.
    const retry = await client.chatCompletion({
      model: options.model ?? process.env.EXTRACTION_MODEL ?? EXTRACTION_MODEL_DEFAULT,
      prompt:
        buildExtractionPrompt(traj, options.maxPromptEvents) +
        "\n\nYour previous response was not a valid JSON array. Respond with ONLY the JSON array.",
      maxTokens: EXTRACTION_MAX_TOKENS,
      temperature: 0,
      responseFormat: "json_object" as const,
      thinking: "disabled",
    })
    claims = parseLlmClaims(retry.text, traj)
  }
  return claims
}

/** Stable claim id: same content re-extracted mints the same id. */
export function claimId(trajId: string, turn: number, claimText: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(`${trajId}/${turn}/${claimText}`).digest("hex")
  return `urn:claim:${trajId}:${turn}:${hash.slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Deterministic fallback extractor
// ---------------------------------------------------------------------------

interface CueRule {
  type: ClaimType
  action: string
  patterns: RegExp[]
}

/** Preference/working-rule cues, matched against user turns. */
const USER_CUES: CueRule[] = [
  {
    type: "preference",
    action: "prefers",
    patterns: [
      /\bi (?:prefer|like|love|want|need|would rather|'d rather)\b/i,
      /\bi (?:do(?:n'|n)o)?t (?:like|want|need)\b/i,
      /\b(?:always|never|don'?t|do not|stop|keep it|make it|just)\b.{0,60}\b(?:format|bullet|summary|file|name|directory|commit|message|structure|output)\b/i,
    ],
  },
  {
    type: "preference",
    action: "corrected",
    patterns: [
      /\b(?:no|nope|not that|wrong|instead|rather|actually)\b[, ]/i,
      /\bdon'?t (?:use|do|add|call|schedule|touch|change|install)\b/i,
      /\buse (\S+) instead\b/i,
    ],
  },
  {
    type: "fact",
    action: "stated identity",
    patterns: [/\bmy name is\b/i, /\bcall me\b/i, /\bi work\b/i, /\bi(?:'m| am) (?:a|an)\b/i],
  },
]

/** Environment facts: paths, config files, commands, ports. */
const ENV_PATH_RE = /(?:^|[\s`"'])(\/[\w./@+-]{2,}|\.{0,2}\/[\w./@+-]+|~\/[\w./@+-]+)/
const ENV_TOOL_RE =
  /\b(?:config\/[\w./-]+|\.env(?:\.\w+)?|Makefile|package\.json|tsconfig\.json|README\.md)\b/
const ENV_COMMAND_RE = /\b(?:npm|bun|pnpm|yarn|cargo|go|docker|kubectl|git)\s+\w[\w-]*/g

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
}

function firstMatch(sentence: string, rule: CueRule): boolean {
  return rule.patterns.some((p) => p.test(sentence))
}

/**
 * Deterministic keyword-based extraction. Conservative on purpose: it emits
 * a claim only when a cue or an environment pattern fires on a specific
 * sentence, and never invents subjects beyond user/assistant.
 */
export function extractClaimsFallback(traj: Trajectory): Claim[] {
  const claims: Claim[] = []
  const seen = new Set<string>()

  const push = (
    claim: Omit<Claim, "id" | "trajId" | "turn" | "outcome" | "speaker" | "extractor">,
    event: TrajectoryEvent
  ) => {
    const key = claim.claimText.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    claims.push({
      id: claimId(traj.trajId, event.turn, claim.claimText),
      trajId: traj.trajId,
      turn: event.turn,
      outcome: traj.outcome,
      speaker: event.speaker === "user" ? "user" : event.speaker,
      extractor: "fallback",
      ...claim,
    })
  }

  for (const event of traj.events) {
    for (const sentence of sentencesOf(event.text)) {
      if (event.speaker === "user") {
        for (const rule of USER_CUES) {
          if (firstMatch(sentence, rule)) {
            push(
              {
                type: rule.type,
                subject: "user",
                action: rule.action,
                claimText: sentence.replace(/\s+/g, " "),
              },
              event
            )
            break
          }
        }
      }

      const pathMatch = sentence.match(ENV_PATH_RE)
      const toolMatch = sentence.match(ENV_TOOL_RE)
      const commandMatch = sentence.match(ENV_COMMAND_RE)
      if ((pathMatch || toolMatch || commandMatch) && event.speaker !== "user") {
        const where = pathMatch?.[1]?.trim() ?? toolMatch?.[0]
        push(
          {
            type: "fact",
            subject: "environment",
            action: commandMatch ? "uses command" : "references path",
            object: where ?? commandMatch?.[0],
            claimText: sentence.replace(/\s+/g, " "),
            where,
          },
          event
        )
      }
    }
  }
  return claims
}
