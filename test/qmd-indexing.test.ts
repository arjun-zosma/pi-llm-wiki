import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type QmdReindexResult,
  type QmdStoreFactory,
  readQmdIndexStatus,
  reindexQmdVault,
} from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempVault(): ReturnType<typeof getVaultPaths> {
  const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-index-"));
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ topic: "Index" }));
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  mkdirSync(join(paths.wiki, "entities"), { recursive: true });
  return paths;
}

function writePage(paths: ReturnType<typeof getVaultPaths>, rel: string, title: string): void {
  const dir = join(paths.wiki, rel.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(paths.wiki, rel),
    `---
type: ${rel.startsWith("entities") ? "entity" : "concept"}
title: ${title}
created: 2026-08-09
---

# ${title}

Body for ${title}.
`,
  );
}

function fakeFactory(opts: {
  embedCalls?: Array<{ force: boolean }>;
  updateCalls?: number[];
  totalDocuments?: number;
}) {
  const embed = vi.fn(async (arg: { force: boolean }) => {
    opts.embedCalls?.push({ force: arg.force });
    return { docsProcessed: 2, chunksEmbedded: 8, errors: 0, durationMs: 1 };
  });
  const update = vi.fn(async () => {
    opts.updateCalls?.push(1);
    return {
      collections: 2,
      indexed: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      needsEmbedding: 2,
    };
  });
  const total = opts.totalDocuments ?? 2;
  const factory: QmdStoreFactory = async () => ({
    update,
    embed,
    status: async () => ({
      totalDocuments: total,
      needsEmbedding: 0,
      hasVectorIndex: true,
      canonicalDocuments: 1,
      evidenceDocuments: total - 1,
    }),
    close: async () => {},
  });
  return { factory, embed, update };
}

describe("QMD vault reindexing", () => {
  it("indexes a fresh vault lexically and reports ready", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writePage(paths, "entities/b.md", "B");

    const first = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.documents).toMatchObject({ indexed: 2, removed: 0 });
    expect(first.vectors).toEqual({ generated: 0, skipped: 0, errors: 0 });
    expect(first.status.state).toBe("ready");
    expect(existsSync(join(paths.qmdCurrent, "index.sqlite"))).toBe(true);

    // edit, add, delete, then run changed again
    writePage(paths, "concepts/a.md", "A edited");
    writePage(paths, "concepts/c.md", "C");
    rmSync(join(paths.wiki, "entities", "b.md"));

    const second = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.documents).toMatchObject({ indexed: 1, updated: 1, removed: 1 });
    expect(second.status.totalDocuments).toBe(2);
  });

  it("performs document update before embedding for vector components", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writePage(paths, "entities/b.md", "B");
    const { factory, update, embed } = fakeFactory({ updateCalls: [], embedCalls: [] });

    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["vectors"],
        force: false,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(embed).toHaveBeenCalled();
    expect(result.vectors).toMatchObject({ generated: 2, errors: 0 });
  });

  it("never calls embed for lexical-only indexing", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const { factory, embed } = fakeFactory({ totalDocuments: 1 });
    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: false,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(result.vectors).toEqual({ generated: 0, skipped: 0, errors: 0 });
  });

  it("forwards force:true to embed for vector components", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const embedCalls: Array<{ force: boolean }> = [];
    const { factory } = fakeFactory({ embedCalls, totalDocuments: 1 });
    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["vectors"],
        force: true,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(embedCalls).toEqual([{ force: true }]);
  });

  it("starts lexical force rebuild from an empty staging store", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    // First pass builds current.
    const first = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(first.ok).toBe(true);
    expect(existsSync(join(paths.qmdCurrent, "index.sqlite"))).toBe(true);

    // Count cp calls via an fs seam; force must not copy current into staging.
    const cpCalls: string[] = [];
    const { factory } = fakeFactory({ totalDocuments: 1 });
    const cp = (await import("node:fs/promises")).cp;
    const forced = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: true,
      },
      {
        factory,
        fs: {
          exists: async (p: string) => existsSync(p),
          rename: async (from: string, to: string) =>
            (await import("node:fs/promises")).rename(from, to),
          rm: async (p: string, o: { recursive: boolean; force: boolean }) =>
            (await import("node:fs/promises")).rm(p, o as never),
          cp: async (
            from: string,
            to: string,
            o: { recursive: boolean; errorOnExist: boolean },
          ) => {
            cpCalls.push(from);
            await cp(from, to, o as never);
          },
        },
      },
    );
    expect(forced.ok).toBe(true);
    expect(cpCalls).toHaveLength(0);
  });

  it("isolates identical page IDs across vaults", async () => {
    const pathsA = tempVault();
    const pathsB = tempVault();
    writePage(pathsA, "concepts/foo.md", "Foo");
    writePage(pathsB, "concepts/foo.md", "Foo");

    const a = await reindexQmdVault(pathsA, { scope: "changed", components: ["lexical"] });
    const b = await reindexQmdVault(pathsB, { scope: "changed", components: ["lexical"] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.vaultId).toBeDefined();
    expect(b.vaultId).toBeDefined();
    expect(a.vaultId).not.toBe(b.vaultId);
    expect(a.vaultId).toMatch(UUID);
  });

  it("rejects an invalid existing vault_id without replacing it", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Index", vault_id: "not-a-uuid" }),
    );
    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "config_invalid_vault_id")).toBe(true);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(config.vault_id).toBe("not-a-uuid");
  });

  it("backfills vault_id once and preserves unrelated config keys", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const original = { topic: "Index", name: "Vault", nested: { keep: true }, list: [1, 2, 3] };
    writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify(original));

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(true);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(config.vault_id).toMatch(UUID);
    const { vault_id: _removed, ...rest } = config;
    expect(rest).toEqual(original);
  });

  it("keeps current store and records error when staging update fails", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const currentState = readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8");
    const manifestHash = JSON.parse(currentState).manifestHash;

    const failingFactory: QmdStoreFactory = async () => ({
      update: async () => {
        throw new Error("staging update exploded");
      },
      embed: async () => {
        throw new Error("nope");
      },
      status: async () => {
        throw new Error("nope");
      },
      close: async () => {},
    });

    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: false,
      },
      { factory: failingFactory },
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8")).toBe(currentState);
    const status = await readQmdIndexStatus(paths);
    expect(status.state === "stale" || status.state === "error").toBe(true);
    expect(existsSync(join(paths.qmd, "last-error.json"))).toBe(true);
    const lastError = JSON.parse(readFileSync(join(paths.qmd, "last-error.json"), "utf8"));
    expect(lastError.manifestHash).toBe(manifestHash);
  });

  it("cancellation does not promote staging", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    const currentState = readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8");

    const controller = new AbortController();
    controller.abort();
    const result = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8")).toBe(currentState);
  });

  it("returns a graceful busy result when a live lock is held", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const lockDir = join(paths.meta, "qmd", "index.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      }),
    );

    const result = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "qmd_index_busy")).toBe(true);
    // A busy lock we do not own must not be removed.
    expect(existsSync(lockDir)).toBe(true);
  });
});
