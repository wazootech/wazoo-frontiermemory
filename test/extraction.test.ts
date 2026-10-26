import { beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadCorpus } from "../src/corpus"
import {
  buildExtractionPrompt,
  extractClaimsFallback,
  extractClaimsForTrajectory,
  parseLlmClaims,
} from "../src/extraction"
import { DeepSeekClient, withRetries } from "../src/deepseek"

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus")

describe("deterministic fallback extractor", () => {
  let traj: Awaited<ReturnType<typeof loadCorpus>>[number]
  beforeEach(async () => {
    traj = (await loadCorpus(FIXTURE_CORPUS))[0]
  })

  test("extracts preference and correction cues from the smoke trajectory", () => {
    const claims = extractClaimsFallback(traj)
    expect(claims.length).toBeGreaterThan(0)
    // Every claim carries full provenance.
    for (const claim of claims) {
      expect(claim.trajId).toBe("claude-code-intro")
      expect(claim.turn).toBeGreaterThan(0)
      expect(["PASS", "FAIL", "unknown"]).toContain(claim.outcome)
      expect(claim.extractor).toBe("fallback")
      expect(claim.claimText.length).toBeGreaterThan(8)
      expect(claim.id.startsWith("urn:claim:claude-code-intro:")).toBeTrue()
    }
    // The smoke trajectory has clear preference statements ("keep it to a few
    // bullets", "don't schedule anything") — cue matching must catch them.
    const joined = claims.map((c) => c.claimText).join(" ")
    expect(/keep it|don'?t schedule|nothing new/i.test(joined)).toBeTrue()
  })

  test("is deterministic: identical input, identical claims", () => {
    expect(extractClaimsFallback(traj)).toEqual(extractClaimsFallback(traj))
  })

  test("dedupes repeated assertions within a trajectory", () => {
    const claims = extractClaimsFallback(traj)
    const texts = new Set(claims.map((c) => c.claimText.toLowerCase()))
    expect(texts.size).toBe(claims.length)
  })
})

describe("LLM extraction plumbing (no network)", () => {
  let traj: Awaited<ReturnType<typeof loadCorpus>>[number]
  beforeEach(async () => {
    traj = (await loadCorpus(FIXTURE_CORPUS))[0]
  })

  test("prompt includes trajectory id, outcome, and turns", () => {
    const prompt = buildExtractionPrompt(traj)
    expect(prompt).toContain("claude-code-intro")
    expect(prompt).toContain("unknown")
    expect(prompt).toContain("[turn 1]")
    expect(prompt).toContain("ONLY a JSON array")
  })

  test("parseLlmClaims validates and stamps provenance", () => {
    const raw = JSON.stringify([
      {
        type: "preference",
        subject: "user",
        action: "prefers",
        object: "few bullets",
        claimText: "User wants summaries limited to a few bullets.",
        turn: 12,
      },
      { claimText: "" }, // dropped: empty text
      { claimText: "Another assertion without type.", turn: 0 },
      "garbage",
    ])
    const claims = parseLlmClaims(raw, traj)
    expect(claims).toHaveLength(2)
    expect(claims[0].type).toBe("preference")
    expect(claims[0].turn).toBe(12)
    expect(claims[0].trajId).toBe(traj.trajId)
    expect(claims[0].outcome).toBe(traj.outcome)
    expect(claims[0].extractor).toBe("llm")
    expect(claims[1].type).toBe("fact")
    expect(claims[1].turn).toBe(1)
  })

  test("parseLlmClaims strips markdown fences and surrounding prose", () => {
    const raw = 'Sure! ```json\n[{"claimText":"Fenced claim."}]\n```'
    const claims = parseLlmClaims(raw, traj)
    expect(claims).toHaveLength(1)
    expect(claims[0].claimText).toBe("Fenced claim.")
  })

  test("fallback engages when the LLM path fails (bad key, offline)", async () => {
    const claims = await extractClaimsForTrajectory(traj, {
      apiKey: "not-a-real-key",
      fallbackOnly: false,
    })
    // No network here: fetch fails or 401s after bounded retries, then the
    // deterministic extractor carries the phase.
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.extractor === "fallback")).toBeTrue()
  }, 60_000)

  test("fallbackOnly skips the network entirely", async () => {
    const claims = await extractClaimsForTrajectory(traj, { fallbackOnly: true })
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.extractor === "fallback")).toBeTrue()
  })

  test("onRun telemetry fires once per trajectory", async () => {
    const seen: Array<{ trajId: string; fallback: boolean; attempts: number }> = []
    await extractClaimsForTrajectory(traj, {
      fallbackOnly: true,
      onRun: (info) =>
        seen.push({ trajId: info.trajId, fallback: info.fallback, attempts: info.attempts }),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].trajId).toBe(traj.trajId)
    expect(seen[0].fallback).toBeTrue()
  })
})

describe("retry policy", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test("withRetries is bounded and surfaces the last error", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("offline")
    }) as unknown as typeof fetch
    await expect(
      withRetries(() => fetch("https://invalid.invalid"), { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow()
    expect(calls).toBe(3) // initial + 2 retries, never more
  })

  test("withRetries succeeds after transient failures", async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw new Error("transient")
      return "ok"
    }
    expect(await withRetries(fn, { maxRetries: 4, baseDelayMs: 1 })).toBe("ok")
  })

  test("DeepSeekClient fails fast without a key", () => {
    const saved = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      expect(() => new DeepSeekClient()).toThrow("DEEPSEEK_API_KEY is not set")
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved
    }
  })
})
