import type { Definition, Link, LinkReference, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import { compareCodePoint } from "./vault-format.js";

export interface ExtractedLink {
  target: string;
  offset: number;
}

export interface KnowledgeLinks {
  markdown: ExtractedLink[];
  wikilinks: ExtractedLink[];
}

export interface ResolvedBacklinks {
  targets: string[];
  diagnostics: KnowledgeDiagnostic[];
}

function diag(
  severity: "warning" | "error",
  code: KnowledgeDiagnostic["code"],
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code, path, message };
}

export function extractKnowledgeLinks(body: string): KnowledgeLinks {
  const markdown: ExtractedLink[] = [];
  const wikilinks: ExtractedLink[] = [];

  // Extract legacy wikilinks
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    wikilinks.push({ target: match[1].trim(), offset: match.index ?? 0 });
  }

  // Parse with CommonMark AST
  let tree: Root;
  try {
    tree = fromMarkdown(body);
  } catch {
    return { markdown, wikilinks };
  }

  // Build definition map (case-insensitive)
  const defs = new Map<string, Definition>();
  function collectDefs(node: Nodes) {
    if (node.type === "definition") {
      defs.set(node.identifier.toLowerCase(), node);
    }
    if ("children" in node && Array.isArray((node as { children?: Nodes[] }).children)) {
      for (const child of (node as { children: Nodes[] }).children) {
        collectDefs(child);
      }
    }
  }
  collectDefs(tree);

  // Track used definitions
  const usedDefs = new Set<string>();

  // Visit nodes for links
  function visit(node: Nodes) {
    // Skip code spans, fenced/indented code blocks, and raw HTML
    if (node.type === "inlineCode" || node.type === "code" || node.type === "html") return;

    if (node.type === "link") {
      const link = node as Link;
      // Skip autolinks (source starts with <)
      if (link.url && link.position) {
        const source = body.slice(link.position.start.offset, link.position.end.offset);
        if (!source.startsWith("<")) {
          markdown.push({ target: link.url, offset: link.position.start.offset ?? 0 });
        }
      }
    }

    if (node.type === "linkReference") {
      const ref = node as LinkReference;
      const ident = (ref.identifier ?? "").toLowerCase();
      const def = defs.get(ident);
      if (def && !usedDefs.has(ident)) {
        usedDefs.add(ident);
        if (ref.position) {
          markdown.push({ target: def.url, offset: ref.position.start.offset ?? 0 });
        }
      }
    }

    // Recurse into children
    if ("children" in node && Array.isArray((node as { children?: Nodes[] }).children)) {
      for (const child of (node as { children: Nodes[] }).children) {
        visit(child);
      }
    }
  }

  visit(tree);

  return { markdown, wikilinks };
}

export function extractLegacyWikilinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    links.push({ target: match[1].trim(), offset: match.index ?? 0 });
  }
  return links;
}

function resolveMarkdownTarget(
  target: string,
  sourceId: string,
): { kind: "concept"; id: string } | { kind: "escape" } | { kind: "external" } | { kind: "empty" } {
  // Strip query and fragment (earliest delimiter)
  const qIndex = target.indexOf("?");
  const fIndex = target.indexOf("#");
  let clean = target;
  let cut = -1;
  if (qIndex !== -1 && (fIndex === -1 || qIndex < fIndex)) cut = qIndex;
  else if (fIndex !== -1) cut = fIndex;
  if (cut !== -1) clean = target.slice(0, cut);

  // Ignore empty fragment-only targets
  if (!clean || clean === "#") return { kind: "empty" };

  // Ignore external URI schemes
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return { kind: "external" };

  // Percent-decode each segment once
  const segments = clean.split("/");
  const decoded = segments.map((s) => decodeURIComponent(s));

  // Convert decoded backslashes to /
  const normalized = decoded.map((s) => s.replace(/\\/g, "/")).join("/");

  const sourceDir = sourceId.replace(/[^\/]*$/, ""); // directory of source
  const parts = normalized.split("/");
  const isRootRelative = normalized.startsWith("/");

  if (isRootRelative) {
    // Root-relative: resolve with explicit stack
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "") continue;
      if (part === ".") continue;
      if (part === "..") {
        if (stack.length === 0) return { kind: "escape" };
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    const resolved = stack.join("/");
    if (resolved.endsWith(".md")) {
      return { kind: "concept", id: resolved.slice(0, -3) };
    }
    return { kind: "concept", id: resolved };
  }

  // For file-relative paths, resolve against source directory
  const baseParts = sourceDir.split("/").filter(Boolean);
  const allParts = [...baseParts];

  for (const part of parts) {
    if (part === "" || part === ".") {
    } else if (part === "..") {
      if (allParts.length === 0) {
        return { kind: "escape" };
      }
      allParts.pop();
    } else {
      allParts.push(part);
    }
  }

  const resolved = allParts.join("/");

  // Require .md suffix for Markdown links
  if (resolved.endsWith(".md")) {
    return { kind: "concept", id: resolved.slice(0, -3) };
  }

  return { kind: "empty" };
}

function resolveWikilinkTarget(
  target: string,
): { kind: "concept"; id: string } | { kind: "empty" } {
  // Wikilinks are already bundle-relative concept IDs
  const cleaned = target.trim();
  if (!cleaned) return { kind: "empty" };
  return { kind: "concept", id: cleaned };
}

export function buildResolvedBacklinks(
  sourceId: string,
  body: string,
  knownIds: Set<string>,
): ResolvedBacklinks {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const targets = new Set<string>();
  const allLinks = extractKnowledgeLinks(body);

  // Process Markdown links
  for (const link of allLinks.markdown) {
    const resolved = resolveMarkdownTarget(link.target, sourceId);
    if (resolved.kind === "escape") {
      diagnostics.push(
        diag(
          "warning",
          "link_path_escape",
          `${sourceId}.md`,
          `Link escapes bundle root: ${link.target}`,
        ),
      );
    } else if (resolved.kind === "concept") {
      const normalizedId = resolved.id.normalize("NFC");
      if (knownIds.has(normalizedId)) {
        targets.add(normalizedId);
      } else {
        diagnostics.push(
          diag("warning", "link_unresolved", `${sourceId}.md`, `Unresolved link: ${normalizedId}`),
        );
      }
    }
    // external and empty are silently ignored
  }

  // Process wikilinks
  for (const link of allLinks.wikilinks) {
    const resolved = resolveWikilinkTarget(link.target);
    if (resolved.kind === "concept") {
      const normalizedId = resolved.id.normalize("NFC");
      if (knownIds.has(normalizedId)) {
        targets.add(normalizedId);
      } else {
        diagnostics.push(
          diag(
            "warning",
            "link_unresolved",
            `${sourceId}.md`,
            `Unresolved wikilink: ${normalizedId}`,
          ),
        );
      }
    }
  }

  // Sort and deduplicate
  const sorted = [...targets].sort(compareCodePoint);

  return { targets: sorted, diagnostics };
}
