import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureText } from "../extensions/llm-wiki/lib/source-packet.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { inspectVaultFormat } from "../extensions/llm-wiki/lib/vault-format.js";
import { getWikiStatus, searchRegistry } from "../extensions/llm-wiki/lib/wiki-service.js";
import { createExecApi } from "../mcp/exec.js";
import {
  captureSourceOperation,
  recallOperation,
  retroOperation,
  searchOperation,
  statusOperation,
} from "../mcp/operations.js";

describe("MCP parity with shared services", () => {
  let tmpDir: string;
  let paths: ReturnType<typeof getVaultPaths>;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `mcp-parity-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    paths = getVaultPaths(tmpDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal", knowledge_format: "legacy" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("search parity: MCP matches shared searchRegistry", async () => {
    // Create a concept
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "nested.md"),
      "---\ntype: concept\ntitle: Nested Concept\ndescription: A nested concept about trees\n---\n\n# Nested Concept\n\nTree content.",
    );
    rebuildMetadata(paths);

    const piSearch = searchRegistry(paths, "nested");
    const mcpSearch = await searchOperation(paths, "nested");

    expect(mcpSearch.matches).toEqual(piSearch.matches);
    expect(mcpSearch.diagnostics).toEqual(
      piSearch.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    );
  });

  it("status parity: MCP matches shared getWikiStatus", async () => {
    rebuildMetadata(paths);

    const piStatus = getWikiStatus(paths);
    const mcpStatus = await statusOperation(paths);

    expect(mcpStatus.knowledgeFormat).toBe(piStatus.knowledgeFormat);
    expect(mcpStatus.totalPages).toBe(piStatus.totalPages);
    expect(mcpStatus.byType).toEqual(piStatus.byType);
    expect(mcpStatus.lastUpdated).toBe(piStatus.lastUpdated);
    expect(mcpStatus.blockingDiagnostics).toEqual(
      piStatus.blockingDiagnostics.map((d) => ({ code: d.code, message: d.message })),
    );
  });

  it("recall parity: MCP matches shared searchWiki with vault diagnostics", async () => {
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "nested.md"),
      "---\ntype: concept\ntitle: Nested Concept\ndescription: A nested concept\n---\n\n# Nested Concept\n\nContent here.",
    );
    rebuildMetadata(paths);

    const piRecall = searchWiki(paths, "nested", 5);
    const mcpRecall = await recallOperation(paths, "nested", 5);

    expect(mcpRecall.results).toEqual(piRecall);
    expect(mcpRecall.diagnostics.map((d) => d.code)).toEqual(
      inspectVaultFormat(paths).diagnostics.map((d) => d.code),
    );
  });

  it("retro parity: MCP uses same saveInsight as Pi", async () => {
    // Pi-style call
    const piResult = saveInsight(paths, "pi-insight", "Pi Title", "Pi body.", "test", {
      rebuild: false,
    });

    // MCP call
    const mcpResult = await retroOperation(paths, "mcp-insight", "MCP Title", "MCP body.", "test");
    expect(mcpResult.ok).toBe(true);
    if (!mcpResult.ok) return;

    // Both produce canonical pages
    const piContent = readFileSync(piResult.sourcePagePath, "utf-8");
    const mcpContent = readFileSync(mcpResult.sourcePagePath, "utf-8");
    expect(piContent).toContain("type: source");
    expect(mcpContent).toContain("type: source");
    expect(piContent).toContain("status: insight");
    expect(mcpContent).toContain("status: insight");
  });

  it("capture parity: MCP uses same captureText as Pi", async () => {
    // Pi-style call
    const piResult = captureText(paths, "Test content", "Pi Capture");

    // MCP call
    const mcpResult = await captureSourceOperation(
      paths,
      { text: "Test content", title: "MCP Capture" },
      createExecApi(),
    );
    expect(mcpResult.ok).toBe(true);
    if (!mcpResult.ok) return;

    // Both create source packets
    const piPage = readFileSync(piResult.sourcePagePath, "utf-8");
    const mcpPage = readFileSync(join(paths.wiki, "sources", `${mcpResult.sourceId}.md`), "utf-8");
    expect(piPage).toContain("type: source");
    expect(mcpPage).toContain("type: source");
  });

  it("makes MCP retro immediately searchable", async () => {
    const result = await retroOperation(
      paths,
      "mcp-visible",
      "Visible Insight",
      "searchable needle",
    );
    expect(result.ok).toBe(true);
    expect(searchRegistry(paths, "Visible Insight").matches.map((match) => match.id)).toContain(
      "sources/mcp-visible",
    );
  });

  it("makes MCP text capture immediately recallable", async () => {
    const result = await captureSourceOperation(
      paths,
      { text: "capture needle", title: "Visible Capture" },
      createExecApi(),
    );
    expect(result.ok).toBe(true);
    expect(searchRegistry(paths, "Visible Capture").matches).toHaveLength(1);
  });

  it("returns blocking projection diagnostics after a successful authoritative write", async () => {
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), "malformed\n");
    const result = await retroOperation(paths, "written-but-blocked", "Written", "Body");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "frontmatter_missing",
    );
  });

  it("exactly five tools registered", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "mcp", "index.ts"), "utf-8");
    const tools = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(tools).toEqual([
      "wiki_recall",
      "wiki_search",
      "wiki_status",
      "wiki_retro",
      "wiki_capture_source",
    ]);
  });
});
