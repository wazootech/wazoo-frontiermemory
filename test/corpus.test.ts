import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  loadCorpus,
  parseTrajectoryAtif,
  parseTrajectoryFile,
  parseTrajectoryJsonl,
} from "../src/corpus"

const FIXTURE_CORPUS = join(import.meta.dir, "fixtures", "corpus")
const ATIF_FIXTURE = join(import.meta.dir, "fixtures", "atif", "atif-t0002.json")
const MIXED_CORPUS = join(import.meta.dir, "fixtures", "mixed")
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

  test("detects the `# Verifier result` marker in the real event-stream shape", () => {
    // The published corpus's 116 event-stream files all end with a response_item
    // payload message carrying the verdict as text.
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-10-06T20:59:58.198Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# Verifier result\n\nFAIL" }],
        },
      }),
    ].join("\n")
    const traj = parseTrajectoryJsonl(jsonl, "t", "t.jsonl")
    expect(traj.outcome).toBe("FAIL")
    // the verdict line itself is not emitted as an event
    expect(traj.events).toHaveLength(0)
  })

  test("event-stream payload messages become events; bookkeeping is skipped", () => {
    const jsonl = [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "s1", cwd: "/app" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      }),
      JSON.stringify({
        timestamp: "2026-10-06T20:58:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "fix the bug" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: "find /app -name 'x.py'",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "/app/x.py" }],
        },
      }),
    ].join("\n")
    const traj = parseTrajectoryJsonl(jsonl, "t", "t.jsonl")
    expect(traj.sessionId).toBe("s1")
    expect(traj.outcome).toBe("unknown")
    // session_meta, task_started, and the tool *output* line produce no events
    expect(traj.events).toHaveLength(2)
    expect(traj.events[0].speaker).toBe("user")
    expect(traj.events[0].cwd).toBe("/app")
    expect(traj.events[1].speaker).toBe("other")
    expect(traj.events[1].text.startsWith("Tool exec: find /app -name 'x.py'")).toBeTrue()
    // the matched output is folded into its call
    expect(traj.events[1].text).toContain("obs: /app/x.py")
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

describe("ATIF parsing (trimmed real trajectory t0002)", () => {
  test("parses the trimmed real ATIF file end to end", async () => {
    const traj = await parseTrajectoryFile(ATIF_FIXTURE)
    expect(traj.format).toBe("atif")
    expect(traj.trajId).toBe("atif-t0002")
    const doc = JSON.parse(await readFile(ATIF_FIXTURE, "utf-8"))
    expect(traj.sessionId).toBe(doc.session_id)
    expect(traj.lineCount).toBe(doc.steps.length)
    // turns are the ATIF step_ids
    const steps = doc.steps.filter(
      (s: { source: string; message?: string }) =>
        !(s.source === "user" && (s.message ?? "").startsWith("# Verifier result"))
    )
    expect(traj.events.map((e) => e.turn)).toEqual(steps.map((s: { step_id: number }) => s.step_id))
  })

  test("detects the outcome from the `# Verifier result` user step", async () => {
    const traj = await parseTrajectoryFile(ATIF_FIXTURE)
    expect(traj.outcome).toBe("PASS")
    expect(traj.outcomeSource).toBe("atif_verifier_step")
    // the verdict step is not emitted as an event
    expect(traj.events.some((e) => e.text.includes("Verifier result"))).toBeFalse()
  })

  test("maps ATIF sources to speakers and renders tool-call steps compactly", async () => {
    const traj = await parseTrajectoryFile(ATIF_FIXTURE)
    const userStep = traj.events.find((e) => e.speaker === "user")
    expect(userStep?.text).toContain("SpanSelector")
    const agentStep = traj.events.find((e) => e.speaker === "assistant")
    expect(agentStep).toBeDefined()
    // agent -> assistant, tool calls render as `Tool <name>: <args>`
    const toolEvent = traj.events.find((e) => e.text.startsWith("Tool "))
    expect(toolEvent).toBeDefined()
    expect(toolEvent?.text).toMatch(/^Tool Bash: find /)
    // observation is folded in, clipped
    const obsLine = toolEvent?.text.split("\n").find((l) => l.startsWith("obs: "))
    expect(obsLine).toBeDefined()
    expect(obsLine!.replace("obs: ", "").length).toBeLessThanOrEqual(300)
  })

  test("skips reasoning_content by default and includes it on request", async () => {
    const doc = JSON.parse(await readFile(ATIF_FIXTURE, "utf-8"))
    const hasReasoning = doc.steps.some(
      (s: { reasoning_content?: string }) =>
        typeof s.reasoning_content === "string" && s.reasoning_content.trim()
    )
    expect(hasReasoning).toBeTrue() // fixture sanity

    const plain = await parseTrajectoryFile(ATIF_FIXTURE)
    expect(plain.events.some((e) => e.text.includes("[reasoning]"))).toBeFalse()

    const withReasoning = await parseTrajectoryFile(ATIF_FIXTURE, { includeReasoning: true })
    expect(withReasoning.events.some((e) => e.text.includes("[reasoning]"))).toBeTrue()
  })

  test("rejects a .json file in no recognized format", async () => {
    const path = join(import.meta.dir, "fixtures", "atif", "atif-t0002.json")
    const bogus = join(import.meta.dir, "fixtures", "atif")
    await expect(parseTrajectoryFile(join(bogus, "does-not-exist.json"))).rejects.toThrow()
    expect(path).toBeTruthy()
  })
})

describe("mixed-format corpus directory", () => {
  test("loads .jsonl, ATIF .json, and OpenCode .json together", async () => {
    const trajs = await loadCorpus(MIXED_CORPUS)
    expect(trajs).toHaveLength(3)
    const formats = new Map(trajs.map((t) => [t.format, t]))
    expect(formats.get("jsonl")?.trajId).toBe("tiny-event-stream")
    expect(formats.get("atif")?.trajId).toBe("t-sample")
    expect(formats.get("opencode")?.trajId).toBe("opencode-t")

    // every trajectory carries its verifier outcome from its own format
    const outcomes = trajs.map((t) => t.outcome).sort()
    expect(outcomes).toEqual(["FAIL", "PASS", "PASS"])

    // OpenCode rendering: text parts verbatim, tool parts compact, reasoning skipped
    const oc = formats.get("opencode")!
    expect(oc.sessionId).toBe("ses_fixture_opencode")
    expect(oc.lineCount).toBe(4)
    expect(
      oc.events.some((e) => e.speaker === "user" && e.text.includes("one-line entry"))
    ).toBeTrue()
    const ocTool = oc.events.find((e) => e.text.startsWith("Tool read:"))
    expect(ocTool).toBeDefined()
    expect(ocTool?.text).toContain("obs: # Changelog")
    expect(oc.events.some((e) => e.text.includes("[reasoning]"))).toBeFalse()
  })

  test("parseTrajectoryAtif accepts documents directly", () => {
    const traj = parseTrajectoryAtif(
      {
        schema_version: "ATIF-v1.2",
        session_id: "s-atif",
        steps: [
          { step_id: 1, source: "user", message: "hello" },
          { step_id: 2, source: "system", message: "system ping" },
          {
            step_id: 3,
            source: "agent",
            message: "",
            tool_calls: [{ function_name: "Read", arguments: { file_path: "/a.py" } }],
          },
          { step_id: 4, source: "user", message: "# Verifier result\n\nFAIL" },
        ],
      },
      "synthetic",
      "synthetic.json"
    )
    expect(traj.outcome).toBe("FAIL")
    expect(traj.events.map((e) => e.speaker)).toEqual(["user", "other", "assistant"])
    expect(traj.events[2].text).toContain("Tool Read: /a.py")
  })
})
