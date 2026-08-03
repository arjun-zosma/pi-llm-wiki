import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reindexEmbeddings: vi.fn(async () => ({ embedded: 0, skipped: 0, total: 0, pruned: 0 })),
  resolveEmbedder: vi.fn(() => ({
    model: "test",
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  })),
}));
vi.mock("../extensions/llm-wiki/lib/embeddings.js", () => mocks);

import { __resetIndexingState, scheduleReindex } from "../extensions/llm-wiki/lib/indexing.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  __resetIndexingState();
  mocks.reindexEmbeddings.mockClear();
  mocks.resolveEmbedder.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("does not refresh embeddings after a blocking projection failure", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `index-fail-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  writeFileSync(join(paths.wiki, "concepts", "bad.md"), "not frontmatter\n");
  const runtime = new Runtime();
  runtime.ensureConfig = () => {};
  runtime.config = { embeddingProvider: "openai" };
  await scheduleReindex(runtime, { hasUI: false }, paths);
  await runtime.awaitAll();
  expect(mocks.reindexEmbeddings).not.toHaveBeenCalled();
});
