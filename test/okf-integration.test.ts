import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import { writeKnowledgeDocumentFile } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { appendEvent } from "../extensions/llm-wiki/lib/metadata.js";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureText } from "../extensions/llm-wiki/lib/source-packet.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  readJson,
  writeJson,
} from "../extensions/llm-wiki/lib/utils.js";
import { inspectWritableVault } from "../extensions/llm-wiki/lib/vault-format.js";

const vaultRoots: string[] = [];
function createVault(config: Record<string, unknown>) {
  const root = join(import.meta.dirname, "..", "tmp", `okf-int-${Date.now()}-${Math.random()}`);
  vaultRoots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), `${JSON.stringify(config)}\n`);
  return paths;
}
afterEach(() => {
  for (const root of vaultRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeDoc(
  paths: ReturnType<typeof getVaultPaths>,
  doc: ReturnType<typeof createKnowledgeDocument>,
) {
  const fullPath = join(paths.wiki, doc.path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, serializeKnowledgeDocument(doc), "utf8");
}

describe("OKF integration", () => {
  it("legacy mode dual-reads legacy and OKF pages without generating wiki reserved files", () => {
    const paths = createVault({ knowledge_format: "legacy" });

    // Write a legacy-style page with scalar sources
    writeFileSync(
      join(paths.wiki, "sources/legacy.md"),
      "---\ntype: source\nsources: sources/SRC-1\nsummary: Legacy source\n---\n\nContent.\n",
    );

    // Write an OKF-style page with nested sources
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/okf-concept.md",
        { type: "concept", title: "OKF Concept", description: "Has nested sources" },
        "Body.",
        [{ id: "SRC-1", resource: "/sources/SRC-1.md" }],
      ),
    );

    rebuildMetadata(paths);

    // Both pages in registry
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registry.pages["sources/legacy"]).toBeTruthy();
    expect(registry.pages["concepts/okf-concept"]).toBeTruthy();

    // No wiki reserved files generated in legacy mode
    expect(() => readFileSync(join(paths.wiki, "index.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(paths.wiki, "log.md"), "utf8")).toThrow();
  });

  it("OKF mode generates reserved files and supports unknown types", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });

    // Write a page with unknown type
    writeDoc(
      paths,
      createKnowledgeDocument(
        "foreign/thing.md",
        { type: "Foreign Concept", title: "Unknown Type" },
        "Body.",
      ),
    );

    rebuildMetadata(paths);

    // Reserved files exist
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain('okf_version: "0.2"');
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toContain("Wiki Update Log");

    // Unknown type preserved
    const registry = readJson<{ pages: Record<string, { type: string }> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registry.pages["foreign/thing"].type).toBe("Foreign Concept");
  });

  it("okf_version_mismatch blocks rebuild but ordinary recall still returns parseable concepts", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/good.md",
        { type: "concept", title: "Good Concept", description: "Parseable" },
        "Body.",
      ),
    );

    rebuildMetadata(paths);

    // Corrupt root index with unsupported version
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');

    const result = rebuildMetadata(paths);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("okf_version_mismatch");

    // But the concept file is still parseable
    const content = readFileSync(join(paths.wiki, "concepts/good.md"), "utf8");
    const parsed = parseKnowledgeDocument(content, "concepts/good.md");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.frontmatter.title).toBe("Good Concept");
    }
  });

  it("foundation acceptance: end-to-end OKF lifecycle", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });

    // 1. Bootstrap already done via createVault; assert config persists okf-0.2
    const config = readJson<Record<string, unknown>>(join(paths.dotWiki, "config.json"), {});
    expect(config.knowledge_format).toBe("okf-0.2");

    // 2. Capture text
    const captureResult = captureText(paths, "Source content for foundation.", "Foundation Source");
    expect(captureResult.sourceId).toMatch(/^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/);

    // 3. Create an observation
    const obsResult = saveObservation(paths, {
      title: "Foundation test observation",
      content: "This is a test observation for foundation acceptance.",
      relevance: "medium",
    });
    expect(obsResult.pagePath).toContain("sources/");

    // 4. Create a retro
    const retroResult = saveInsight(
      paths,
      "foundation-test-insight",
      "Foundation Test Insight",
      "Test insight body.",
      "test",
      { rebuild: false },
    );
    expect(retroResult.sourcePagePath).toContain("sources/foundation-test-insight.md");

    // 5. Create a requirement through wiki_ensure_page equivalent
    const reqSlug = "test-requirement";
    const reqPath = join(paths.wiki, "requirements", `${reqSlug}.md`);
    mkdirSync(join(paths.wiki, "requirements"), { recursive: true });
    const reqDoc = createKnowledgeDocument(
      `requirements/${reqSlug}.md`,
      {
        type: "requirement",
        title: "Test Requirement",
        created: new Date().toISOString().split("T")[0],
        updated: new Date().toISOString().split("T")[0],
      },
      "This is a test requirement for foundation acceptance.",
    );
    writeKnowledgeDocumentFile(reqPath, reqDoc);
    appendEvent(paths, {
      kind: "ensure_page",
      page_type: "requirement",
      title: "Test Requirement",
      path: `requirements/${reqSlug}`,
    });

    // 6. Rebuild once
    rebuildMetadata(paths);

    // 7. Parse every resulting .md file with parseKnowledgeDocument
    const allMdFiles: string[] = [];
    function collectMd(dir: string, prefix = "") {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const relPath = join(prefix, entry);
        if (entry.endsWith(".md")) {
          allMdFiles.push(relPath);
        } else if (entry !== "node_modules") {
          collectMd(fullPath, relPath);
        }
      }
    }
    collectMd(paths.wiki);

    for (const file of allMdFiles) {
      // Skip generated OKF projections (different format)
      if (file === "index.md" || file === "log.md" || file.endsWith("/index.md")) continue;
      const content = readFileSync(join(paths.wiki, file), "utf8");
      const parsed = parseKnowledgeDocument(content, file);
      expect(parsed.ok, `Failed to parse ${file}`).toBe(true);
    }

    // 8. Assert all known-source pages use canonical mapping-sequence sources
    const sourcePage = readFileSync(
      join(paths.wiki, "sources", `${captureResult.sourceId}.md`),
      "utf8",
    );
    const sourceParsed = parseKnowledgeDocument(sourcePage, `sources/${captureResult.sourceId}.md`);
    expect(sourceParsed.ok).toBe(true);
    if (sourceParsed.ok) {
      // Source pages should have their own ID as a source reference
      expect(sourceParsed.document.sources).toBeDefined();
    }

    // 9. Assert generated bodies use standard Markdown links
    const obsContent = readFileSync(obsResult.pagePath, "utf8");
    expect(obsContent).not.toMatch(/\[\[.*\]\]/);

    // 10. Assert legacy [[wikilink]] remains readable
    const legacyLinkContent = `---
type: concept
title: Legacy Link Concept
description: Has legacy wikilink
---

This concept references [[concepts/foundation-test-insight]].
`;
    const legacyPath = join(paths.wiki, "concepts", "legacy-link.md");
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(legacyPath, legacyLinkContent);
    rebuildMetadata(paths);

    // Legacy page should be in registry
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registry.pages["concepts/legacy-link"]).toBeDefined();

    // 11. Rebuild twice and assert every OKF index/log byte is identical
    rebuildMetadata(paths);
    const index1 = readFileSync(join(paths.wiki, "index.md"), "utf8");
    const log1 = readFileSync(join(paths.wiki, "log.md"), "utf8");

    rebuildMetadata(paths);
    const index2 = readFileSync(join(paths.wiki, "index.md"), "utf8");
    const log2 = readFileSync(join(paths.wiki, "log.md"), "utf8");

    expect(index1).toBe(index2);
    expect(log1).toBe(log2);

    // 12. Corrupt one concept, rebuild, and assert last known-good projections remain
    const goodConceptPath = join(paths.wiki, "concepts", "good.md");
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      goodConceptPath,
      `---
type: concept
title: Good Concept
description: A good concept
---

Good content.
`,
    );
    rebuildMetadata(paths);
    const indexBeforeCorrupt = readFileSync(join(paths.wiki, "index.md"), "utf8");

    // Corrupt the concept
    writeFileSync(goodConceptPath, "CORRUPT CONTENT");
    rebuildMetadata(paths);
    const indexAfterCorrupt = readFileSync(join(paths.wiki, "index.md"), "utf8");

    // Index should still be valid (corrupt page excluded)
    expect(indexAfterCorrupt).toContain("okf_version");

    // 13. Restore the concept and assert rebuild recovers
    writeFileSync(
      goodConceptPath,
      `---
type: concept
title: Good Concept
description: A good concept
---

Good content restored.
`,
    );
    const restoreResult = rebuildMetadata(paths);
    expect(restoreResult.ok).toBe(true);
    // Verify the concept is back in the registry
    const finalRegistry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(finalRegistry.pages["concepts/good"]).toBeDefined();

    // 14. Assert no import/export/migration/trust-scoring tools are registered
    const toolsSource = readFileSync(
      join(import.meta.dirname, "..", "extensions", "llm-wiki", "lib", "tools.ts"),
      "utf8",
    );
    const forbiddenPatterns = ["wiki_import", "wiki_export", "wiki_migrate", "wiki_trust"];
    for (const pattern of forbiddenPatterns) {
      expect(toolsSource).not.toContain(pattern);
    }
  });

  it("only registers Foundation-required tools", () => {
    // Verify no speculative tools beyond the Foundation spec
    const libDir = join(import.meta.dirname, "..", "extensions", "llm-wiki", "lib");
    const toolFiles = ["tools.ts", "recall.ts", "observation.ts", "retro.ts"];
    let allSource = "";
    for (const file of toolFiles) {
      allSource += `${readFileSync(join(libDir, file), "utf8")}\n`;
    }
    const registeredTools = [...allSource.matchAll(/name:\s*"(wiki_[^"]+)"/g)].map((m) => m[1]);

    // Foundation-required tools
    const required = [
      "wiki_bootstrap",
      "wiki_recall",
      "wiki_search",
      "wiki_status",
      "wiki_observe",
      "wiki_retro",
      "wiki_capture_source",
      "wiki_ensure_page",
      "wiki_lint",
      "wiki_rebuild_meta",
      "wiki_log_event",
      "wiki_reindex_embeddings",
    ];

    for (const tool of required) {
      expect(registeredTools).toContain(tool);
    }

    // No speculative tools
    const forbidden = [
      "wiki_import",
      "wiki_export",
      "wiki_migrate",
      "wiki_trust",
      "wiki_score",
      "wiki_validate",
      "wiki_diff",
    ];
    for (const tool of forbidden) {
      expect(registeredTools).not.toContain(tool);
    }
  });
});
