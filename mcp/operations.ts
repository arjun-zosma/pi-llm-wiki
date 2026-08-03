/**
 * MCP operation adapters over shared wiki services.
 *
 * Each operation is a thin, testable wrapper around the same services
 * used by Pi tools. No operation parses YAML, scans files, scores
 * registry entries, or builds page strings itself.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import type { VaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { inspectVaultFormat } from "../extensions/llm-wiki/lib/vault-format.js";
import { inspectWritableVault } from "../extensions/llm-wiki/lib/vault-format.js";
import { searchRegistry } from "../extensions/llm-wiki/lib/wiki-service.js";

/** Shared recall operation: calls searchWiki and appends vault diagnostics. */
export async function recallOperation(
  paths: VaultPaths,
  query: string,
  maxResults = 5,
): Promise<{
  results: Array<{ id: string; title: string; type: string; preview?: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const results = searchWiki(paths, query, maxResults);
  const vaultState = inspectVaultFormat(paths);
  return {
    results,
    diagnostics: vaultState.diagnostics.map((d) => ({ code: d.code, message: d.message })),
  };
}

/** Shared search operation: delegates directly to wiki-service. */
export async function searchOperation(
  paths: VaultPaths,
  query: string,
  type?: string,
): Promise<{
  matches: Array<{ id: string; title: string; type: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const result = searchRegistry(paths, query, type);
  return {
    matches: result.matches,
    diagnostics: result.diagnostics.map((d) => ({ code: d.code, message: d.message })),
  };
}

/** Shared status operation: delegates directly to wiki-service. */
export async function statusOperation(paths: VaultPaths): Promise<{
  knowledgeFormat: string;
  totalPages: number;
  byType: Record<string, number>;
  blockingDiagnostics: Array<{ code: string; message: string }>;
  lastUpdated: string;
}> {
  const { getWikiStatus } = await import("../extensions/llm-wiki/lib/wiki-service.js");
  const status = getWikiStatus(paths);
  return {
    knowledgeFormat: status.knowledgeFormat,
    totalPages: status.totalPages,
    byType: status.byType,
    blockingDiagnostics: status.blockingDiagnostics.map((d) => ({
      code: d.code,
      message: d.message,
    })),
    lastUpdated: status.lastUpdated,
  };
}

/** Shared retro operation: validates vault then delegates to saveInsight. */
export async function retroOperation(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
): Promise<
  | { ok: true; slug: string; sourcePagePath: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }
  const result = saveInsight(paths, slug, title, body, category, { rebuild: false });
  return { ok: true, slug: result.slug, sourcePagePath: result.sourcePagePath };
}

/** Shared capture operation: validates vault then delegates to capture functions. */
export async function captureSourceOperation(
  paths: VaultPaths,
  input: { text?: string; url?: string; filePath?: string; title?: string },
  execApi: Pick<ExtensionAPI, "exec">,
): Promise<
  | { ok: true; sourceId: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }

  if (input.url) {
    const result = await captureUrl(execApi, paths, input.url);
    return { ok: true, sourceId: result.sourceId };
  }
  if (input.filePath) {
    const result = await captureFile(execApi, paths, input.filePath);
    return { ok: true, sourceId: result.sourceId };
  }
  if (input.text) {
    const result = captureText(paths, input.text, input.title);
    return { ok: true, sourceId: result.sourceId };
  }
  return {
    ok: false,
    diagnostics: [
      { code: "event_missing_kind" as const, message: "Provide one of: text, url, or filePath" },
    ],
  };
}
