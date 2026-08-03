import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  it.each(["okf-0.3", 2, null])("fails closed for explicit invalid mode %j", (value) => {
    const state = inspectVaultFormat(vault({ knowledge_format: value }));
    expect(state.blocking).toBe(true);
    expect(state.diagnostics[0].code).toBe("config_invalid_knowledge_format");
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
