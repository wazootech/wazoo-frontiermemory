/**
 * Family-first export: fingerprint classification, item-to-family majority,
 * the family-organized MEMORY.md layout (rules / known failures / environment
 * / user preferences per family, then a general section), and resolving
 * details in the top skill files.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import type { DreamItem, DreamReport } from "../src/dream"
import {
  FAMILIES,
  buildTrajectoryFamilies,
  classifyClaimText,
  classifyTrajectoryTexts,
  familyForItem,
  familyForPreference,
} from "../src/families"
import { exportMemory, organizeByFamily, resolvingDetails } from "../src/export"
import type { FamilyClaim } from "../src/families"

function item(partial: Partial<DreamItem> & { key: string }): DreamItem {
  return {
    kind: "task-rule",
    instruction: partial.key,
    text: partial.key,
    support: 1,
    evidence: [],
    claimTypes: ["fact"],
    ...partial,
  } as DreamItem
}

function claimsOf(entries: Array<[string, number, string]>): FamilyClaim[] {
  return entries.map(([trajId, turn, claimText]) => ({ trajId, turn, claimText }))
}

describe("family fingerprints", () => {
  test("matches each family's own vocabulary", () => {
    expect(classifyClaimText("Read /root/packets.pcap with Scapy rdpcap")).toBe(
      "dapt-pcap-network-stats"
    )
    expect(classifyClaimText("Implement task_func in /workspace/solution.py with gensim")).toBe(
      "word2vec-pipeline"
    )
    expect(classifyClaimText("Keep /app/solver.py correct; the speedup bar is 4x")).toBe(
      "algotune-optimization"
    )
    expect(classifyClaimText("Write the transformed test grid to /testbed/output.json")).toBe(
      "arc-grid-transforms"
    )
    expect(classifyClaimText("The dbt project at /workspace uses a duckdb database")).toBe(
      "dbt-data-eng"
    )
    expect(classifyClaimText("Ct values for 175 miRNAs; run GSEA afterwards")).toBe(
      "analytics-bixbench"
    )
    expect(classifyClaimText("The world MCP sheets read_tab action requires tab_index")).toBe(
      "agentic-mcp-sheets"
    )
    expect(classifyClaimText("Install tesseract-ocr via apt-get for ocr-receipts")).toBe(
      "skillsbench-ops"
    )
    expect(
      classifyClaimText("AGENTS.md requires kebab-case file names in this pnpm monorepo")
    ).toBe("repo-work-conventions")
  })

  test("does not over-match lookalike words", () => {
    // "research" contains "arc"; "DynamoDBToolboxError" contains "dbt";
    // "Chocolate Chip" contains "chip"; "Tomcat 9 Variant 12" is not bio.
    expect(classifyClaimText("The user researches data sources")).toBeUndefined()
    expect(classifyClaimText("DynamoDBToolboxError is thrown after defaults")).toBeUndefined()
    expect(classifyClaimText("Chocolate Chip Cookie Dough is a flavor")).toBeUndefined()
    expect(classifyClaimText("Tomcat 9 Variant 12 is installed on the account")).toBeUndefined()
    expect(classifyClaimText("Poll with empty keystrokes instead of sleeping")).toBeUndefined()
  })

  test("classifies a trajectory by its claim-count majority", () => {
    // One incidental AGENTS.md mention against many world MCP claims.
    expect(
      classifyTrajectoryTexts([
        "The assistant must not spawn sub-agents unless AGENTS.md says so",
        "The world MCP tools hold all documents",
        "The world sheets read_tab action requires tab_index",
        "The world MCP server may still be connecting at task start",
      ])
    ).toBe("agentic-mcp-sheets")
    expect(classifyTrajectoryTexts(["Nothing family-shaped here at all"])).toBeUndefined()
  })

  test("every family has a unique id and a case-insensitive fingerprint", () => {
    const ids = FAMILIES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const family of FAMILIES) {
      expect(family.fingerprint.flags).toContain("i")
      expect(family.name.length).toBeGreaterThan(0)
    }
  })
})

describe("item-to-family assignment", () => {
  const trajectoryFamilies = buildTrajectoryFamilies(
    claimsOf([
      ["t1", 1, "Read the pcap with rdpcap"],
      ["t2", 1, "The pcap stats template is /root/network_stats.csv"],
      ["t3", 1, "AGENTS.md requires kebab-case names"],
    ])
  )

  test("plurality of evidence trajectories wins", () => {
    const pcap = item({
      key: "pcap rule",
      evidence: [
        { trajId: "t1", turn: 1, outcome: "PASS" },
        { trajId: "t2", turn: 1, outcome: "FAIL" },
        { trajId: "t3", turn: 1, outcome: "PASS" },
      ],
    })
    expect(familyForItem(pcap, trajectoryFamilies)).toBe("dapt-pcap-network-stats")
  })

  test("an exact tie leaves the item family-less", () => {
    const tied = item({
      key: "tied rule",
      evidence: [
        { trajId: "t1", turn: 1, outcome: "PASS" },
        { trajId: "t3", turn: 1, outcome: "PASS" },
        { trajId: "t4", turn: 1, outcome: "PASS" },
        { trajId: "t5", turn: 1, outcome: "PASS" },
      ],
    })
    expect(familyForItem(tied, trajectoryFamilies)).toBeUndefined()
  })

  test("preferences need an 80% evidence share to be family-scoped", () => {
    const owned = item({
      key: "owned pref",
      evidence: [
        { trajId: "t1", turn: 1, outcome: "PASS" },
        { trajId: "t2", turn: 1, outcome: "PASS" },
        { trajId: "t3", turn: 1, outcome: "PASS" },
      ],
    })
    // 2 of 3 trajectories in the pcap family: below the 80% bar.
    expect(familyForPreference(owned, trajectoryFamilies)).toBeUndefined()
    const shared = item({
      key: "shared pref",
      evidence: [
        { trajId: "t1", turn: 1, outcome: "PASS" },
        { trajId: "t2", turn: 1, outcome: "PASS" },
      ],
    })
    expect(familyForPreference(shared, trajectoryFamilies)).toBe("dapt-pcap-network-stats")
  })
})

interface Fixture {
  report: DreamReport
  claims: FamilyClaim[]
}

/**
 * A small synthetic corpus: five DAPT pcap rules (enough to trigger resolving
 * details), one fail-only rule among them (renders as a caution under Known
 * failures), one repo-work preference, and two family-less rules.
 */
function fixture(): Fixture {
  const claims = claimsOf([
    ["t1", 4, "Use Scapy rdpcap to read the /root/packets.pcap file before computing any metric"],
    ["t1", 5, "Read the pcap with rdpcap and compute every metric in one script"],
    ["t2", 2, "The stats template is /root/network_stats.csv; # lines are comments"],
    ["t2", 3, "Use Scapy rdpcap to read the pcap file"],
    ["t3", 1, "bidirectional_flows counts each distinct forward/reverse pair once"],
    ["t3", 2, "Use Scapy rdpcap to read the pcap file"],
    ["t4", 1, "AGENTS.md requires kebab-case file names"],
    ["t5", 1, "Poll with empty keystrokes instead of sleeping"],
    ["t5", 2, "Poll with empty keystrokes rather than sleeping between checks"],
    ["t6", 1, "Use Scapy rdpcap to read the pcap file"],
    ["t6", 2, "Use Scapy rdpcap to read the pcap file"],
    ["t6", 3, "Use Scapy rdpcap to read the pcap file"],
  ])
  const rdpcapEvidence = (outcomes: Array<["PASS" | "FAIL", string, number]>) =>
    outcomes.map(([outcome, trajId, turn]) => ({ trajId, turn, outcome }))
  const report: DreamReport = {
    taskRules: [
      item({
        key: "rdpcap once",
        instruction: "Read the pcap with rdpcap before computing metrics",
        text: "Use Scapy rdpcap to read the pcap file",
        support: 4,
        evidence: rdpcapEvidence([
          ["PASS", "t1", 4],
          ["PASS", "t2", 3],
          ["FAIL", "t3", 2],
        ]),
      }),
      item({
        key: "network stats template",
        instruction: "Leave the # comment lines in /root/network_stats.csv unchanged",
        text: "The stats template is /root/network_stats.csv",
        // Contested-with-resolution: the first run hit the FAIL, the fixed
        // form passed on the retry — the pruning layer keeps that species.
        support: 2,
        evidence: rdpcapEvidence([
          ["FAIL", "t2", 2],
          ["PASS", "t1", 5],
        ]),
      }),
      item({
        key: "bidirectional once",
        instruction: "Count each distinct forward/reverse pair once",
        text: "bidirectional_flows counts each distinct forward/reverse pair once",
        support: 1,
        evidence: rdpcapEvidence([["PASS", "t3", 1]]),
      }),
      item({
        key: "rdpcap turn order",
        instruction: "Sort packets by timestamp before computing inter-arrival times",
        text: "Use Scapy rdpcap to read the pcap file",
        support: 2,
        evidence: rdpcapEvidence([
          ["FAIL", "t6", 1],
          ["FAIL", "t6", 2],
          ["FAIL", "t6", 3],
        ]),
      }),
      item({
        key: "pcap protocols",
        instruction: "Count protocol_udp over every packet with a Scapy UDP layer",
        text: "Use Scapy rdpcap to read the pcap file",
        support: 1,
        evidence: rdpcapEvidence([["PASS", "t1", 5]]),
      }),
      item({
        key: "pcap comment lines",
        instruction: "Skip the # comment lines when reading /root/network_stats.csv",
        text: "Comment lines starting with # are not data rows",
        // Verified-works species: passed in both trajectories it ran in.
        support: 2,
        evidence: rdpcapEvidence([
          ["PASS", "t1", 4],
          ["PASS", "t2", 3],
        ]),
      }),
      item({
        key: "poll empty",
        instruction: "Poll with empty keystrokes instead of sleeping",
        text: "Poll with empty keystrokes rather than sleeping between checks",
        support: 1,
        evidence: rdpcapEvidence([["FAIL", "t5", 1]]),
      }),
      item({
        key: "kebab case",
        instruction: "AGENTS.md requires kebab-case file names",
        text: "AGENTS.md requires kebab-case file names",
        support: 1,
        evidence: rdpcapEvidence([["PASS", "t4", 1]]),
      }),
    ],
    userPreferences: [
      item({
        key: "branch from main",
        kind: "user-preference",
        instruction: "Work on a new branch created from main",
        text: "User requires that work be done on a new branch created from main",
        support: 1,
        evidence: rdpcapEvidence([["PASS", "t4", 1]]),
      }),
    ],
    environmentFacts: [
      item({
        key: "pcap location",
        kind: "environment-fact",
        instruction: "The pcap file is at /root/packets.pcap",
        text: "The file /root/packets.pcap is a pcap",
        support: 1,
        evidence: rdpcapEvidence([["PASS", "t1", 4]]),
      }),
    ],
    stats: { claims: 12, trajectories: 6, pass: 4, fail: 2, unknown: 0 },
  }
  return { report, claims }
}

describe("family-organized export", () => {
  test("renders family sections with rules, known failures, environment, and general section", async () => {
    const { report, claims } = fixture()
    const out = await mkdtemp(join(tmpdir(), "memory-families-"))
    const { report: validation } = await exportMemory(report, out, { claims })
    expect(validation.ok).toBeTrue()
    const memory = await readFile(join(out, "MEMORY.md"), "utf-8")
    const lines = memory.split("\n")
    // header keeps the true counts
    expect(lines[2]).toContain("Learned from 6 agent trajectories (4 PASS, 2 FAIL, 0 unlabeled)")
    // family section with its subsections
    expect(memory).toContain("## DAPT pcap network stats")
    expect(memory).toContain("### Rules")
    expect(memory).toContain("### Known failures")
    expect(memory).toContain("### Environment")
    expect(memory).toContain("### User preferences")
    // the majority-FAIL rule is called out as a verified-FAIL pattern
    expect(memory).toMatch(
      /Verified FAIL: Sort packets by timestamp before computing inter-arrival times \(3 of 3 evidence trajectories failed\)/
    )
    // family-scoped preference folded into its family section, not general
    expect(memory.indexOf("## DAPT pcap network stats")).toBeLessThan(
      memory.indexOf("Work on a new branch created from main")
    )
    // family-less items land in the general section, after the families
    expect(memory).toContain("## General working rules")
    expect(memory.indexOf("## General working rules")).toBeLessThan(
      memory.indexOf("AGENTS.md requires kebab-case file names")
    )
    // footer mentions the family organization
    expect(memory).toContain("## How this memory was built")
    expect(memory).toContain("organized by task family")
  })

  test("below-threshold families fold into the general section", () => {
    const { report, claims } = fixture()
    const organized = organizeByFamily(report, claims)
    // The synthetic fixture's repo-work evidence is one preference: the
    // repo-work family has fewer than MIN_FAMILY_ITEMS curated items.
    expect(organized.sections.map((s) => s.family.id)).not.toContain("repo-work-conventions")
    expect(organized.general.preferences.map((i) => i.key)).toContain("branch from main")
  })

  test("section caps keep MEMORY.md an index, and export is deterministic", async () => {
    const { report, claims } = fixture()
    // Flood the pcap family with rules: the section must render only the cap.
    for (let n = 0; n < 12; n++) {
      report.taskRules.push(
        item({
          key: `pcap filler ${n}`,
          instruction: `Filler pcap rule ${n} about the pcap file`,
          text: `Filler pcap rule ${n} about the pcap file`,
          support: 1,
          evidence: [{ trajId: "t1", turn: 4, outcome: "PASS" }],
        })
      )
    }
    const first = await mkdtemp(join(tmpdir(), "memory-caps-a-"))
    const second = await mkdtemp(join(tmpdir(), "memory-caps-b-"))
    const a = await exportMemory(report, first, { claims })
    const b = await exportMemory(report, second, { claims })
    const memory = await readFile(join(first, "MEMORY.md"), "utf-8")
    const section = memory.split(/^## /m).find((s) => s.startsWith("DAPT pcap network stats"))!
    expect(section).toBeDefined()
    const numbered = section.split("\n").filter((l) => /^\d+\. /.test(l))
    expect(numbered.length).toBe(5)
    // filler rules are excluded from the index but still get skill files
    expect(memory).not.toContain("Filler pcap rule 11")
    expect(a.report.memory_sha256).toBe(b.report.memory_sha256)
  })
})

describe("resolving details", () => {
  test("top items of a family with >=5 rules carry concrete claim texts", async () => {
    const { report, claims } = fixture()
    const out = await mkdtemp(join(tmpdir(), "memory-details-"))
    await exportMemory(report, out, { claims })
    const skill = await readFile(join(out, "skills", "rule-01-rdpcap-once.md"), "utf-8")
    expect(skill).toContain("## Resolving details")
    // The more specific phrasing outranks the item's own representative text.
    expect(skill).toContain("/root/packets.pcap file before computing any metric")
  })

  test("details come only from the item's own evidence turns", () => {
    const { report, claims } = fixture()
    const target = report.taskRules.find((i) => i.key === "rdpcap once")!
    const details = resolvingDetails(target, claims)
    expect(details.length).toBeGreaterThan(0)
    for (const detail of details) {
      expect(detail).toContain("rdpcap")
    }
    expect(details).not.toContain("AGENTS.md requires kebab-case file names")
  })

  test("a family with fewer than 5 rules gets no resolving details", async () => {
    const { report, claims } = fixture()
    const out = await mkdtemp(join(tmpdir(), "memory-no-details-"))
    await exportMemory(report, out, { claims })
    // The only skill file outside the pcap family (kebab-case rule).
    const files = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: join(out, "skills") }))
    const names = files.filter((f) => f.startsWith("rule-"))
    const kebab = names.find((f) => f.includes("kebab"))
    if (kebab) {
      const content = await readFile(join(out, "skills", kebab), "utf-8")
      expect(content).not.toContain("## Resolving details")
    }
  })
})
