import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTMATTER_MAX_BYTES,
  createKnowledgeDocument,
  parseKnowledgeDocument,
  patchKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";

function parsed(content: string, path = "concepts/test.md") {
  const result = parseKnowledgeDocument(content, path);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error("expected parsed document");
  return result.document;
}

describe("KnowledgeDocument", () => {
  it("parses nested OKF values, timestamps as strings, and unknown mappings", () => {
    const input = readFileSync(join(import.meta.dirname, "fixtures/okf/documents/nested.md"), "utf8");
    const doc = parsed(input, "analyses/revenue-total.md");
    expect(doc.id).toBe("analyses/revenue-total");
    expect(doc.frontmatter.generated).toEqual({
      by: "pi-llm-wiki/model",
      at: "2026-08-02T10:00:00Z",
    });
    expect(typeof (doc.frontmatter.generated as Record<string, unknown>).at).toBe("string");
    expect(doc.extensions.producer_data).toEqual({
      nested: { enabled: true, weights: [1, 2, 3] },
    });
    expect(doc.sources.kind).toBe("canonical");
  });

  it("round-trips unknown values and exact body separator rules", () => {
    const doc = parsed("---\ntype: concept\nunknown: {empty: [], map: {}}\n---\n\n\nFirst\n");
    const output = serializeKnowledgeDocument(doc);
    expect(output).toBe("---\ntype: concept\nunknown:\n  empty: []\n  map: {}\n---\n\n\nFirst\n");
    const again = parsed(output);
    expect(again.extensions.unknown).toEqual({ empty: [], map: {} });
    expect(again.body).toBe("\nFirst\n");
  });

  it("emits no separator blank line for an empty body", () => {
    const doc = createKnowledgeDocument("concepts/empty.md", { type: "concept" }, "");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n");
  });

  it("accepts CRLF and emits LF with one final newline", () => {
    const doc = parsed("---\r\ntype: concept\r\n---\r\n\r\nBody\r\n");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n\nBody\n");
  });

  it.each([
    ["frontmatter_duplicate_key", "---\ntype: concept\ntype: entity\n---\n"],
    ["frontmatter_alias_forbidden", "---\ntype: concept\nx: &x [1]\ny: *x\n---\n"],
    ["frontmatter_custom_tag_forbidden", "---\ntype: concept\nx: !producer value\n---\n"],
    [
      "frontmatter_multiple_documents",
      "---\ntype: concept\n...\n---\ntype: entity\n---\n",
    ],
  ])("returns %s without exposing a YAML exception", (code, input) => {
    const result = parseKnowledgeDocument(input, "concepts/bad.md");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(code);
    expect(result.diagnostics[0].path).toBe("concepts/bad.md");
  });

  it("rejects missing frontmatter, missing type, byte overflow, and depth overflow", () => {
    expect(parseKnowledgeDocument("# Body\n", "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_missing",
    );
    expect(parseKnowledgeDocument("---\ntitle: A\n---\n", "concepts/a.md").diagnostics[0].code).toBe(
      "concept_missing_type",
    );
    const large = `---\ntype: concept\nx: ${"a".repeat(FRONTMATTER_MAX_BYTES)}\n---\n`;
    expect(parseKnowledgeDocument(large, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_bytes",
    );
    const deep = `---\ntype: concept\nx: ${"[".repeat(33)}0${"]".repeat(33)}\n---\n`;
    expect(parseKnowledgeDocument(deep, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_depth",
    );
  });

  it.each([
    ["legacy-scalar", "sources: sources/SRC-1"],
    ["legacy-list", "sources: [sources/SRC-1, sources/SRC-2]"],
  ])("preserves %s sources during an ordinary patch", (_kind, sourceLine) => {
    const doc = parsed(`---\ntype: source\n${sourceLine}\nproducer: {keep: true}\n---\n\nOld\n`);
    const patched = patchKnowledgeDocument(doc, { fields: { status: "ingested" }, body: "New\n" });
    const reparsed = parsed(serializeKnowledgeDocument(patched));
    expect(reparsed.sources).toEqual(doc.sources);
    expect(reparsed.extensions.producer).toEqual({ keep: true });
    expect(reparsed.body).toBe("New\n");
  });
});
