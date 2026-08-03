import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return { gate, release: () => releaseGate() };
});

vi.mock("../extensions/llm-wiki/lib/subagent.js", () => ({
  runSubAgent: vi.fn(
    async (args: { tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> }) => {
      await control.gate;
      await args.tools[0].execute("commit", {
        summary: "Summary",
        key_takeaways: [],
        entities: [],
        concepts: [],
      });
    },
  ),
}));

import { runIngestSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("rechecks vault mode after synthesis and before background commit", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `ingest-race-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  const pending = runIngestSynthesis({
    model: { provider: "test", id: "model" } as never,
    apiKey: "key",
    paths,
    sourceId: "SRC-001",
    manifest: { id: "SRC-001", title: "Some Paper" },
    extracted: "content",
  });

  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ knowledge_format: "invalid" }),
  );
  control.release();
  const result = await pending;
  expect(result).toBeUndefined();
  expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(false);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});
