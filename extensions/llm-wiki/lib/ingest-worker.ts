import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  type KnowledgeDiagnostic,
  type KnowledgeDocument,
  createKnowledgeDocument,
  parseKnowledgeDocument,
  patchKnowledgeDocument,
  serializeKnowledgeDocument,
  writeKnowledgeDocumentFile,
} from "./knowledge-document.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import { runSubAgent } from "./subagent.js";
import { type VaultPaths, fmtDate, slugify } from "./utils.js";
import { VaultWriteError, assertWritableVault } from "./vault-format.js";

/**
 * Background ingest synthesis (issue #65, part of epic #63).
 *
 * Moves the work the main agent used to do during `wiki_ingest` — reading a
 * captured source's extracted text and writing the source page + entity /
 * concept pages — onto a background sub-agent, so capturing/ingesting never
 * stalls the user.
 *
 * Design: the sub-agent produces ONE structured `commit_synthesis` call; the
 * persistence (`commitSynthesis`) is fully deterministic and unit-testable
 * without an LLM. This mirrors pi-observational-memory's single-structured-tool
 * pattern and keeps the file-writing logic verifiable in isolation.
 */

// ── structured synthesis schema ───────────────────────────
export const CommitSynthesisSchema = Type.Object({
  summary: Type.String({
    minLength: 1,
    description: "2-3 paragraph summary of the source's key content.",
  }),
  key_takeaways: Type.Array(Type.String({ minLength: 1 }), {
    description: "The most important points, one per item.",
  }),
  entities: Type.Array(
    Type.Object({
      title: Type.String({
        minLength: 1,
        description: "Entity name (person, org, tool, product).",
      }),
      description: Type.String({ description: "One-line description of the entity." }),
    }),
    { description: "Named entities mentioned in the source." },
  ),
  concepts: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, description: "Concept name (idea, pattern, framework)." }),
      definition: Type.String({ description: "One-line definition of the concept." }),
    }),
    { description: "Concepts discussed in the source." },
  ),
  quotes: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1 }),
        attribution: Type.Optional(Type.String()),
      }),
      { description: "Notable verbatim quotes." },
    ),
  ),
  contradictions: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Tensions/contradictions with existing wiki content, if any.",
    }),
  ),
});

export type SynthesisData = Static<typeof CommitSynthesisSchema>;

export interface CommitResult {
  sourceId: string;
  sourcePage: string;
  entitiesCreated: string[];
  conceptsCreated: string[];
  entitiesLinked: string[];
  conceptsLinked: string[];
  contradictions: number;
}

export type CommitSynthesisOutcome =
  | ({ ok: true } & CommitResult)
  | { ok: false; sourceId: string; diagnostics: KnowledgeDiagnostic[] };

// ── deterministic persistence (no LLM) ────────────────────

function buildEntityPageBody(title: string, description: string, sourceId: string): string {
  const desc = description.trim() || "One-line description.";
  return `# ${title}

${desc}

## Overview

[Key facts]

## Links

- [${sourceId}](/sources/${sourceId}.md)`;
}

function buildConceptPageBody(title: string, definition: string, sourceId: string): string {
  const def = definition.trim() || "One-line definition.";
  return `# ${title}

${def}

## Definition

[Clear explanation]

## Links

- [${sourceId}](/sources/${sourceId}.md)`;
}

/** Rebuild the source page body from synthesis data, marking it ingested. */
export function buildIngestedSourcePageBody(
  manifest: Record<string, unknown>,
  data: SynthesisData,
  _date: string,
): string {
  const id = String(manifest.id);
  const title = String(manifest.title || id);
  const url = manifest.url ? `\n> _Original: [${manifest.url}](${manifest.url})_` : "";

  const takeaways =
    data.key_takeaways.length > 0
      ? data.key_takeaways.map((t) => `- ${t.trim()}`).join("\n")
      : "- [None recorded]";
  const entities =
    data.entities.length > 0
      ? data.entities.map((e) => `- [${e.title}](/entities/${slugify(e.title)}.md)`).join("\n")
      : "- [None]";
  const concepts =
    data.concepts.length > 0
      ? data.concepts.map((c) => `- [${c.title}](/concepts/${slugify(c.title)}.md)`).join("\n")
      : "- [None]";
  const quotes =
    data.quotes && data.quotes.length > 0
      ? data.quotes
          .map((q) => `> ${q.text.trim()}${q.attribution ? ` — ${q.attribution}` : ""}`)
          .join("\n\n")
      : "> [None recorded]";
  const contradictions =
    data.contradictions && data.contradictions.length > 0
      ? `\n## Contradictions\n\n${data.contradictions.map((c) => `⚠️ **Contradiction**: ${c.trim()}`).join("\n")}\n`
      : "";

  return `# ${title}${url}

## Summary

${data.summary.trim()}

## Key Takeaways

${takeaways}

## Entities Mentioned

${entities}

## Concepts Mentioned

${concepts}

## Notable Quotes

${quotes}
${contradictions}## Source Packet

- **ID:** \`sources/${id}\`
- **Extracted:** [raw/sources/${id}/extracted.md](../raw/sources/${id}/extracted.md)
- **Manifest:** [raw/sources/${id}/manifest.json](../raw/sources/${id}/manifest.json)
`;
}

/** Rebuild the source page from synthesis data, marking it ingested. */
export function buildIngestedSourcePage(
  manifest: Record<string, unknown>,
  data: SynthesisData,
  date: string,
): string {
  const id = String(manifest.id);
  const title = String(manifest.title || id);
  const format = String(manifest.format || "unknown");
  const captured = String(manifest.captured || date);
  const body = buildIngestedSourcePageBody(manifest, data, date);
  const doc = createKnowledgeDocument(
    `sources/${id}.md`,
    {
      type: "source",
      title,
      format,
      source_id: id,
      raw_path: `raw/sources/${id}/extracted.md`,
      captured,
      status: "ingested",
      updated: date,
    },
    body,
  );
  return serializeKnowledgeDocument(doc);
}

/**
 * Persist a synthesis deterministically: rewrite the source page (status →
 * ingested), create missing entity/concept pages (existing pages are linked,
 * never overwritten), and log the event. Pure file I/O — no LLM, no network.
 */
export function commitSynthesis(
  paths: VaultPaths,
  sourceId: string,
  manifest: Record<string, unknown>,
  data: SynthesisData,
  date: string = fmtDate(),
): CommitSynthesisOutcome {
  const result: CommitResult = {
    sourceId,
    sourcePage: join(paths.wiki, "sources", `${sourceId}.md`),
    entitiesCreated: [],
    conceptsCreated: [],
    entitiesLinked: [],
    conceptsLinked: [],
    contradictions: data.contradictions?.length ?? 0,
  };

  try {
    assertWritableVault(paths);
  } catch (error: unknown) {
    if (error instanceof VaultWriteError) {
      return { ok: false, sourceId, diagnostics: error.diagnostics };
    }
    throw error;
  }

  // Source page: if existing skeleton is malformed, fail before creating entity/concept pages.
  if (existsSync(result.sourcePage)) {
    const existingContent = readFileSync(result.sourcePage, "utf-8");
    const parseResult = parseKnowledgeDocument(existingContent, `sources/${sourceId}.md`);
    if (!parseResult.ok) {
      return { ok: false, sourceId, diagnostics: parseResult.diagnostics };
    }
  }

  // Patch existing documents so unknown fields, legacy sources, and titles survive.
  let sourceDocument: KnowledgeDocument;
  if (existsSync(result.sourcePage)) {
    const parsed = parseKnowledgeDocument(
      readFileSync(result.sourcePage, "utf8"),
      `sources/${sourceId}.md`,
    );
    if (!parsed.ok) return { ok: false, sourceId, diagnostics: parsed.diagnostics };
    sourceDocument = patchKnowledgeDocument(parsed.document, {
      fields: { status: "ingested", updated: date },
      body: buildIngestedSourcePageBody(manifest, data, date),
    });
  } else {
    sourceDocument = createKnowledgeDocument(
      `sources/${sourceId}.md`,
      {
        type: "source",
        title: String(manifest.title || sourceId),
        format: String(manifest.format || "unknown"),
        source_id: sourceId,
        raw_path: `raw/sources/${sourceId}/extracted.md`,
        captured: String(manifest.captured || date),
        status: "ingested",
        updated: date,
      },
      buildIngestedSourcePageBody(manifest, data, date),
    );
  }
  mkdirSync(join(paths.wiki, "sources"), { recursive: true });
  writeKnowledgeDocumentFile(result.sourcePage, sourceDocument);

  // Entity pages — create if absent, link if present.
  mkdirSync(join(paths.wiki, "entities"), { recursive: true });
  for (const e of data.entities) {
    const slug = slugify(e.title);
    if (!slug) continue;
    const pagePath = join(paths.wiki, "entities", `${slug}.md`);
    if (existsSync(pagePath)) {
      result.entitiesLinked.push(slug);
    } else {
      const entityDoc = createKnowledgeDocument(
        `entities/${slug}.md`,
        {
          type: "entity",
          title: e.title,
          description: e.description.trim() || "One-line description.",
          created: date,
          updated: date,
        },
        buildEntityPageBody(e.title, e.description, sourceId),
        [{ id: sourceId, resource: `/sources/${sourceId}.md` }],
      );
      writeKnowledgeDocumentFile(pagePath, entityDoc);
      result.entitiesCreated.push(slug);
    }
  }

  // Concept pages — create if absent, link if present.
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  for (const c of data.concepts) {
    const slug = slugify(c.title);
    if (!slug) continue;
    const pagePath = join(paths.wiki, "concepts", `${slug}.md`);
    if (existsSync(pagePath)) {
      result.conceptsLinked.push(slug);
    } else {
      const conceptDoc = createKnowledgeDocument(
        `concepts/${slug}.md`,
        {
          type: "concept",
          title: c.title,
          description: c.definition.trim() || "One-line definition.",
          created: date,
          updated: date,
        },
        buildConceptPageBody(c.title, c.definition, sourceId),
        [{ id: sourceId, resource: `/sources/${sourceId}.md` }],
      );
      writeKnowledgeDocumentFile(pagePath, conceptDoc);
      result.conceptsCreated.push(slug);
    }
  }

  appendEvent(paths, {
    kind: "ingest",
    source_id: sourceId,
    entities_created: result.entitiesCreated.length,
    concepts_created: result.conceptsCreated.length,
    contradictions: result.contradictions,
    background: true,
  });

  return { ok: true, ...result };
}

// ── sub-agent synthesis (LLM) ─────────────────────────────

export const INGEST_SYSTEM = `You are the LLM Wiki ingestion synthesizer. You turn a single captured source's extracted text into structured wiki knowledge.

Read the source content, then call \`commit_synthesis\` EXACTLY ONCE with:
- summary: a faithful 2-3 paragraph summary (no fabrication).
- key_takeaways: the most important points.
- entities: named people, organizations, tools, products actually mentioned.
- concepts: ideas, patterns, frameworks actually discussed.
- quotes: notable verbatim quotes (optional).
- contradictions: tensions with general knowledge or noted in the text (optional).

Rules:
- Never fabricate. Only include entities/concepts present in the source.
- Keep descriptions to one line.
- After calling commit_synthesis once, reply with a one-line confirmation and stop.`;

export interface RunIngestSynthesisArgs {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  paths: VaultPaths;
  sourceId: string;
  manifest: Record<string, unknown>;
  extracted: string;
  /** Cap on extracted chars fed to the model (avoid huge prompts). Default 24k. */
  maxChars?: number;
  signal?: AbortSignal;
}

/**
 * Run the synthesis sub-agent for a single source, then commit + rebuild
 * metadata. Returns the commit result, or undefined if the model produced no
 * synthesis.
 */
export async function runIngestSynthesis(
  args: RunIngestSynthesisArgs,
): Promise<CommitResult | undefined> {
  const { model, apiKey, headers, paths, sourceId, manifest, extracted, maxChars, signal } = args;
  const content = extracted.slice(0, maxChars ?? 24_000);
  if (!content.trim()) return undefined;

  let committed: CommitResult | undefined;

  const commitTool: AgentTool<typeof CommitSynthesisSchema> = {
    name: "commit_synthesis",
    label: "Commit synthesis",
    description:
      "Persist the structured synthesis of this source into wiki pages. Call exactly once.",
    parameters: CommitSynthesisSchema,
    execute: async (_id, params) => {
      const outcome = commitSynthesis(paths, sourceId, manifest, params);
      if (!outcome.ok) {
        return {
          content: [{ type: "text", text: `Failed: ${outcome.diagnostics[0].message}` }],
          details: { sourceId },
          isError: true,
        };
      }
      committed = outcome;
      const ack = `Committed: source page + ${committed.entitiesCreated.length} new entit${
        committed.entitiesCreated.length === 1 ? "y" : "ies"
      }, ${committed.conceptsCreated.length} new concept${
        committed.conceptsCreated.length === 1 ? "" : "s"
      }. Reply with a one-line confirmation and stop.`;
      return { content: [{ type: "text", text: ack }], details: { sourceId } };
    },
  };

  const title = String(manifest.title || sourceId);
  const userPrompt = `Synthesize this captured source into wiki knowledge by calling commit_synthesis once.\n\nSOURCE: ${title} (${sourceId})\n\nEXTRACTED CONTENT:\n${content}`;

  await runSubAgent({
    model,
    apiKey,
    headers,
    systemPrompt: INGEST_SYSTEM,
    userPrompt,
    tools: [commitTool as AgentTool],
    signal,
  });

  if (committed) rebuildMetadataLight(paths);
  return committed;
}
