import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { ensureVaultStructure, getVaultPaths, readJson } from "../extensions/llm-wiki/lib/utils.js";

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
});
