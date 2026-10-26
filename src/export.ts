/**
 * Export: write the memory folder and self-validate it against the
 * benchmark's own format rules before finishing.
 *
 * Layout (everything beyond `MEMORY.md` is free per docs/rules.md, so we
 * use it):
 *
 *   MEMORY.md          — nonempty imperative index; the task agents load
 *                        this first, so every line is an instruction or a
 *                        pointer, never a summary of the corpus.
 *   skills/<slug>.md   — one file per curated pattern with a "Use when:"
 *                        description (skill-loading is picky; descriptions
 *                        are how files get opened) and inline provenance.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkMemory, ENTRY_FILE, type ValidationReport } from "./validate"
import type { DreamItem, DreamReport } from "./dream"

export interface ExportOptions {
  /** Include per-claim provenance lines in skill files (default true). */
  provenance?: boolean
  /** Max curated items per kind written to MEMORY.md. */
  maxIndexItems?: number
}

const KIND_LABEL: Record<DreamItem["kind"], string> = {
  "task-rule": "Task rules",
  "user-preference": "User preferences",
  "environment-fact": "Environment facts",
}

const KIND_FILE_PREFIX: Record<DreamItem["kind"], string> = {
  "task-rule": "rule",
  "user-preference": "preference",
  "environment-fact": "environment",
}

export function skillFileName(item: DreamItem, ordinal: number): string {
  const slug =
    item.key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "pattern"
  return `${KIND_FILE_PREFIX[item.kind]}-${String(ordinal).padStart(2, "0")}-${slug}.md`
}

function evidenceLines(item: DreamItem, max = 5): string[] {
  return item.evidence
    .slice(0, max)
    .map(
      (e) => `- Source: trajectory \`${e.trajId}\`, turn ${e.turn} (verifier result: ${e.outcome})`
    )
}

function useWhen(item: DreamItem): string {
  switch (item.kind) {
    case "task-rule":
      return "Use when performing the task, before acting — these are working rules the user enforced."
    case "user-preference":
      return "Use when choosing output format, style, naming, or anything the user expressed a preference about."
    case "environment-fact":
      return "Use when locating files, configs, or commands in this environment."
  }
}

function renderSkill(item: DreamItem, file: string): string {
  const lines: string[] = []
  lines.push(`# ${item.instruction}`, "")
  lines.push(`**Use when:** ${useWhen(item)}`, "")
  lines.push(item.text, "")
  lines.push(`Pattern key: \`${item.key}\`  ·  Supporting trajectories: ${item.support}`)
  if (item.evidence.length > 0) {
    lines.push("", "## Provenance", "")
    lines.push(...evidenceLines(item))
  }
  lines.push("", `<!-- exported as ${file} -->`, "")
  return lines.join("\n")
}

function renderMemoryIndex(
  report: DreamReport,
  skillFiles: Map<DreamItem, string>,
  opts: Required<ExportOptions>
): string {
  const lines: string[] = []
  lines.push("# Memory", "")
  lines.push(
    `Learned from ${report.stats.trajectories} agent trajectories (${report.stats.pass} PASS, ${report.stats.fail} FAIL, ${report.stats.unknown} unlabeled). Every rule below is imperative: follow it, and open the linked skill file for provenance before deviating.`,
    ""
  )

  for (const kind of ["task-rule", "user-preference", "environment-fact"] as const) {
    const items = (
      kind === "task-rule"
        ? report.taskRules
        : kind === "user-preference"
          ? report.userPreferences
          : report.environmentFacts
    ).slice(0, opts.maxIndexItems)
    if (items.length === 0) continue
    lines.push(`## ${KIND_LABEL[kind]}`, "")
    items.forEach((item, i) => {
      const file = skillFiles.get(item)
      lines.push(`${i + 1}. ${item.instruction}${file ? ` — see \`${file}\`` : ""}`)
    })
    lines.push("")
  }

  lines.push(
    "## How this memory was built",
    "",
    `- ${report.stats.claims} claims extracted from the trajectory corpus into a provenance-carrying claim graph.`,
    `- Near-duplicate phrasings were consolidated; each unique rule appears once.`,
    `- Patterns recurring across trajectories were promoted here; singletons stayed in the graph.`,
    `- Provenance per claim: trajectory id, turn, and the trajectory's verifier result (PASS/FAIL).`,
    ""
  )
  return lines.join("\n")
}

/** Write the memory folder. Returns the validation report for the export. */
export async function exportMemory(
  report: DreamReport,
  outDir: string,
  options: ExportOptions = {}
): Promise<{ report: ValidationReport; files: string[] }> {
  const opts: Required<ExportOptions> = { provenance: true, maxIndexItems: 12, ...options }
  await mkdir(join(outDir, "skills"), { recursive: true })

  const allItems: DreamItem[] = []
  const seen = new Set<string>()
  for (const item of [...report.taskRules, ...report.userPreferences, ...report.environmentFacts]) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    allItems.push(item)
  }

  const skillFiles = new Map<DreamItem, string>()
  const written: string[] = []
  for (const item of allItems.slice(0, opts.maxIndexItems * 3)) {
    const file = skillFileName(item, skillFiles.size + 1)
    skillFiles.set(item, `skills/${file}`)
    await writeFile(join(outDir, "skills", file), renderSkill(item, file), "utf-8")
    written.push(`skills/${file}`)
  }

  const memoryMd = renderMemoryIndex(report, skillFiles, opts)
  await writeFile(join(outDir, ENTRY_FILE), memoryMd, "utf-8")

  // Self-validate before finishing: a run must not die at the verifier.
  const validation = await checkMemory(outDir)
  if (!validation.ok) {
    throw new Error(`exported memory failed self-validation: ${validation.errors.join("; ")}`)
  }
  return { report: validation, files: [ENTRY_FILE, ...written] }
}
