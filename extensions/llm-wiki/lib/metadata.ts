import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type VaultPaths,
  extractWikilinks,
  findWikiPages,
  fmtDate,
  parseFrontmatter,
  readJson,
  writeJson,
} from "./utils.js";
import type { KnowledgeDocument, KnowledgeDiagnostic } from "./knowledge-document.js";
import { compareCodePoint } from "./vault-format.js";

/**
 * Metadata generation for the LLM Wiki.
 *
 * Rebuilds registry.json, backlinks.json, index.md, log.md, and lint-report.md
 * deterministically from the current state of raw/ and wiki/.
 */

export interface RegistryEntry {
  type:
    | "source"
    | "entity"
    | "concept"
    | "synthesis"
    | "analysis"
    | "requirement"
    | "trajectory"
    | "skill"
    | "case";
  title: string;
  created: string;
  updated: string;
  [key: string]: unknown;
}

export interface Registry {
  version: string;
  last_updated: string;
  pages: Record<string, RegistryEntry>;
}

export interface Backlinks {
  [pageId: string]: string[];
}

export interface WikiEvent {
  timestamp: string;
  kind: string;
  [key: string]: unknown;
}

/** Rebuild the complete metadata layer. */
export function rebuildMetadata(paths: VaultPaths): void {
  mkdirSync(paths.meta, { recursive: true });

  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);

  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}

/** Build registry from wiki/ and raw/ state. */
export function buildRegistry(paths: VaultPaths): Registry {
  const pages: Record<string, RegistryEntry> = {};

  // Scan wiki pages
  for (const page of findWikiPages(paths.wiki)) {
    const { frontmatter } = parseFrontmatter(page.content);
    const type = String(frontmatter.type || "page") as RegistryEntry["type"];
    const title = String(frontmatter.title || page.relative.split("/").pop() || "Untitled");

    pages[page.relative] = {
      type,
      title,
      created: String(frontmatter.created || fmtDate()),
      updated: String(frontmatter.updated || frontmatter.created || fmtDate()),
      ...frontmatter,
    };
  }

  // Scan raw source packets
  if (existsSync(paths.rawSources)) {
    for (const entry of readdirSync(paths.rawSources)) {
      const manifestPath = join(paths.rawSources, entry, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = readJson<Record<string, unknown>>(manifestPath, {});
      const id = String(manifest.id || entry);
      const sourcePage = `sources/${id}`;

      if (!pages[sourcePage]) {
        pages[sourcePage] = {
          type: "source",
          title: String(manifest.title || id),
          created: String(manifest.captured || fmtDate()),
          updated: String(manifest.captured || fmtDate()),
          ...manifest,
        };
      }
    }
  }

  // Scan raw trajectory packets (agent working-memory). These are catalogued
  // under the `trajectories/` namespace so distillation and recall can find
  // them even before a canonical case/skill page has been written.
  if (existsSync(paths.rawTrajectories)) {
    for (const entry of readdirSync(paths.rawTrajectories)) {
      const manifestPath = join(paths.rawTrajectories, entry, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = readJson<Record<string, unknown>>(manifestPath, {});
      const id = String(manifest.id || entry);
      const trajectoryPage = `trajectories/${id}`;

      if (!pages[trajectoryPage]) {
        pages[trajectoryPage] = {
          type: "trajectory",
          title: String(manifest.title || id),
          created: String(manifest.captured || fmtDate()),
          updated: String(manifest.captured || fmtDate()),
          ...manifest,
        };
      }
    }
  }

  return {
    version: "1.0",
    last_updated: new Date().toISOString(),
    pages,
  };
}

/** Build backlinks map from all wiki pages. */
export function buildBacklinks(paths: VaultPaths, registry: Registry): Backlinks {
  const inbound: Backlinks = {};

  // Initialize all pages with empty arrays
  for (const id of Object.keys(registry.pages)) {
    inbound[id] = [];
  }

  // Count inbound links
  for (const page of findWikiPages(paths.wiki)) {
    const links = extractWikilinks(page.content);
    for (const link of links) {
      if (inbound[link] && !inbound[link].includes(page.relative)) {
        inbound[link].push(page.relative);
      }
    }
  }

  return inbound;
}

/** Build index markdown from registry. */
export function buildIndexMarkdown(registry: Registry): string {
  const byType: Record<string, Array<{ id: string; entry: RegistryEntry }>> = {};

  for (const [id, entry] of Object.entries(registry.pages)) {
    const t = entry.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push({ id, entry });
  }

  const sections: string[] = [];
  sections.push(
    "# Wiki Index\n\n> Auto-generated from meta/registry.json. Do not edit manually.\n",
  );

  for (const [type, items] of Object.entries(byType).sort()) {
    const label = `${type.charAt(0).toUpperCase() + type.slice(1)}s`;
    sections.push(`## ${label}\n`);
    for (const { id, entry } of items.sort((a, b) => a.id.localeCompare(b.id))) {
      sections.push(`- [[${id}]] — ${entry.title} *(created: ${entry.created})*`);
    }
    sections.push("");
  }

  sections.push(
    `---\n*Last updated: ${registry.last_updated}* | *Total pages: ${Object.keys(registry.pages).length}*`,
  );
  return `${sections.join("\n")}\n`;
}

/** Build log markdown from events.jsonl. */
export function buildLogMarkdown(paths: VaultPaths): string {
  const eventsPath = join(paths.meta, "events.jsonl");
  const events: WikiEvent[] = [];

  if (existsSync(eventsPath)) {
    const raw = readFileSync(eventsPath, "utf-8").trim();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as WikiEvent);
      } catch {
        // skip malformed
      }
    }
  }

  const lines: string[] = [];
  lines.push("# Activity Log\n\n> Auto-generated from meta/events.jsonl. Do not edit manually.\n");

  for (const ev of events) {
    const ts = ev.timestamp || "unknown";
    const kind = ev.kind || "event";
    const details = Object.entries(ev)
      .filter(([k]) => k !== "timestamp" && k !== "kind")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");

    lines.push(`## [${ts}] ${kind}`);
    if (details) lines.push(`- ${details}`);
    lines.push("");
  }

  if (events.length === 0) {
    lines.push("_No events recorded yet._\n");
  }

  return `${lines.join("\n")}\n`;
}

/** Append an event to events.jsonl. */
export function appendEvent(paths: VaultPaths, event: Omit<WikiEvent, "timestamp">): void {
  mkdirSync(paths.meta, { recursive: true });
  const eventsPath = join(paths.meta, "events.jsonl");
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  writeFileSync(eventsPath, `${line}\n`, { flag: "a", encoding: "utf-8" });
}

/** Quick lightweight metadata rebuild (backlinks + index + log only). */
export function rebuildMetadataLight(paths: VaultPaths): void {
  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);
  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}


// ===== OKF Projection Renderers =====

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function encodeRelativePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function compactDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact || undefined;
}

export function buildDirectoryIndexes(
  documents: KnowledgeDocument[],
  config: { name?: unknown },
): Map<string, string> {
  const indexes = new Map<string, string>();

  // Build directory tree from concept documents only
  const directories = new Map<string, { dirs: Set<string>; concepts: KnowledgeDocument[] }>();

  for (const doc of documents) {
    const parts = doc.id.split("/");
    
    // Walk the path, tracking parent-child directory relationships
    for (let i = 0; i < parts.length; i++) {
      const parentPath = i === 0 ? "" : parts.slice(0, i).join("/");
      if (!directories.has(parentPath)) {
        directories.set(parentPath, { dirs: new Set(), concepts: [] });
      }
      
      if (i === parts.length - 1) {
        // Last part is the concept file
        directories.get(parentPath)!.concepts.push(doc);
      } else {
        // This is a subdirectory
        directories.get(parentPath)!.dirs.add(parts[i]);
      }
    }
  }

  // Always emit root index
  const vaultName = (typeof config.name === "string" && config.name.trim()) ? config.name.trim() : "Wiki";
  if (!directories.has("")) {
    directories.set("", { dirs: new Set(), concepts: [] });
  }

  // Render each index
  for (const [dirPath, { dirs, concepts }] of directories) {
    const indexPath = dirPath ? `${dirPath}/index.md` : "index.md";
    const lines: string[] = [];

    if (dirPath === "") {
      lines.push('---');
      lines.push('okf_version: "0.2"');
      lines.push('---');
      lines.push("");
      lines.push(`# ${escapeLabel(vaultName)}`);
    } else {
      const dirName = dirPath.split("/").pop()!;
      lines.push(`# ${escapeLabel(dirName)}`);
    }

    // List directories first
    if (dirs.size > 0) {
      lines.push("");
      lines.push("## Directories");
      lines.push("");
      for (const subDir of [...dirs].sort(compareCodePoint)) {
        const encoded = encodeRelativePath(subDir) + "/";
        lines.push(`- [${escapeLabel(subDir)}/](${encoded})`);
      }
    }

    // List concepts
    if (concepts.length > 0) {
      lines.push("");
      lines.push("## Concepts");
      lines.push("");
      const sorted = [...concepts].sort((a, b) => {
        const aRel = dirPath ? a.id.slice(dirPath.length + 1) : a.id;
        const bRel = dirPath ? b.id.slice(dirPath.length + 1) : b.id;
        return compareCodePoint(aRel, bRel);
      });
      for (const doc of sorted) {
        const relId = dirPath ? doc.id.slice(dirPath.length + 1) : doc.id;
        const title = (typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim())
          ? doc.frontmatter.title.trim()
          : relId.split("/").pop()!;
        const desc = compactDescription(doc.frontmatter.description);
        const encoded = encodeRelativePath(relId + ".md");
        const descPart = desc ? ` — ${desc}` : "";
        lines.push(`- [${escapeLabel(title)}](${encoded})${descPart}`);
      }
    }

    indexes.set(indexPath, lines.join("\n") + "\n");
  }

  return indexes;
}

export interface OkfLogResult {
  markdown: string;
  diagnostics: KnowledgeDiagnostic[];
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodePoint(a, b))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function okfDiag(
  severity: "warning" | "error",
  code: KnowledgeDiagnostic["code"],
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code, path, message };
}

export function buildOkfLog(eventsJsonl: string, path = "meta/events.jsonl"): OkfLogResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const events: Array<{
    seq: number;
    timestamp: string;
    date: string;
    kind: string;
    details: string;
  }> = [];

  const lines = eventsJsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(okfDiag("warning", "event_invalid_json", path, `Invalid JSON at line ${i + 1}`));
      continue;
    }

    const rawTs = parsed.timestamp;
    if (typeof rawTs !== "string" || isNaN(Date.parse(rawTs))) {
      diagnostics.push(okfDiag("warning", "event_invalid_timestamp", path, `Invalid timestamp at line ${i + 1}`));
      continue;
    }

    const rawKind = parsed.kind;
    if (typeof rawKind !== "string" || !rawKind.trim()) {
      diagnostics.push(okfDiag("warning", "event_missing_kind", path, `Missing kind at line ${i + 1}`));
      continue;
    }

    const ts = new Date(rawTs);
    const date = ts.toISOString().split("T")[0];
    const kind = rawKind.trim();

    const detailEntries: [string, unknown][] = Object.entries(parsed)
      .filter(([k]) => k !== "timestamp" && k !== "kind");
    const details = detailEntries.length > 0
      ? JSON.stringify(canonicalJsonValue(Object.fromEntries(detailEntries)))
      : "";

    events.push({ seq: i, timestamp: rawTs, date, kind, details });
  }

  // Group by date
  const byDate = new Map<string, typeof events>();
  for (const ev of events) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date)!.push(ev);
  }

  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  const outLines: string[] = ["# Wiki Update Log"];

  for (const date of sortedDates) {
    const dayEvents = byDate.get(date)!;
    dayEvents.sort((a, b) => {
      const tsCmp = b.timestamp.localeCompare(a.timestamp);
      if (tsCmp !== 0) return tsCmp;
      return b.seq - a.seq;
    });

    outLines.push("");
    outLines.push(`## ${date}`);
    outLines.push("");

    for (const ev of dayEvents) {
      const escapedKind = ev.kind
        .replace(/\\/g, "\\\\")
        .replace(/\*/g, "\\*")
        .replace(/_/g, "\\_")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\s+/g, " ");

      if (ev.details) {
        outLines.push(`- **${escapedKind}**: ${ev.details}`);
      } else {
        outLines.push(`- **${escapedKind}**`);
      }
    }
  }

  return {
    markdown: outLines.join("\n") + "\n",
    diagnostics,
  };
}
