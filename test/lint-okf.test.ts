import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { registerWikiLint } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};
const root = join(import.meta.dirname, "..", "tmp", `lint-okf-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("reports and auto-fixes one target referenced by Markdown and a legacy wikilink", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Lint test" }));
  writeFileSync(
    join(paths.wiki, "concepts", "markdown-source.md"),
    "---\ntype: concept\ntitle: Markdown source\n---\n\n[missing](/concepts/missing.md)\n",
  );
  writeFileSync(
    join(paths.wiki, "concepts", "wikilink-source.md"),
    "---\ntype: concept\ntitle: Wikilink source\n---\n\n[[concepts/missing]]\n",
  );

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const result = await tool.execute("test", { auto_fix: true }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain("Missing: 2");
  expect(existsSync(join(paths.wiki, "concepts", "missing.md"))).toBe(true);
  const gaps = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(gaps.gaps).toEqual([
    {
      topic: "concepts/missing",
      mentionedBy: ["concepts/markdown-source", "concepts/wikilink-source"],
    },
  ]);
});
