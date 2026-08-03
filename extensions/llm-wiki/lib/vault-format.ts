import { readFileSync, readdirSync, statSync } from "node:fs";
import { normalize } from "node:path";
import { posix } from "node:path";
import {
  type KnowledgeDiagnostic,
  type KnowledgeDocument,
  parseKnowledgeDocument,
  parseMarkdownFrontmatter,
} from "./knowledge-document.js";
import type { VaultPaths } from "./utils.js";

export type KnowledgeFormat = "legacy" | "okf-0.2";

export interface VaultFormatState {
  knowledgeFormat: KnowledgeFormat;
  diagnostics: KnowledgeDiagnostic[];
  blocking: boolean;
}

export interface DiscoveredDocument extends KnowledgeDocument {
  absolutePath: string;
}

export interface DiscoveryResult {
  documents: DiscoveredDocument[];
  diagnostics: KnowledgeDiagnostic[];
  blocking: boolean;
}

const RESERVED_NAMES = new Set(["index", "log"]);

export function compareCodePoint(a: string, b: string): number {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
}

function diag(
  severity: "warning" | "error",
  code: KnowledgeDiagnostic["code"],
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code, path, message };
}

function isReservedName(filename: string): boolean {
  const name = filename.toLowerCase();
  return name === "index.md" || name === "log.md";
}

function readConfigJson(
  dotWiki: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const path = posix.join(dotWiki, "config.json");
  try {
    const content = readFileSync(path, "utf8");
    const config = JSON.parse(content);
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { ok: false, error: "config.json is not an object" };
    }
    return { ok: true, config };
  } catch (e: unknown) {
    const err = e as Error;
    return { ok: false, error: err.message };
  }
}

export function inspectVaultFormat(paths: VaultPaths): VaultFormatState {
  const diagnostics: KnowledgeDiagnostic[] = [];
  let blocking = false;

  // Read config
  const configResult = readConfigJson(paths.dotWiki);
  if (!configResult.ok) {
    // If config.json is missing or malformed, treat as legacy
    return {
      knowledgeFormat: "legacy",
      diagnostics,
      blocking: false,
    };
  }

  const config = configResult.config;
  const rawFormat = config.knowledge_format;

  // Resolve format
  let format: KnowledgeFormat;
  if (rawFormat === undefined) {
    format = "legacy";
  } else if (rawFormat === "legacy" || rawFormat === "okf-0.2") {
    format = rawFormat;
  } else {
    return {
      knowledgeFormat: "legacy",
      diagnostics: [
        diag(
          "error",
          "config_invalid_knowledge_format",
          "config.json",
          `Invalid knowledge_format value: ${JSON.stringify(rawFormat)}`,
        ),
      ],
      blocking: true,
    };
  }

  // In OKF mode, check root index version
  // Missing root index is repairable; version mismatch blocks until explicitly handled
  if (format === "okf-0.2") {
    const rootIndexPath = posix.join(paths.wiki, "index.md");
    try {
      const content = readFileSync(rootIndexPath, "utf8");
      const frontmatter = parseMarkdownFrontmatter(content, "index.md");
      if (frontmatter.ok && frontmatter.mapping.okf_version !== undefined) {
        if (frontmatter.mapping.okf_version !== "0.2") {
          diagnostics.push(
            diag(
              "error",
              "okf_version_mismatch",
              "wiki/index.md",
              `Expected okf_version "0.2", got "${frontmatter.mapping.okf_version}"`,
            ),
          );
          blocking = true;
        }
      }
      // Missing root index is repairable
    } catch {
      // Missing root index is repairable
    }
  }

  // In legacy mode, check if root index declares unsupported version
  if (format === "legacy") {
    const rootIndexPath = posix.join(paths.wiki, "index.md");
    try {
      const content = readFileSync(rootIndexPath, "utf8");
      const frontmatter = parseMarkdownFrontmatter(content, "index.md");
      if (frontmatter.ok && frontmatter.mapping.okf_version !== undefined) {
        if (frontmatter.mapping.okf_version !== "0.2") {
          diagnostics.push(
            diag(
              "error",
              "okf_version_mismatch",
              "wiki/index.md",
              `Root index declares unsupported okf_version "${frontmatter.mapping.okf_version}"`,
            ),
          );
          blocking = true;
        }
      }
    } catch {
      // No root index in legacy mode - fine
    }
  }

  return {
    knowledgeFormat: format,
    diagnostics,
    blocking,
  };
}

function collectMarkdownFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = posix.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...collectMarkdownFiles(fullPath, baseDir));
      } else if (entry.toLowerCase().endsWith(".md") && !isReservedName(entry)) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return files;
}

export function discoverKnowledgeDocuments(paths: VaultPaths): DiscoveryResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const documents: DiscoveredDocument[] = [];
  let blocking = false;
  const seenIds = new Map<string, string>(); // normalized id -> original id

  const files = collectMarkdownFiles(paths.wiki, paths.wiki);

  for (const file of files) {
    const relativePath = posix.relative(paths.wiki, file);
    const normalizedPath = normalize(relativePath).replace(/\\/g, "/").normalize("NFC");
    const id = normalizedPath.replace(/\.md$/, "");

    // Check for reserved names (case-insensitive)
    const filename = posix.basename(normalizedPath, ".md").toLowerCase();
    if (RESERVED_NAMES.has(filename)) {
      continue;
    }

    // Check for identity collision
    const normalizedId = id.toLowerCase();
    const existing = seenIds.get(normalizedId);
    if (existing && existing !== id) {
      diagnostics.push(
        diag(
          "error",
          "concept_identity_collision",
          normalizedPath,
          `Identity collision with ${existing}: ${id}`,
        ),
      );
      blocking = true;
      continue;
    }
    seenIds.set(normalizedId, id);

    // Parse the document
    try {
      const content = readFileSync(file, "utf8");
      const result = parseKnowledgeDocument(content, normalizedPath);

      if (!result.ok) {
        diagnostics.push(...result.diagnostics);
        blocking = true;
        continue;
      }

      const doc = result.document;
      if (result.diagnostics.length > 0) {
        diagnostics.push(...result.diagnostics);
      }

      documents.push({
        ...doc,
        id,
        path: normalizedPath,
        absolutePath: file,
      });
    } catch (e: unknown) {
      const err = e as Error;
      diagnostics.push(
        diag(
          "error",
          "frontmatter_parse_error",
          normalizedPath,
          `Failed to read file: ${err.message}`,
        ),
      );
      blocking = true;
    }
  }

  // Sort documents by code point order
  documents.sort((a, b) => compareCodePoint(a.id, b.id));

  return {
    documents,
    diagnostics,
    blocking,
  };
}
