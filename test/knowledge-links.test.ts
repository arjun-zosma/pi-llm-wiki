import { describe, expect, it } from "vitest";
import {
  buildResolvedBacklinks,
  extractKnowledgeLinks,
} from "../extensions/llm-wiki/lib/knowledge-links.js";

const known = new Set([
  "concepts/source",
  "concepts/inline",
  "concepts/full",
  "concepts/collapsed",
  "concepts/shortcut",
  "concepts/encoded name",
  "shared/root",
]);

describe("knowledge links", () => {
  it("extracts inline and used full/collapsed/shortcut references only", () => {
    const body = [
      "[inline](inline.md#part)",
      "[full][target] [collapsed][] [shortcut]",
      "![image](image.md) ![image-ref][target]",
      "<https://example.com> <concepts/inline.md>",
      '<a href="inline.md">raw</a>',
      "`[code](inline.md)`",
      "\\[escaped](inline.md)",
      "",
      "    [indented](inline.md)",
      "```md\n[fenced](inline.md)\n```",
      "[unused]: unused.md",
      "[target]: full.md",
      "[collapsed]: collapsed.md",
      "[shortcut]: shortcut.md",
    ].join("\n");
    expect(extractKnowledgeLinks(body).markdown.map((l) => l.target)).toEqual([
      "inline.md#part",
      "full.md",
      "collapsed.md",
      "shortcut.md",
    ]);
  });

  it("resolves root-relative, file-relative, percent-encoded, and wikilinks", () => {
    const body = [
      "[root](/shared/root.md?x=1)",
      "[relative](../concepts/encoded%20name.md)",
      "[[concepts/inline|Inline]]",
      "[external](https://example.com/x.md)",
    ].join("\n");
    const result = buildResolvedBacklinks("concepts/source", body, known);
    expect(result.targets).toEqual(["concepts/encoded name", "concepts/inline", "shared/root"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects bundle escape and reports unresolved internal targets", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[escape](../../outside.md) [missing](missing.md)",
      known,
    );
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "link_path_escape",
      "link_unresolved",
    ]);
  });

  it("turns malformed percent encoding into a diagnostic instead of throwing", () => {
    expect(() =>
      buildResolvedBacklinks("concepts/source", "[bad](bad%ZZ.md)", known),
    ).not.toThrow();
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[bad](bad%ZZ.md)",
      known,
    );
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "link_unresolved",
    ]);
  });

  it("requires md suffix for root-relative Markdown links", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[missing suffix](/shared/root)",
      known,
    );
    expect(result.targets).toEqual([]);
  });

  it("deduplicates mixed Markdown and wikilink edges", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[one](inline.md) [[concepts/inline]] [two](./inline.md)",
      known,
    );
    expect(result.targets).toEqual(["concepts/inline"]);
  });
});
