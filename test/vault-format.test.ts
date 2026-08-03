import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureVaultStructure, getVaultPaths, slugify } from "../extensions/llm-wiki/lib/utils.js";
import {
  discoverKnowledgeDocuments,
  inspectVaultFormat,
} from "../extensions/llm-wiki/lib/vault-format.js";

const roots: string[] = [];
function vault(config: Record<string, unknown>) {
  const root = join(import.meta.dirname, "..", "tmp", `format-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), `${JSON.stringify(config)}\n`);
  return paths;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("vault format", () => {
  it("defaults a missing field to legacy", () => {
    expect(inspectVaultFormat(vault({ name: "Old" })).knowledgeFormat).toBe("legacy");
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{not-json"],
    ["array", "[]"],
  ])("fails closed for %s config", (_label, configText) => {
    const paths = vault({ knowledge_format: "legacy" });
    const configPath = join(paths.dotWiki, "config.json");
    if (configText === undefined) rmSync(configPath);
    else writeFileSync(configPath, configText);
    const state = inspectVaultFormat(paths);
    expect(state.blocking).toBe(true);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "config_invalid_knowledge_format",
    );
  });

  it.each(["okf-0.3", 2, null])("fails closed for explicit invalid mode %j", (value) => {
    const state = inspectVaultFormat(vault({ knowledge_format: value }));
    expect(state.blocking).toBe(true);
    expect(state.diagnostics[0].code).toBe("config_invalid_knowledge_format");
  });

  it.each([
    ["frontmatter-less", "# user index\n"],
    ["malformed", "---\nokf_version: [\n---\n"],
    ["versionless", "---\ntitle: Root\n---\n"],
  ])("blocks an existing %s OKF root index", (_label, content) => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    writeFileSync(join(paths.wiki, "index.md"), content);
    const state = inspectVaultFormat(paths);
    expect(state.blocking).toBe(true);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "okf_version_mismatch",
    );
  });

  it("turns an unreadable OKF root into a blocking diagnostic", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    mkdirSync(join(paths.wiki, "index.md"));
    expect(() => inspectVaultFormat(paths)).not.toThrow();
    const state = inspectVaultFormat(paths);
    expect(state.blocking).toBe(true);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "okf_version_mismatch",
    );
  });

  it("repairs a missing root index in OKF mode but blocks an unsupported version", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    expect(inspectVaultFormat(paths).blocking).toBe(false);
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');
    const state = inspectVaultFormat(paths);
    expect(state.blocking).toBe(true);
    expect(state.diagnostics[0].code).toBe("okf_version_mismatch");
  });

  it("reports and blocks projections without activating an unsupported legacy root version", () => {
    const paths = vault({ knowledge_format: "legacy" });
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');
    const state = inspectVaultFormat(paths);
    expect(state.knowledgeFormat).toBe("legacy");
    expect(state.blocking).toBe(true);
    expect(state.diagnostics.map((d) => d.code)).toContain("okf_version_mismatch");
  });

  it("excludes reserved files and normalizes ids to NFC with slash separators", () => {
    const paths = vault({ knowledge_format: "legacy" });
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "cafe\u0301.md"), "---\ntype: concept\n---\n");
    writeFileSync(join(paths.wiki, "concepts", "INDEX.md"), "user file");
    writeFileSync(join(paths.wiki, "log.md"), "user file");
    const scan = discoverKnowledgeDocuments(paths);
    expect(scan.documents.map((d) => d.id)).toEqual(["concepts/café"]);
  });

  it("blocks physically distinct NFC-equivalent paths", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "café.md"), "---\ntype: concept\n---\n");
    writeFileSync(join(paths.wiki, "concepts", "café.md"), "---\ntype: concept\n---\n");
    const result = discoverKnowledgeDocuments(paths);
    expect(result.blocking).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "concept_identity_collision",
    );
  });

  it("does not follow directory symlinks outside the wiki", () => {
    const paths = vault({ knowledge_format: "legacy" });
    const external = join(paths.root, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "outside.md"), "---\ntype: concept\n---\n");
    symlinkSync(external, join(paths.wiki, "linked"), "dir");
    expect(discoverKnowledgeDocuments(paths).documents).toEqual([]);
  });

  it("blocks publication when a knowledge directory cannot be scanned", () => {
    const paths = vault({ knowledge_format: "legacy" });
    const unreadable = join(paths.wiki, "concepts");
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o000);
    try {
      const result = discoverKnowledgeDocuments(paths);
      if (process.getuid?.() !== 0) {
        expect(result.blocking).toBe(true);
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "frontmatter_parse_error",
        );
      }
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });

  it("blocks NFC and case-fold collisions without returning a partial scan", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    writeFileSync(join(paths.wiki, "A.md"), "---\ntype: concept\n---\n");
    writeFileSync(join(paths.wiki, "a.md"), "---\ntype: concept\n---\n");
    const scan = discoverKnowledgeDocuments(paths);
    expect(scan.blocking).toBe(true);
    expect(scan.diagnostics.map((d) => d.code)).toContain("concept_identity_collision");
  });

  it("never generates reserved slugs", () => {
    expect(slugify("Index")).toBe("index-page");
    expect(slugify("LOG")).toBe("log-page");
  });
});
