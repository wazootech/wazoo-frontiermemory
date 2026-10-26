/**
 * Memory format validator — a faithful TypeScript port of the benchmark's
 * own `src/frontier_memory/memory.py` `check_memory` (stdlib-only upstream;
 * this port has the same rules and the same report shape):
 *
 * - `MEMORY.md` at the top of the folder, not empty
 * - regular UTF-8 text files and folders only: no symlinks, special files,
 *   or names starting with a dot
 * - at most 8 MiB total
 *
 * The export phase validates its own output with this before finishing, so
 * a run cannot die at the verifier.
 */

import { lstat, readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"

export const MAX_BYTES = 8 * 1024 * 1024
export const ENTRY_FILE = "MEMORY.md"

export interface ValidationReport {
  ok: boolean
  errors: string[]
  max_bytes: number
  total_bytes: number
  file_count: number
  files: Array<{ path: string; bytes: number; sha256: string }>
  memory_sha256?: string
}

/** One SHA-256 over every file's relative path and bytes, in sorted order. */
export function memoryDigest(files: Array<{ path: string; bytes: Buffer }>): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of files) {
    hasher.update(Buffer.from(file.path + "\0", "utf-8"))
    hasher.update(file.bytes)
    hasher.update(Buffer.from("\0"))
  }
  return hasher.digest("hex")
}

export async function checkMemory(root: string, maxBytes = MAX_BYTES): Promise<ValidationReport> {
  const errors: string[] = []
  const rootStat = await stat(root).catch(() => undefined)
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      ok: false,
      errors: [`${root} is not a folder`],
      max_bytes: maxBytes,
      total_bytes: 0,
      file_count: 0,
      files: [],
    }
  }

  // Walk the tree depth-first, sorted, mirroring Python's sorted rglob.
  const files: Array<{ path: string; bytes: Buffer }> = []
  let total = 0

  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split("\\").join("/")
      const parts = rel.split("/")
      if (parts.some((p) => p.startsWith("."))) {
        errors.push(`${rel}: names must not start with a dot`)
        continue
      }
      const l = await lstat(abs)
      if (l.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!l.isFile()) {
        errors.push(`${rel}: not a regular file (symlink or special file)`)
        continue
      }
      const data = await readFile(abs)
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data)
      } catch {
        errors.push(`${rel}: not UTF-8 text`)
      }
      total += data.length
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex")
      files.push({ path: rel, bytes: data })
      void sha256
    }
  }

  await walk(root)

  const entryPath = join(root, ENTRY_FILE)
  const entryStat = await lstat(entryPath).catch(() => undefined)
  if (!entryStat || !entryStat.isFile()) {
    errors.push(`${ENTRY_FILE} is missing at the top of the folder`)
  } else {
    const text = await readFile(entryPath, "utf-8")
    if (!text.trim()) errors.push(`${ENTRY_FILE} is empty`)
  }
  if (total > maxBytes) {
    errors.push(`total size ${total} bytes is over the ${maxBytes}-byte limit`)
  }

  const report: ValidationReport = {
    ok: errors.length === 0,
    errors,
    max_bytes: maxBytes,
    total_bytes: total,
    file_count: files.length,
    files: files.map((f) => ({
      path: f.path,
      bytes: f.bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(f.bytes).digest("hex"),
    })),
  }
  if (report.ok) report.memory_sha256 = memoryDigest(files)
  return report
}
