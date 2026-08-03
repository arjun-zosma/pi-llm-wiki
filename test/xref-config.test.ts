import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectVaultFormat,
  getLegacyVaultPaths,
  resolveVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";
import { createConfig, createWikiPage, readFile } from "./helpers.js";

describe("cross-reference integrity", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `xref-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = (() => {
      const dir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "wiki/changes",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should allow orphan detection by absence of inbound wikilinks", () => {
    createWikiPage(
      wikiDir,
      "entities",
      "orphan.md",
      "---\ntype: entity\ncategory: person\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: []\n---\n# Orphan\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "entities", "orphan.md"));
    expect(content).not.toContain("[[orphan");
  });

  it("should detect broken wikilinks referencing nonexistent pages", () => {
    createWikiPage(
      wikiDir,
      "concepts",
      "main.md",
      "---\ntype: concept\ndomain: ai\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources: []\n---\n\n# Main\n[[missing-page]] and [[another-missing]]\n",
    );
    const content = readFile(join(wikiDir, ".llm-wiki", "wiki", "concepts", "main.md"));
    expect(content).toContain("[[missing-page]]");
    expect(content).toContain("[[another-missing]]");
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "entities", "missing-page.md"))).toBe(
      false,
    );
    expect(existsSync(join(wikiDir, ".llm-wiki", "wiki", "concepts", "missing-page.md"))).toBe(
      false,
    );
  });
});

describe("configuration", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `config-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = (() => {
      const dir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "wiki/changes",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should accept personal mode config", () => {
    createConfig(wikiDir, { wiki: { mode: "personal", topic: "Learning" } });
    const config = readFile(join(wikiDir, ".llm-wiki", "config.yaml"));
    expect(config).toContain("mode: personal");
  });

  it("should accept company mode config", () => {
    createConfig(wikiDir, { wiki: { mode: "company", topic: "Competitors" } });
    const config = readFile(join(wikiDir, ".llm-wiki", "config.yaml"));
    expect(config).toContain("mode: company");
  });

  it("should support company mode with change detection pages", () => {
    createConfig(wikiDir, { wiki: { mode: "company", topic: "Market" }, change_detection: true });
    const config = readFile(join(wikiDir, ".llm-wiki", "config.yaml"));
    expect(config).toContain("mode: company");
    createWikiPage(
      wikiDir,
      "changes",
      "competitor-2026-04-27.md",
      "---\ntype: change\nentity: competitor\ndetected: 2026-04-27\n---\n\n# Change\nPricing changed from $99 to $149.\n",
    );
    expect(
      existsSync(join(wikiDir, ".llm-wiki", "wiki", "changes", "competitor-2026-04-27.md")),
    ).toBe(true);
    const content = readFile(
      join(wikiDir, ".llm-wiki", "wiki", "changes", "competitor-2026-04-27.md"),
    );
    expect(content).toContain("type: change");
    expect(content).toContain("Pricing changed");
  });

  it("should track discovery history", () => {
    const history = {
      processed: [{ path: ".llm-wiki/raw/articles/a.md", ingested: "2026-04-27" }],
    };
    writeFileSync(
      join(wikiDir, ".llm-wiki", ".discoveries", "history.json"),
      JSON.stringify(history),
    );
    const content = JSON.parse(
      readFile(join(wikiDir, ".llm-wiki", ".discoveries", "history.json")),
    );
    expect(content.processed).toHaveLength(1);
    expect(content.processed[0].path).toBe(".llm-wiki/raw/articles/a.md");
  });

  it("should track knowledge gaps", () => {
    const gaps = { gaps: [{ topic: "reinforcement learning", priority: "high" }] };
    writeFileSync(join(wikiDir, ".llm-wiki", ".discoveries", "gaps.json"), JSON.stringify(gaps));
    const content = JSON.parse(readFile(join(wikiDir, ".llm-wiki", ".discoveries", "gaps.json")));
    expect(content.gaps).toHaveLength(1);
    expect(content.gaps[0].priority).toBe("high");
  });
});

describe("backward compatibility", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `bc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wikiDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should detect new-format vault by .llm-wiki/config.json", () => {
    const configDir = join(wikiDir, ".llm-wiki");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
    );
    expect(detectVaultFormat(wikiDir)).toBe("new");
  });

  it("should detect a damaged project vault without config", () => {
    mkdirSync(join(wikiDir, ".llm-wiki", "wiki", "concepts"), { recursive: true });
    expect(detectVaultFormat(wikiDir)).toBe("new");
    expect(resolveVaultPaths(wikiDir).root).toBe(wikiDir);
    expect(resolveVaultPaths(wikiDir).dotWiki).toBe(join(wikiDir, ".llm-wiki"));
  });

  it("should detect legacy-format vault by .wiki/config.json", () => {
    const oldDir = join(wikiDir, ".wiki");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, "config.json"),
      JSON.stringify({ topic: "Legacy", mode: "personal" }),
    );
    expect(detectVaultFormat(wikiDir)).toBe("legacy");
  });

  it("should resolve paths for legacy vaults via getLegacyVaultPaths", () => {
    const oldDir = join(wikiDir, ".wiki");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, "config.json"),
      JSON.stringify({ topic: "Legacy", mode: "personal" }),
    );
    mkdirSync(join(wikiDir, "raw", "sources"), { recursive: true });
    mkdirSync(join(wikiDir, "wiki", "concepts"), { recursive: true });
    mkdirSync(join(wikiDir, "meta"), { recursive: true });
    const paths = getLegacyVaultPaths(wikiDir);
    expect(paths.raw).toBe(join(wikiDir, "raw"));
    expect(paths.wiki).toBe(join(wikiDir, "wiki"));
    expect(paths.meta).toBe(join(wikiDir, "meta"));
    expect(paths.rawSources).toBe(join(wikiDir, "raw", "sources"));
    expect(paths.dotWiki).toBe(join(wikiDir, ".wiki"));
    expect(existsSync(join(wikiDir, "raw", "sources"))).toBe(true);
    expect(existsSync(join(wikiDir, "wiki", "concepts"))).toBe(true);
  });

  it("should auto-detect legacy vault via resolveVaultPaths", () => {
    const oldDir = join(wikiDir, ".wiki");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, "config.json"),
      JSON.stringify({ topic: "Legacy", mode: "personal" }),
    );
    mkdirSync(join(wikiDir, "raw", "sources"), { recursive: true });
    mkdirSync(join(wikiDir, "wiki", "concepts"), { recursive: true });
    const paths = resolveVaultPaths(wikiDir);
    expect(paths.raw).toBe(join(wikiDir, "raw"));
    expect(paths.wiki).toBe(join(wikiDir, "wiki"));
    expect(paths.dotWiki).toBe(join(wikiDir, ".wiki"));
  });

  it("should detect no vault", () => {
    expect(detectVaultFormat(wikiDir)).toBe("none");
  });
});
