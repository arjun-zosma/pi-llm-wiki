import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { buildDirectoryIndexes, buildOkfLog } from "../extensions/llm-wiki/lib/metadata.js";

function readFixture(rel: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", "okf", rel), "utf8");
}

describe("OKF projections", () => {
  it("renders empty bundle root index", () => {
    const indexes = buildDirectoryIndexes([], { name: "" });
    expect(indexes.get("index.md")).toBe('---\nokf_version: "0.2"\n---\n\n# Wiki\n');
  });

  it("renders root and subdirectory indexes with correct structure", () => {
    const docs = [
      createKnowledgeDocument(
        "welcome.md",
        { type: "concept", title: "Welcome", description: "Entry point." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/retrieval augmented.md",
        { type: "concept", title: "RAG [safe]", description: "Grounds generation using evidence." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/nested/deep.md",
        { type: "concept", title: "Deep", description: "Deep concept." },
        "Body.",
      ),
    ];

    const indexes = buildDirectoryIndexes(docs, { name: "Example Wiki" });

    expect([...indexes.keys()].sort()).toEqual([
      "concepts/index.md",
      "concepts/nested/index.md",
      "index.md",
    ]);

    expect(indexes.get("index.md")).toBe(readFixture("indexes/root.md"));
    expect(indexes.get("concepts/index.md")).toBe(readFixture("indexes/concepts.md"));
  });

  it("renders directory indexes deterministically independent of input order", () => {
    const docs = [
      createKnowledgeDocument(
        "concepts/nested/deep.md",
        { type: "concept", title: "Deep", description: "Deep concept." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/retrieval augmented.md",
        { type: "concept", title: "RAG [safe]", description: "Grounds generation using evidence." },
        "Body.",
      ),
      createKnowledgeDocument(
        "welcome.md",
        { type: "concept", title: "Welcome", description: "Entry point." },
        "Body.",
      ),
    ];

    const indexes = buildDirectoryIndexes(docs, { name: "Example Wiki" });
    expect(indexes.get("index.md")).toBe(readFixture("indexes/root.md"));
    expect(indexes.get("concepts/index.md")).toBe(readFixture("indexes/concepts.md"));
  });

  it("renders deterministic log from events", () => {
    const eventsJsonl = readFixture("logs/events.jsonl");
    const log = buildOkfLog(eventsJsonl);
    expect(log.markdown).toBe(readFixture("logs/log.md"));
    expect(log.diagnostics.map((d) => d.code).sort()).toEqual([
      "event_invalid_json",
      "event_invalid_timestamp",
    ]);
  });

  it("renders log deterministically independent of object key order", () => {
    const events = [
      JSON.stringify({ timestamp: "2026-08-01T22:00:00.000Z", kind: "capture", a: { a: 1, z: 2 }, z: 1 }),
    ].join("\n");
    const log = buildOkfLog(events);
    expect(log.markdown).toContain('{"a":{"a":1,"z":2},"z":1}');
  });

  it("renders empty log header for no events", () => {
    const log = buildOkfLog("");
    expect(log.markdown).toBe("# Wiki Update Log\n");
    expect(log.diagnostics).toEqual([]);
  });
});
