# Wazoo FrontierMemory agent

Agent-native conventions for this repository.

## Purpose

This repo implements Wazoo's memory agent for the letta-ai/frontiermemory
benchmark. The benchmark's rules (`docs/rules.md` in that repo) are binding on
everything here: the memory agent may contact only its model API host during
generation, must not use web search, must produce a UTF-8 memory folder with a
nonempty `MEMORY.md` at the root, ≤8 MiB total, no dotfiles or symlinks.

## Layout

- `src/` — the Bun/TypeScript pipeline (ingest → dream → export)
- `docs/` — design notes, run records, score reports
- Runs in the benchmark happen on Modal (or Docker) — never assume this repo's
  development machine can reach Modal's gRPC control plane.

## Conventions

- Never hand-edit benchmark corpus data; it is pinned by SHA256SUMS upstream.
- Extraction failures need bounded retries plus a deterministic fallback so one
  API error cannot burn the 6-hour generation budget.
- Record every scored run under `docs/runs/` with: date, corpus digest, package
  versions, command line, and score — mirroring wazoo-memorybench's methodology.
