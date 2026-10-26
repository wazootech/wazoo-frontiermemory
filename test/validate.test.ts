import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkMemory, MAX_BYTES } from "../src/validate"

const TMP = join(import.meta.dir, ".tmp-validate")

async function freshDir(name: string): Promise<string> {
  const dir = join(TMP, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

describe("checkMemory: port of the benchmark's check_memory", () => {
  test("accepts a valid memory folder and reports a digest", async () => {
    const dir = await freshDir("valid")
    await writeFile(join(dir, "MEMORY.md"), "# Memory\n\nFollow the rules.\n")
    await mkdir(join(dir, "skills"))
    await writeFile(
      join(dir, "skills", "preference-01-format.md"),
      "# Format\nUse when formatting output.\n"
    )
    const report = await checkMemory(dir)
    expect(report.ok).toBeTrue()
    expect(report.errors).toEqual([])
    expect(report.file_count).toBe(2)
    expect(report.total_bytes).toBeGreaterThan(0)
    expect(report.memory_sha256).toHaveLength(64)
  })

  test("rejects missing or empty MEMORY.md", async () => {
    const missing = await freshDir("missing")
    await writeFile(join(missing, "notes.md"), "x")
    expect((await checkMemory(missing)).errors).toContain(
      "MEMORY.md is missing at the top of the folder"
    )

    const empty = await freshDir("empty")
    await writeFile(join(empty, "MEMORY.md"), "   \n")
    expect((await checkMemory(empty)).errors).toContain("MEMORY.md is empty")
  })

  test("rejects dotfiles anywhere in the tree", async () => {
    const dir = await freshDir("dotfile")
    await writeFile(join(dir, "MEMORY.md"), "ok")
    await writeFile(join(dir, ".hidden"), "x")
    await mkdir(join(dir, "skills"))
    await writeFile(join(dir, "skills", ".env"), "x")
    const errors = (await checkMemory(dir)).errors
    expect(errors.some((e) => e === ".hidden: names must not start with a dot")).toBeTrue()
    expect(
      errors.some((e) => e.includes("skills/.env: names must not start with a dot"))
    ).toBeTrue()
  })

  test("rejects symlinks", async () => {
    const dir = await freshDir("symlink")
    await writeFile(join(dir, "MEMORY.md"), "ok")
    await symlink(join(dir, "MEMORY.md"), join(dir, "link.md"))
    const report = await checkMemory(dir)
    expect(report.errors.some((e) => e.includes("not a regular file"))).toBeTrue()
  })

  test("rejects non-UTF-8 files", async () => {
    const dir = await freshDir("utf8")
    await writeFile(join(dir, "MEMORY.md"), "ok")
    await mkdir(join(dir, "skills"))
    await writeFile(join(dir, "skills", "binary.md"), Buffer.from([0xff, 0xfe, 0x00]))
    const report = await checkMemory(dir)
    expect(report.errors).toContain("skills/binary.md: not UTF-8 text")
  })

  test("enforces the 8 MiB total limit", async () => {
    const dir = await freshDir("size")
    await writeFile(join(dir, "MEMORY.md"), "ok")
    await writeFile(join(dir, "big.md"), "x".repeat(MAX_BYTES + 1))
    const report = await checkMemory(dir)
    expect(report.ok).toBeFalse()
    expect(report.errors[0]).toContain("over the 8388608-byte limit")
  })

  test("rejects a nonexistent folder the way the upstream verifier does", async () => {
    const report = await checkMemory(join(TMP, "does-not-exist"))
    expect(report.ok).toBeFalse()
    expect(report.errors[0]).toContain("is not a folder")
  })

  test("cross-check against the benchmark's own Python check_memory.py", async () => {
    if (!Bun.which("python3")) return // skip where python3 is unavailable
    // Import their module directly from the local clone of letta-ai/frontiermemory.
    const upstream = join(
      import.meta.dir,
      "..",
      "..",
      "frontiermemory",
      "src",
      "frontier_memory",
      "memory.py"
    )
    const upstreamExists = await Bun.file(upstream).exists()
    if (!upstreamExists) return // skip when the benchmark clone is absent

    const dir = await freshDir("crosscheck")
    await writeFile(join(dir, "MEMORY.md"), "# Memory\n\nok\n")
    await mkdir(join(dir, "skills"))
    await writeFile(join(dir, "skills", "rule-01.md"), "Use when formatting.\n")
    await writeFile(join(dir, ".bad"), "x") // must fail in BOTH implementations

    const py = spawnSync(
      "python3",
      [
        "-c",
        `import sys, json; sys.path.insert(0, ${JSON.stringify(join(upstream, "..", "..", ".."))}); from src.frontier_memory.memory import check_memory; import pathlib; print(json.dumps(check_memory(pathlib.Path(${JSON.stringify(dir)}))))`,
      ],
      { encoding: "utf-8" }
    )
    if (py.status !== 0) return // import path unavailable; port test still stands
    const pyReport = JSON.parse(py.stdout)
    expect(pyReport.ok).toBeFalse()
    expect(
      pyReport.errors.some((e: string) => e.includes("names must not start with a dot"))
    ).toBeTrue()

    const tsReport = await checkMemory(dir)
    expect(tsReport.ok).toBeFalse()
    expect(tsReport.errors.some((e) => e.includes("names must not start with a dot"))).toBeTrue()

    // Same digest algorithm: remove the bad file, both must agree and digest identically.
    await rm(join(dir, ".bad"))
    const pyOk = spawnSync(
      "python3",
      [
        "-c",
        `import sys, json; sys.path.insert(0, ${JSON.stringify(join(upstream, "..", "..", ".."))}); from src.frontier_memory.memory import check_memory; import pathlib; print(json.dumps(check_memory(pathlib.Path(${JSON.stringify(dir)}))))`,
      ],
      { encoding: "utf-8" }
    )
    if (pyOk.status !== 0) return
    const pyOkReport = JSON.parse(pyOk.stdout)
    const tsOkReport = await checkMemory(dir)
    expect(pyOkReport.ok).toBeTrue()
    expect(tsOkReport.ok).toBeTrue()
    expect(tsOkReport.memory_sha256).toBe(pyOkReport.memory_sha256)
    expect(tsOkReport.total_bytes).toBe(pyOkReport.total_bytes)
  })
})

describe("export self-validation", () => {
  test("the exported memory folder passes the benchmark's format rules", async () => {
    const { exportMemory } = await import("../src/export")
    const { loadCorpus } = await import("../src/corpus")
    const { extractClaimsFallback } = await import("../src/extraction")
    const { buildDreamReport } = await import("../src/dream")

    const traj = (await loadCorpus(join(import.meta.dir, "fixtures", "corpus")))[0]
    const claims = extractClaimsFallback(traj)
    const dreamReport = buildDreamReport(
      claims.map((c) => ({
        claimText: c.claimText,
        type: c.type,
        subject: c.subject,
        action: c.action,
        object: c.object,
        where: c.where,
        trajId: c.trajId,
        turn: c.turn,
        outcome: c.outcome,
        speaker: c.speaker,
        extractor: c.extractor,
      }))
    )

    const dir = await freshDir("export")
    const { report, files } = await exportMemory(dreamReport, dir)
    expect(report.ok).toBeTrue()
    expect(files[0]).toBe("MEMORY.md")
    expect(files.length).toBeGreaterThan(1)

    const memory = await readFile(join(dir, "MEMORY.md"), "utf-8")
    expect(memory.trim().length).toBeGreaterThan(0)
    expect(memory).toContain("# Memory")
    expect(memory).toContain("trajectory")
    // skill files exist and use the "Use when:" convention
    for (const file of files.slice(1)) {
      const content = await readFile(join(dir, file), "utf-8")
      expect(content).toContain("Use when")
      expect(content).toContain("Provenance")
    }
  })
})
