import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { loadCorpus, parseTrajectoryJsonl } from "../src/corpus"

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus")
const FIXTURE_SHA = "74feb99375be89e406b71d2e1a9530c3c328ca975b37987ae26e2aff6aed2dd8"

describe("corpus parsing (real smoke trajectory, no network)", () => {
  test("fixture matches upstream SHA256SUMS pin", () => {
    const bytes = require("node:fs").readFileSync(join(FIXTURE_CORPUS, "claude-code-intro.jsonl"))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA)
  })

  test("parses the real Claude Code transcript format", async () => {
    const trajs = await loadCorpus(FIXTURE_CORPUS)
    expect(trajs).toHaveLength(1)
    const traj = trajs[0]
    expect(traj.trajId).toBe("claude-code-intro")
    expect(traj.lineCount).toBe(14)
    expect(traj.sessionId).toBe("6b56c57a-7b23-438d-8496-c6e8ff208a99")
    expect(traj.events.length).toBe(14)
    expect(traj.outcome).toBe("unknown") // smoke corpus carries no verifier line
    // turns are 1-indexed and consecutive
    expect(traj.events.map((e) => e.turn)).toEqual(traj.events.map((_, i) => i + 1))
    // user and assistant turns both present, with real text
    expect(
      traj.events.some((e) => e.speaker === "user" && e.text.includes("my name is letta"))
    ).toBeTrue()
    expect(traj.events.some((e) => e.speaker === "assistant" && e.text.length > 20)).toBeTrue()
  })

  test("extracts plain text from content-block messages", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first block" },
            { type: "tool_use", id: "t1" },
            { type: "text", text: "second block" },
          ],
        },
      }),
    ].join("\n")
    const traj = parseTrajectoryJsonl(jsonl, "t", "t.jsonl")
    expect(traj.events[0].text).toBe("first block\nsecond block")
    expect(traj.events[0].turn).toBe(1)
  })

  test("detects verifier results in the shapes the published corpus uses", () => {
    const base = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })
    for (const [line, expected] of [
      [JSON.stringify({ result: "PASS" }), "PASS"],
      [JSON.stringify({ outcome: "FAIL" }), "FAIL"],
      [JSON.stringify({ type: "verifier", result: "PASS" }), "PASS"],
      [JSON.stringify({ result: { result: "FAIL" } }), "FAIL"],
      // last-line bare verdict
      [JSON.stringify({ type: "user", message: { role: "user", content: "PASS" } }), "PASS"],
    ] as Array<[string, string]>) {
      const traj = parseTrajectoryJsonl(`${base}\n${line}`, "t", "t.jsonl")
      expect(traj.outcome as string).toBe(expected)
    }
  })

  test("tolerates blank lines and malformed lines without dropping events", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "one" } }),
      "not json",
      "",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "two" } }),
    ].join("\n")
    const traj = parseTrajectoryJsonl(jsonl, "t", "t.jsonl")
    expect(traj.lineCount).toBe(3)
    expect(traj.events.map((e) => e.text)).toEqual(["one", "two"])
  })
})
