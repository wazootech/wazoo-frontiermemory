import { importGraph, loadTfjsUseEmbeddingService } from "./src/graph"
import { readFile } from "node:fs/promises"

const state = "/tmp/vec-test"
const claims = JSON.parse(await readFile(`${state}/claims.json`, "utf8"))
const svc = await loadTfjsUseEmbeddingService("/tmp/tfjs-model")
try {
  const v = await svc.embed(["hello world", "second text"])
  console.log("embed ok:", v[0].length, "dims")
} catch (e) { console.error("EMBED FAILED:", e) }
try {
  await importGraph(claims, { modelDir: "/tmp/tfjs-model" })
} catch (e: any) {
  console.error("IMPORT FAILED:", e.message)
  console.error("CAUSE:", e.cause?.message ?? "(none)")
  console.error(e.cause?.stack ?? e.stack)
}
