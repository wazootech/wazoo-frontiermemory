import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDreamReport,
  consolidateSimilar,
  isEnvironmentFactClaim,
  jaccardSimilarity,
  type ClaimBinding,
} from "../src/dream"
import { exportMemory } from "../src/export"

function binding(
  overrides: Partial<ClaimBinding> & { claimText: string; trajId: string }
): ClaimBinding {
  return {
    type: "fact",
    turn: 1,
    outcome: "FAIL",
    speaker: "user",
    ...overrides,
  }
}

describe("near-duplicate consolidation", () => {
  test("token similarity ranks obviously similar above obviously different", () => {
    const a =
      "The user requires bidirectional_flows to require the exact reversed five-tuple and to count each distinct forward/reverse pair once rather than once per direction or via a separately populated reverse-key set."
    const b =
      "User requires bidirectional_flows to require the exact reversed five-tuple and to count each distinct forward/reverse pair once rather than once per direction."
    const c = "Always write the changelog under docs/changelog.md with one bullet per change"
    const cheatA =
      "The user instructed the assistant not to cheat by using online solutions or hints specific to this task."
    const cheatB =
      "The user prohibits cheating by using online solutions or hints specific to the essay scoring task."
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.75)
    expect(jaccardSimilarity(cheatA, cheatB)).toBeGreaterThanOrEqual(0.75)
    expect(jaccardSimilarity(a, c)).toBeLessThan(0.75)
  })

  test("consolidateSimilar merges near-duplicates and keeps the shortest phrasing", () => {
    const items = [
      {
        key: "k-long",
        text: "The user requires bidirectional_flows to require the exact reversed five-tuple and to count each distinct forward/reverse pair once rather than once per direction or via a separately populated reverse-key set.",
        evidence: [{ trajId: "t1", turn: 4, outcome: "FAIL" as const }],
        support: 1,
        claimTypes: ["preference" as const],
      },
      {
        key: "k-short",
        text: "User requires bidirectional_flows to count each distinct forward/reverse pair once rather than once per direction.",
        evidence: [{ trajId: "t2", turn: 7, outcome: "PASS" as const }],
        support: 1,
        claimTypes: ["preference" as const],
      },
      {
        key: "k-other",
        text: "Never wait more than 60 seconds per command; poll with empty keystrokes instead.",
        evidence: [{ trajId: "t3", turn: 2, outcome: "FAIL" as const }],
        support: 1,
        claimTypes: ["preference" as const],
      },
    ]
    const merged = consolidateSimilar(items)
    expect(merged).toHaveLength(2)
    const bidirectional = merged.find((i) => i.text.includes("bidirectional_flows"))
    expect(bidirectional).toBeDefined()
    // Shortest phrasing survives, provenance from both members merges in.
    expect(bidirectional?.text).toBe(items[1].text)
    expect(bidirectional?.key).toBe("k-short")
    expect(bidirectional?.support).toBe(2)
    const trajIds = new Set(bidirectional?.evidence.map((e) => e.trajId) ?? [])
    expect(trajIds.has("t1")).toBeTrue()
    expect(trajIds.has("t2")).toBeTrue()
  })

  test("three phrasings of the same rule collapse to one task rule", () => {
    const rule = (trajId: string, turn: number, text: string): ClaimBinding =>
      binding({ claimText: text, trajId, turn, type: "preference", action: "requires" })
    const bindings: ClaimBinding[] = [
      rule(
        "t001",
        12,
        "The user requires bidirectional_flows to require the exact reversed five-tuple and to count each distinct forward/reverse pair once rather than once per direction or via a separately populated reverse-key set."
      ),
      rule(
        "t002",
        30,
        "User requires bidirectional_flows to require the exact reversed five-tuple and to count each distinct forward/reverse pair once rather than once per direction or via a separately populated reverse-key set."
      ),
      rule(
        "t003",
        5,
        "User requires bidirectional_flows to count each distinct forward/reverse pair once rather than once per direction."
      ),
      rule(
        "t004",
        9,
        "Command durations must never exceed 60 seconds; poll with empty keystrokes instead."
      ),
    ]
    const report = buildDreamReport(bindings)
    const bidirectionalRules = report.taskRules.filter((r) =>
      r.text.includes("bidirectional_flows")
    )
    expect(bidirectionalRules).toHaveLength(1)
    expect(bidirectionalRules[0].support).toBe(3)
    expect(new Set(bidirectionalRules[0].evidence.map((e) => e.trajId)).size).toBe(3)
  })
})

describe("boilerplate stripping", () => {
  test("memory lines are bare instructions, no render prefix", () => {
    const bindings: ClaimBinding[] = [
      binding({
        claimText:
          "The user requires that is_traffic_benign be set from the supported attack flags rather than from the dataset name.",
        trajId: "t001",
        type: "preference",
        action: "requires",
      }),
      binding({
        claimText:
          "The user instructs the agent not to ask clarifying questions and to make reasonable assumptions.",
        trajId: "t002",
        type: "preference",
        action: "prefers",
      }),
      binding({
        claimText:
          "The environment does not have ripgrep (`rg`) installed, so grep and find must be used instead.",
        trajId: "t003",
      }),
    ]
    const report = buildDreamReport(bindings)
    const instructions = [
      ...report.taskRules,
      ...report.userPreferences,
      ...report.environmentFacts,
    ].map((i) => i.instruction)
    expect(instructions.length).toBeGreaterThan(0)
    for (const line of instructions) {
      expect(line.startsWith("Follow the user's stated working rule:")).toBeFalse()
      expect(line.startsWith("Respect the user's preference:")).toBeFalse()
      expect(line.startsWith("Environment fact:")).toBeFalse()
      expect(line).not.toMatch(/\(first stated at /)
    }
  })
})

describe("environment-fact selection", () => {
  const toolDump = `Tool exec: const r = await tools.exec_command({"cmd":"python - <<'PY'\\nimport tomlkit\\n...","workdir":"/app","yield_time_ms":10000,"max_output_tokens":30000});`

  test("keeps short environment-state claims", () => {
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText:
            "The environment does not have ripgrep (`rg`) installed, so grep and find must be used instead.",
          trajId: "t001",
        })
      )
    ).toBeTrue()
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText:
            "The /workspace directory contains per-sample CHIP variant Excel files under /workspace/CHIP_DP10_GQ20_PASS/.",
          trajId: "t002",
        })
      )
    ).toBeTrue()
  })

  test("rejects tool-call dumps, task briefs, narration, and payloads", () => {
    expect(isEnvironmentFactClaim(binding({ claimText: toolDump, trajId: "t001" }))).toBeFalse()
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText:
            "The user tasked the assistant with writing the complete characterization to /logs/artifacts/response.txt.",
          trajId: "t002",
        })
      )
    ).toBeFalse()
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText:
            "The assistant wrote /app/solver.py implementing a conservative 1D compressible Navier-Stokes solver with WENO5 flux splitting and SSP-RK3 stepping.",
          trajId: "t003",
        })
      )
    ).toBeFalse()
    const long = "x".repeat(201) + " /app/config.toml"
    expect(isEnvironmentFactClaim(binding({ claimText: long, trajId: "t004" }))).toBeFalse()
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText:
            "The task requires writing the final answer as a JSON 2D array to /testbed/output.json.",
          trajId: "t005",
        })
      )
    ).toBeFalse()
    expect(
      isEnvironmentFactClaim(
        binding({
          claimText: "Saved the handoff status to /logs/agent/test-handoff-status.txt.",
          trajId: "t006",
        })
      )
    ).toBeFalse()
  })

  test("dream report ranks recurring FAIL-provenance facts above singletons", () => {
    const recurring: ClaimBinding[] = [
      binding({
        claimText:
          "The environment does not have ripgrep (`rg`) installed, so grep and find must be used instead.",
        trajId: "t001",
        turn: 3,
      }),
      binding({
        claimText: "The environment does not have ripgrep (`rg`) installed, so use grep instead.",
        trajId: "t002",
        turn: 8,
        outcome: "PASS",
      }),
    ]
    const report = buildDreamReport(recurring)
    expect(report.environmentFacts).toHaveLength(1)
    expect(report.environmentFacts[0].support).toBe(2)
    expect(report.environmentFacts[0].instruction).not.toMatch(/Tool exec|exec_command/)
  })
})

describe("header reports trajectory counts, not claim counts", () => {
  test("stats count trajectories once regardless of claims per trajectory", () => {
    const bindings: ClaimBinding[] = [
      binding({ claimText: "rule one rather than two", trajId: "t1", outcome: "PASS" }),
      binding({ claimText: "rule two rather than three", trajId: "t1", turn: 2, outcome: "PASS" }),
      binding({ claimText: "rule three rather than four", trajId: "t1", turn: 3, outcome: "PASS" }),
      binding({ claimText: "poll with empty keystrokes instead", trajId: "t2", outcome: "FAIL" }),
      binding({
        claimText: "poll with empty keystrokes rather than sleeping",
        trajId: "t2",
        turn: 2,
        outcome: "FAIL",
      }),
    ]
    const report = buildDreamReport(bindings)
    expect(report.stats.trajectories).toBe(2)
    expect(report.stats.pass).toBe(1)
    expect(report.stats.fail).toBe(1)
    expect(report.stats.claims).toBe(5)
  })

  test("exported MEMORY.md header carries the true trajectory counts", async () => {
    const report = buildDreamReport([
      binding({ claimText: "poll with empty keystrokes instead", trajId: "t1", outcome: "PASS" }),
      binding({
        claimText: "poll with empty keystrokes rather than sleeping",
        trajId: "t2",
        outcome: "FAIL",
      }),
    ])
    const out = await mkdtemp(join(tmpdir(), "memory-export-"))
    await exportMemory(report, out)
    const header = (await readFile(join(out, "MEMORY.md"), "utf-8")).split("\n")[2]
    expect(header).toContain("Learned from 2 agent trajectories (1 PASS, 1 FAIL, 0 unlabeled)")
  })
})
