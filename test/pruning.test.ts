/**
 * Evidence-thresholded pruning (src/pruning.ts): the verdict rules, their
 * determinism, the MEMORY.md line band, and the guarantee that no item
 * loses its skill file.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportMemory } from "../src/export"
import type { DreamItem, DreamReport } from "../src/dream"
import {
  DEFAULT_PRUNING_CONFIG,
  type PruningConfig,
  pruneItems,
  pruningReport,
  type PruningContext,
} from "../src/pruning"
import type { FamilyClaim } from "../src/families"

function item(overrides: Partial<DreamItem> & { key: string }): DreamItem {
  return {
    kind: "task-rule",
    instruction: overrides.instruction ?? `Instruction for ${overrides.key}`,
    text: overrides.text ?? `Text for ${overrides.key}`,
    support: 1,
    evidence: [],
    claimTypes: [],
    ...overrides,
  }
}

function evidence(outcomes: Array<"PASS" | "FAIL">, trajPrefix = "t"): DreamItem["evidence"] {
  return outcomes.map((outcome, i) => ({ trajId: `${trajPrefix}${i + 1}`, turn: 1, outcome }))
}

/** No families: every item lands in the general section, purely on verdicts. */
const NO_FAMILIES: PruningContext = {
  familyOf: () => undefined,
  familyTrajectoryCounts: new Map(),
}

function verdictOf(items: DreamItem[], config?: PruningConfig): Map<string, string> {
  const decisions = pruneItems(
    items,
    NO_FAMILIES,
    config ?? { ...DEFAULT_PRUNING_CONFIG, topPerKind: 0 }
  )
  return new Map([...decisions].map(([key, d]) => [key, d.verdict]))
}

describe("pruning verdicts", () => {
  test("support >= 3 is kept as an index item", () => {
    const decisions = verdictOf([
      item({ key: "a", support: 3, evidence: evidence(["PASS", "PASS", "FAIL"]) }),
    ])
    expect(decisions.get("a")).toBe("index")
  })

  test("support = 2 with mixed evidence is kept (contested-with-resolution)", () => {
    const decisions = verdictOf([
      item({ key: "a", support: 2, evidence: evidence(["PASS", "FAIL"]) }),
    ])
    expect(decisions.get("a")).toBe("index")
  })

  test("support = 2 all-PASS is kept (verified-works)", () => {
    const decisions = verdictOf([
      item({ key: "a", support: 2, evidence: evidence(["PASS", "PASS"]) }),
    ])
    expect(decisions.get("a")).toBe("index")
  })

  test("support = 1 all-PASS is a singleton: skill-only, not in MEMORY.md", () => {
    const decisions = verdictOf([item({ key: "a", support: 1, evidence: evidence(["PASS"]) })])
    expect(decisions.get("a")).toBe("skill-only")
  })

  test("support = 1 all-FAIL becomes a fail-caution, never an index rule", () => {
    const decisions = verdictOf([item({ key: "a", support: 1, evidence: evidence(["FAIL"]) })])
    expect(decisions.get("a")).toBe("fail-caution")
  })

  test("fail-caution items never render as numbered rules in MEMORY.md", async () => {
    const report: DreamReport = {
      taskRules: [
        item({
          key: "bad rule",
          support: 1,
          evidence: evidence(["FAIL"]),
          instruction: "Do the bad thing",
        }),
      ],
      userPreferences: [],
      environmentFacts: [],
      stats: { claims: 1, trajectories: 1, pass: 0, fail: 1, unknown: 0 },
    }
    const out = await mkdtemp(join(tmpdir(), "pruning-caution-"))
    try {
      await exportMemory(report, out)
      const memory = await readFile(join(out, "MEMORY.md"), "utf-8")
      // Not a rule line; a 1-of-1 renders as a demoted anecdote line under
      // Known failures, visibly lighter than a repeated-failure pattern.
      expect(memory).not.toMatch(/^1\. Do the bad thing/m)
      expect(memory).toContain(
        "- Failed once: Do the bad thing (1 attempt; anecdote, not a pattern)"
      )
      expect(memory).not.toContain(
        "- Verified FAIL: Do the bad thing (1 of 1 evidence trajectories failed)"
      )
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  test("top-15 by support per kind are always kept", () => {
    const items: DreamItem[] = []
    for (let n = 0; n < 15; n++) {
      items.push(item({ key: `thin ${n}`, support: 1, evidence: evidence(["PASS"]) }))
    }
    items.push(item({ key: "z-outside", support: 1, evidence: evidence(["PASS"]) }))
    const decisions = verdictOf(items, DEFAULT_PRUNING_CONFIG)
    expect(decisions.get("thin 0")).toBe("index")
    // 16th of the kind: outside the always-keep window, stays skill-only.
    expect(decisions.get("z-outside")).toBe("skill-only")
  })

  test("the top-15 always-keep never promotes a fail-only rule to an instruction", () => {
    const items: DreamItem[] = [item({ key: "bad", support: 1, evidence: evidence(["FAIL"]) })]
    const decisions = verdictOf(items, DEFAULT_PRUNING_CONFIG)
    expect(decisions.get("bad")).toBe("fail-caution")
  })

  test("the sole rule of a family with enough trajectories is rescued", () => {
    const context: PruningContext = {
      familyOf: (i) => (i.key === "lonely" ? "pcap" : undefined),
      familyTrajectoryCounts: new Map([["pcap", 7]]),
    }
    const lonely = item({ key: "lonely", support: 1, evidence: evidence(["PASS"]) })
    const decisions = pruneItems([lonely], context, { ...DEFAULT_PRUNING_CONFIG, topPerKind: 0 })
    expect(decisions.get("lonely")?.verdict).toBe("index")
    expect(decisions.get("lonely")?.reason).toBe("sole-rule-of-family")
    // A fail-only rule is not promoted to an instruction even when it is the
    // sole rule: it already renders as the family's caution line.
    const failed = item({ key: "lonely", support: 1, evidence: evidence(["FAIL"]) })
    const failedDecisions = pruneItems([failed], context, {
      ...DEFAULT_PRUNING_CONFIG,
      topPerKind: 0,
    })
    expect(failedDecisions.get("lonely")?.verdict).toBe("fail-caution")
    // Not rescued when the family is too small.
    const small: PruningContext = {
      ...context,
      familyTrajectoryCounts: new Map([["pcap", 4]]),
    }
    expect(
      pruneItems([lonely], small, { ...DEFAULT_PRUNING_CONFIG, topPerKind: 0 }).get("lonely")
        ?.verdict
    ).toBe("skill-only")
  })
})

describe("pruning determinism", () => {
  test("same input produces identical verdicts, reports, and MEMORY.md", async () => {
    const items: DreamItem[] = [
      item({ key: "b", support: 3, evidence: evidence(["PASS", "PASS", "PASS"]) }),
      item({ key: "a", support: 3, evidence: evidence(["PASS", "PASS", "PASS"]) }),
      item({ key: "c", support: 2, evidence: evidence(["PASS", "FAIL"]) }),
      item({ key: "d", support: 1, evidence: evidence(["PASS"]) }),
      item({ key: "e", support: 1, evidence: evidence(["FAIL"]) }),
      item({ key: "f", support: 2, evidence: evidence(["PASS", "PASS"]) }),
      item({ key: "g", support: 1, evidence: evidence(["FAIL", "PASS"]) }),
    ]
    const first = pruneItems(items, NO_FAMILIES, { ...DEFAULT_PRUNING_CONFIG, topPerKind: 0 })
    const second = pruneItems(items, NO_FAMILIES, { ...DEFAULT_PRUNING_CONFIG, topPerKind: 0 })
    expect(pruningReport(first, DEFAULT_PRUNING_CONFIG)).toEqual(
      pruningReport(second, DEFAULT_PRUNING_CONFIG)
    )
    // Tie on support: key order breaks it, identically both times.
    expect(first.get("a")?.verdict).toBe("index")
    expect(first.get("a")?.verdict).toBe(second.get("a")?.verdict)
    expect(first.get("g")?.verdict).toBe("skill-only")

    const report: DreamReport = {
      taskRules: items,
      userPreferences: [],
      environmentFacts: [],
      stats: { claims: 7, trajectories: 6, pass: 5, fail: 2, unknown: 0 },
    }
    const outA = await mkdtemp(join(tmpdir(), "pruning-det-a-"))
    const outB = await mkdtemp(join(tmpdir(), "pruning-det-b-"))
    try {
      const a = await exportMemory(report, outA, { pruning: { topPerKind: 0 } })
      const b = await exportMemory(report, outB, { pruning: { topPerKind: 0 } })
      expect(a.pruning).toEqual(b.pruning)
      expect(a.report.memory_sha256).toBe(b.report.memory_sha256)
    } finally {
      await rm(outA, { recursive: true, force: true })
      await rm(outB, { recursive: true, force: true })
    }
  })
})

describe("no item loses its skill file", () => {
  test("kept, fail-caution, and singleton items all export a skill file", async () => {
    const report: DreamReport = {
      taskRules: [
        item({ key: "kept rule", support: 3, evidence: evidence(["PASS", "PASS", "FAIL"]) }),
        item({ key: "caution rule", support: 1, evidence: evidence(["FAIL"]) }),
        item({ key: "singleton rule", support: 1, evidence: evidence(["PASS"]) }),
      ],
      userPreferences: [
        item({
          key: "kept pref",
          kind: "user-preference",
          support: 3,
          evidence: evidence(["PASS", "PASS", "PASS"]),
        }),
        item({
          key: "singleton pref",
          kind: "user-preference",
          support: 1,
          evidence: evidence(["PASS"]),
        }),
      ],
      environmentFacts: [
        item({
          key: "kept env",
          kind: "environment-fact",
          support: 3,
          evidence: evidence(["PASS", "PASS", "PASS"]),
        }),
      ],
      stats: { claims: 10, trajectories: 5, pass: 8, fail: 2, unknown: 0 },
    }
    const out = await mkdtemp(join(tmpdir(), "pruning-skills-"))
    try {
      const { pruning } = await exportMemory(report, out, { pruning: { topPerKind: 0 } })
      expect(pruning.summary.total).toBe(6)
      expect(pruning.summary.index).toBe(3)
      expect(pruning.summary.failCaution).toBe(1)
      expect(pruning.summary.skillOnly).toBe(2)
      const files = await readdir(join(out, "skills"))
      expect(files.length).toBe(6)
      for (const target of report.taskRules.concat(
        report.userPreferences,
        report.environmentFacts
      )) {
        const matches: string[] = []
        for (const f of files) {
          const content = await readFile(join(out, "skills", f), "utf-8")
          if (content.includes(`Pattern key: \`${target.key}\``)) matches.push(f)
        }
        expect(matches.length).toBe(1)
      }
      // Provenance survives on a skill-only item (no MEMORY.md line, full file).
      const singleton = files.find((f) => f.includes("singleton-rule"))
      expect(singleton).toBeDefined()
      const content = await readFile(join(out, "skills", singleton!), "utf-8")
      expect(content).toContain("## Provenance")
      expect(content).toContain("Use when")
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

/**
 * Band enforcement: MEMORY.md stays an index. This corpus is shaped like the
 * real state-v11 distribution (9 recurring task families, a long tail of
 * support-1 singletons and fail-only rules, family-less stragglers). Under
 * the default config the rendered index measured 205 lines; the test pins
 * the band [120, 260] the pruning run was tuned to.
 */
describe("MEMORY.md line band", () => {
  test("a state-v11-shaped corpus renders between 120 and 260 lines", async () => {
    const FAMILY_WORDS = [
      "Read the pcap with rdpcap for network_stats",
      "Implement task_func with gensim for word2vec",
      "Optimize solver.py for the speedup bar",
      "Transform the ARC training examples grid",
      "The dbt project uses a duckdb database with stg_ models",
      "Compute Ct values and run GSEA for the miRNA panel",
      "The world MCP sheets read_tab action needs tab_index",
      "Install tesseract-ocr for ocr-receipts and PWT Dataverse",
      "AGENTS.md requires kebab-case in this pnpm monorepo",
    ]
    const taskRules: DreamItem[] = []
    const userPreferences: DreamItem[] = []
    const environmentFacts: DreamItem[] = []
    let traj = 0
    FAMILY_WORDS.forEach((topic, f) => {
      // Six high-certainty rules per family (one is a support-3 all-FAIL
      // rule, which also renders as a verified-FAIL line).
      for (let n = 0; n < 5; n++) {
        traj += 1
        taskRules.push(
          item({
            key: `f${f} rule ${n}`,
            instruction: `${topic}: rule ${n} for the task`,
            text: topic,
            support: 3,
            evidence: [
              { trajId: `t${traj}a`, turn: 1, outcome: "PASS" },
              { trajId: `t${traj}b`, turn: 1, outcome: "PASS" },
              { trajId: `t${traj}c`, turn: 1, outcome: "PASS" },
            ],
          })
        )
      }
      traj += 1
      taskRules.push(
        item({
          key: `f${f} fail rule`,
          instruction: `${topic}: avoid the deprecated call`,
          text: topic,
          support: 3,
          evidence: [
            { trajId: `t${traj}a`, turn: 1, outcome: "FAIL" },
            { trajId: `t${traj}b`, turn: 1, outcome: "FAIL" },
            { trajId: `t${traj}c`, turn: 1, outcome: "FAIL" },
          ],
        })
      )
      // Three fail-only singletons per family: caution lines, capped at 3.
      for (let n = 0; n < 3; n++) {
        traj += 1
        taskRules.push(
          item({
            key: `f${f} caution ${n}`,
            instruction: `${topic}: failed variant ${n}`,
            text: topic,
            support: 1,
            evidence: [{ trajId: `t${traj}`, turn: 1, outcome: "FAIL" }],
          })
        )
      }
      // Twenty singletons per family: skill files only.
      for (let n = 0; n < 20; n++) {
        traj += 1
        taskRules.push(
          item({
            key: `f${f} singleton ${n}`,
            instruction: `${topic}: singleton ${n}`,
            text: topic,
            support: 1,
            evidence: [{ trajId: `t${traj}`, turn: 1, outcome: "PASS" }],
          })
        )
      }
      userPreferences.push(
        item({
          key: `f${f} pref`,
          kind: "user-preference",
          instruction: `${topic}: prefer terse summaries`,
          text: topic,
          support: 3,
          evidence: [
            { trajId: `t${traj}a`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}b`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}c`, turn: 1, outcome: "PASS" },
          ],
        })
      )
      environmentFacts.push(
        item({
          key: `f${f} env`,
          kind: "environment-fact",
          instruction: `${topic}: the working directory is /workspace`,
          text: topic,
          support: 3,
          evidence: [
            { trajId: `t${traj}a`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}b`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}c`, turn: 1, outcome: "PASS" },
          ],
        })
      )
    })
    // Family-less stragglers, shaped like the general section.
    for (let n = 0; n < 8; n++) {
      traj += 1
      taskRules.push(
        item({
          key: `general rule ${n}`,
          instruction: `General working rule ${n}: keep outputs terse`,
          text: `unrelated text ${n}`,
          support: 3,
          evidence: [
            { trajId: `t${traj}a`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}b`, turn: 1, outcome: "PASS" },
            { trajId: `t${traj}c`, turn: 1, outcome: "PASS" },
          ],
        })
      )
    }
    const report: DreamReport = {
      taskRules,
      userPreferences,
      environmentFacts,
      stats: { claims: 4000, trajectories: traj, pass: 2500, fail: 1500, unknown: 0 },
    }
    const out = await mkdtemp(join(tmpdir(), "pruning-band-"))
    try {
      const { report: validation } = await exportMemory(report, out)
      expect(validation.ok).toBeTrue()
      const memory = await readFile(join(out, "MEMORY.md"), "utf-8")
      const lineCount = memory.split("\n").length
      // Measured 247 lines with the default config on this shape. The band
      // is the tuning target from the pruning run: a real index, not a dump.
      expect(lineCount).toBeGreaterThanOrEqual(120)
      expect(lineCount).toBeLessThanOrEqual(260)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})
