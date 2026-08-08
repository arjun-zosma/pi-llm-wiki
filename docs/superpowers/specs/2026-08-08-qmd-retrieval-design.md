# QMD-Backed Second-Brain Retrieval Design

**Status:** Approved design  
**Target:** Next major release  
**Runtime:** Node.js 22 or newer  
**Date:** 2026-08-08

## Summary

pi-llm-wiki will replace its heuristic recall ranking with QMD as its first-class retrieval engine. QMD will own Markdown indexing, BM25 retrieval, dense retrieval, rank fusion, query expansion, and local reranking. pi-llm-wiki will continue to own the knowledge model: canonical-card prioritization, evidence and contradiction assembly, feedback, context packing, layered vault behavior, and quality evaluation.

Markdown remains authoritative. QMD's SQLite database and model artifacts are local, rebuildable implementation details. No custom database or graph database will be introduced.

The product goal is not to return pages that merely resemble a query. Recall must provide useful memory for an AI: the best reviewed conclusion first, its strongest evidence, applicable scope and freshness, and any relevant competing claim.

## Current-State Audit

The personal vault inspected during design contained:

- 701 registered pages
- 626 `source` pages
- 40 `concept` pages
- 26 `entity` pages
- 9 generic pages
- titles and types on every registered page
- tags on 63% of pages
- effectively no summaries, descriptions, aliases, recall triggers, or domain metadata
- no `meta/embeddings.json`, so live recall was lexical-only

Current recall performs weighted substring matching over metadata and heading chunks, heuristic pseudo-relevance feedback, optional page-level embedding boosts, and raw additive score fusion. Its tests establish deterministic mechanics but do not measure relevance on real queries.

The live recall examples observed during brainstorming returned unrelated accounting, webhook, shopping, and build notes for questions about retrieval architecture. This is unacceptable for automatic AI context injection.

## Goals

1. Make recall precise and useful enough to improve downstream AI work.
2. Return reviewed canonical knowledge before raw observations whenever possible.
3. Preserve source evidence, provenance, scope, freshness, and conflicting claims.
4. Support exact lookup, paraphrase, vague recollection, temporal questions, contradiction discovery, and synthesis.
5. Provide lexical, hybrid, adaptive, and maximum-quality retrieval modes.
6. Reindex incrementally during ordinary writes and fully on explicit request.
7. Learn conservatively from explicit corrections and local usage signals.
8. Measure retrieval quality against a versioned benchmark built from real queries.
9. Keep Markdown portable and Obsidian-compatible.
10. Fail toward no recall or a cheaper retrieval mode, never toward unrelated injected memory.

## Non-Goals

- A custom vector database
- A graph database
- Graph-first or agentic traversal as the primary retriever
- Automatic conversion of every observation into a canonical card
- Automatic deletion or silent replacement of conflicting claims
- Training a personalized ranking model from a small feedback corpus
- Supporting Node.js 18 in the new major release
- Maintaining two independent full retrieval engines
- Treating Obsidian Graph View as a ranking algorithm

## Decisions and Alternatives

### Rejected: tune the existing scorer

Adding metadata, enabling page embeddings, and adjusting weights would be the smallest change, but it would preserve the weakest parts of the current system: broad page representations, incomparable score addition, heuristic query drift, and no strong reranker.

### Rejected: graph-first retrieval

A Zettelkasten graph improves human thinking and navigation, but graph traversal cannot reliably find a seed note from an arbitrary query. The current graph is also dominated by source observations. Typed links will support bounded evidence assembly after retrieval, not replace retrieval.

### Selected: QMD retrieval plus pi-llm-wiki memory semantics

QMD already supplies the retrieval machinery this project would otherwise need to build and maintain:

- BM25 full-text retrieval
- dense retrieval over chunks
- reciprocal-rank fusion
- query expansion
- local reranking
- incremental indexing and embedding
- a typed TypeScript SDK

pi-llm-wiki will use QMD as a library rather than copy its implementation. The next major release will require Node.js 22 or newer and include QMD as a runtime dependency. Users who need Node.js 18 can remain on the previous major release.

## Zettelkasten Role

Zettelkasten is the knowledge organization model, not the search engine.

Its useful principles are:

- one durable idea per permanent note at a useful retrieval granularity
- source or literature notes retained as evidence
- explicit links that communicate meaningful relationships
- structure notes and backlinks that support browsing and synthesis

In pi-llm-wiki, existing `concept`, `entity`, `analysis`, `synthesis`, `skill`, and similar pages can act as permanent cards. Existing `source` and observation pages act as evidence. QMD finds candidates; Zettelkasten structure makes those candidates useful and composable.

Obsidian Graph View remains a human curation surface for finding orphans, clusters, and missing links. It visualizes existing links and tags but does not affect query relevance by itself.

## Architecture

```text
Markdown vaults
  ├── canonical knowledge pages
  ├── source and observation evidence
  └── typed Markdown relationships
          │
          ▼
QMD stores, one per vault
  ├── filesystem index
  ├── BM25 index
  ├── heading-aware chunks
  ├── embeddings
  └── local reranker
          │
          ▼
pi-llm-wiki recall service
  ├── layered vault merge
  ├── canonical/evidence classification
  ├── trust, scope, and freshness adjustments
  ├── feedback adjustments
  ├── evidence and contradiction expansion
  └── diverse token-budgeted context packing
          │
          ▼
Pi tool, MCP, and automatic recall adapters
```

### Ownership

- `.llm-wiki/wiki/**/*.md` remains authoritative, user-editable knowledge.
- `.llm-wiki/raw/**` remains immutable source material.
- `.llm-wiki/meta/qmd.sqlite` is generated, extension-owned, and rebuildable.
- QMD model files remain in QMD's standard local cache.
- `.llm-wiki/meta/recall-feedback.jsonl` is durable, append-only local state and is not part of an OKF export.
- `.llm-wiki/meta/recall-feedback.json` is a rebuildable aggregate projection.

The existing guardrails for `meta/**` apply to the QMD index and feedback files. Only extension code may modify them.

### One store per vault

Each personal or project vault gets an independent QMD store under its own `meta/` directory. This prevents a project index from copying personal content and keeps index invalidation local to the vault that changed.

Automatic recall searches only the active project vault when one exists, matching the current contamination guard. Outside a project vault, it searches the personal vault. Explicit `wiki_recall` searches both applicable vaults in parallel, deduplicates by page ID with project precedence, and combines the ranked lists using rank-based fusion rather than assuming raw scores are comparable across stores.

### QMD collections

Each store defines two logical collections over `.llm-wiki/wiki/`:

- **canonical:** concepts, entities, analyses, syntheses, requirements, skills, and cases
- **evidence:** sources and observations

Unknown page types remain searchable and default to evidence unless configured as canonical. Generated reserved files such as `index.md` and `log.md` are excluded.

Collection context tells QMD that canonical pages contain reusable conclusions while evidence pages contain provenance and historical observations. pi-llm-wiki still validates every result against parsed page metadata; collection membership alone does not make a page authoritative.

### Shared service boundary

A shared retrieval service owns all behavior. Pi tools, automatic injection, and MCP call the same service and only render its structured result.

Conceptual interfaces:

```ts
type RetrievalMode = "lexical" | "hybrid" | "adaptive" | "quality";

type MemoryCandidate = {
  vault: "project" | "personal";
  pageId: string;
  path: string;
  heading?: string;
  excerpt: string;
  score: number;
  role: "canonical" | "evidence";
  status: "draft" | "stable" | "deprecated";
  matchReasons: string[];
};

type MemoryBundle = {
  card?: MemoryCandidate;
  evidence: MemoryCandidate[];
  conflicts: MemoryCandidate[];
  resolution?: ConflictResolution;
};
```

QMD-specific objects must not escape the QMD adapter. This keeps memory semantics testable without loading local models.

## Knowledge Model

### Card role

“Card” is a retrieval role, not a new required page type.

Canonical candidates include:

- `concept`
- `entity`
- `analysis`
- `synthesis`
- `requirement`
- `skill`
- `case`

Evidence candidates include:

- `source`
- observation pages
- `trajectory`
- unknown or generic pages unless explicitly promoted

Within canonical candidates, `status: stable` and current verification receive bounded preference. Draft pages remain retrievable but are labeled. Deprecated and stale pages remain retrievable when relevant and carry warnings.

### Atomic canonical pages

A canonical page should express one independently useful idea, claim, entity, requirement, or reusable procedure. Atomicity is measured by retrieval usefulness, not sentence count. The system must not split a coherent idea into artificial fragments merely to create more cards.

Recommended body sections are:

```md
## Claim

## Scope

## Evidence

## Related
```

The existing OKF-compatible metadata remains authoritative for type, title, description, sources, generation, verification, status, and staleness. pi-llm-wiki adds one optional preserved extension field for typed card relationships:

```yaml
relations:
  - target: concepts/other-card
    type: contradicts
```

Allowed first-release relationship types are:

- `supports`
- `contradicts`
- `qualifies`
- `supersedes`
- `applies_under`
- `derived_from`
- `related_to`

Only the first six affect evidence or conflict expansion. `related_to` remains a browsing link and receives no automatic inclusion privilege.

Evidence links should target the exact source page and, when available, a heading or Obsidian block anchor. Backlink generation may normalize the page target while preserving the anchor in Markdown.

### Unpromoted evidence

When no canonical card exists, recall may return the strongest source excerpt as **unpromoted evidence**. It must not be presented as an established conclusion. Repeated use can place it in a card-promotion queue.

## Indexing and Reindexing

### Normal write path

After a successful metadata rebuild for changed Markdown pages, the indexing coordinator calls QMD's incremental update. Stale embeddings are generated in the background. A write remains successful even if QMD indexing fails; the last valid index stays available and status reports the failure.

### Explicit tool

The next major release adds one consolidated tool:

```text
wiki_reindex(
  scope: "changed" | "all" = "changed",
  components: ["lexical", "vectors"] = ["lexical", "vectors"],
  force: boolean = false,
  vault: "active" | "personal" | "project" | "all" = "active"
)
```

Semantics:

- `changed` scans files and updates added, changed, and removed documents.
- `all` scans the entire selected vault but still skips fresh vectors unless `force` is true.
- selecting only `lexical` never loads embedding or reranking models.
- selecting `vectors` first performs the document update required to identify stale chunks.
- `force` applies only to selected components.
- `all` vault scope processes stores independently and reports each outcome.

The tool reports:

- collections scanned
- pages indexed, updated, unchanged, and removed
- chunks needing embeddings
- vectors generated or skipped
- index and model versions
- elapsed time
- structured warnings and errors

The existing `wiki_reindex_embeddings` tool is deprecated in the new major and delegates to `wiki_reindex(components=["vectors"])` for one release before removal.

### Index lifecycle

QMD owns its SQLite schema and transactions. pi-llm-wiki does not manipulate QMD tables directly. Before a forced full rebuild, the adapter builds or validates replacement state without deleting the last usable index. If QMD cannot provide atomic replacement through its SDK, the adapter rebuilds into a sibling temporary database, closes it, validates basic status and document counts, then renames it into place.

Content hashes, QMD schema/version information, and model identities determine staleness. A removed Markdown page must disappear from QMD results after the next incremental update. Historical feedback may retain its page ID but cannot boost a result that no longer exists.

## Retrieval Modes

Configuration adds one primary setting:

```json
{
  "llm-wiki": {
    "retrievalMode": "adaptive"
  }
}
```

Invalid explicit values fail closed with a configuration diagnostic. Default is `adaptive`.

### `lexical`

- QMD BM25 only
- no embedding, expansion, or reranking model load
- best for exact names, commands, identifiers, filenames, and low-resource systems

### `hybrid`

- lexical and vector candidates
- reciprocal-rank fusion
- no final reranking
- uses the original query as both lexical and vector intent without generative query expansion

### `adaptive`

- starts with hybrid retrieval
- reruns through QMD's expanded and reranked query path only when the initial result is uncertain
- uncertainty includes a small top-result margin, lexical/vector disagreement, broad question form, multiple topical clusters, or a detected contradiction cluster
- exact high-confidence identifiers bypass reranking

Adaptive thresholds are internal defaults initially. They become settings only if benchmark results show users need to tune them.

### `quality`

- QMD query expansion
- lexical and vector candidate generation
- reciprocal-rank fusion
- local reranking of the bounded candidate pool
- intended for maximum relevance despite higher latency and model load

QMD's supported environment variables remain the model-override surface. pi-llm-wiki will not duplicate every QMD model setting.

## Recall Data Flow

1. Resolve active personal and project vaults.
2. Normalize the query while preserving exact identifiers and original wording.
3. Select automatic or explicit recall policy.
4. Query applicable QMD stores using the configured retrieval mode.
5. Merge layered result lists by rank and deduplicate project/personal page ID collisions with project precedence.
6. Parse each candidate through the shared knowledge-document layer.
7. Classify canonical versus evidence role and derive status, trust, scope, and freshness warnings.
8. Apply bounded feedback and exact-match adjustments.
9. Group excerpts under their parent pages.
10. Prefer reviewed canonical cards.
11. Follow at most one typed relationship hop for direct evidence, qualifiers, superseding claims, and contradictions.
12. Pack diverse memory bundles under the context budget.
13. Render structured context for Pi or MCP.

### Automatic versus explicit recall

Automatic recall is precision-first:

- active project only when present; personal otherwise
- small result count
- strict confidence threshold
- no injection when confidence is insufficient
- no generic graph expansion

Explicit `wiki_recall` is recall-first:

- searches personal and project stores when both exist
- accepts a larger result count
- returns alternatives and unpromoted evidence
- exposes match explanations and diagnostics

“No reliable memory found” is a valid successful outcome. The system must not fill an empty slot with a weak candidate.

## Reranking and Adjustments

QMD's reranker judges direct query usefulness. It is not a candidate generator and cannot create evidence.

After QMD ranking, pi-llm-wiki may apply only bounded, explainable adjustments for:

- exact title, alias, command, or identifier match
- stable versus draft canonical status
- applicable freshness and verification state
- explicit user relevance judgment
- weak local usage evidence
- project duplicate precedence

These adjustments cannot introduce a candidate that QMD did not retrieve. Trust, freshness, and popularity must not hide an otherwise relevant conflicting claim.

## Typed-Link Expansion

Graph expansion is an assembly step after strong seed retrieval.

Rules:

- at most one hop by default
- only `supports`, `contradicts`, `qualifies`, `supersedes`, `applies_under`, and `derived_from` can add a result
- a generic Markdown or `related_to` link never forces inclusion
- evidence expansion is capped per card
- high-degree pages do not receive an automatic popularity boost
- graph-derived items are labeled with the relation that admitted them
- a contradiction neighbor is kept with its seed even when diversity selection would otherwise remove it

No graph database is needed. Existing generated backlinks plus parsed typed relations are sufficient.

## Contradictions and User Resolution

Conflicting claims are preserved separately with their dates, scope, status, and evidence. Automated detection may propose a conflict, but it cannot permanently declare one without review.

When recall finds a confirmed or plausible conflict, context shows both claims and asks the user which applies. The prompt identifies exact page IDs so the response can be applied deterministically.

An unambiguous user response causes the agent to invoke a focused conflict-resolution operation that:

1. records a dated resolution event
2. adds `supersedes`, `qualifies`, or `applies_under` relations as selected
3. marks the endorsed current interpretation without deleting the older claim
4. preserves all source links and prior verification history
5. rebuilds metadata and updates the affected QMD store

If the response is ambiguous, the system asks one clarifying question and makes no change. An LLM may map natural language to the explicit page IDs and relation, but it may not invent a third claim or silently edit unrelated content.

## Context Packing

Recall returns grouped memory bundles rather than a flat list of chunks.

Packing order:

1. best applicable canonical card
2. one or two strongest supporting evidence excerpts
3. relevant qualifier, superseding claim, or competing claim
4. additional diverse canonical cards while budget remains
5. unpromoted evidence only when no suitable card covers the need

Every packed item includes:

- page ID and readable path
- title and type
- vault label
- exact excerpt and heading when available
- date, status, freshness, and scope when present
- match reason
- relationship to the canonical card

Deduplication prevents several chunks from one page or repeated observations from consuming the context budget. Contradictory claims remain grouped. Context truncation removes lower-value bundles before removing evidence from the highest-value bundle.

The existing links-first behavior remains useful for interactive expansion, but automatic AI context receives the compact canonical/evidence bundle directly when it fits the configured budget.

## Feedback

### Durable event format

Implicit retrieval feedback is append-only local state in `meta/recall-feedback.jsonl`. To reduce accidental prompt retention, events store a hash of the normalized query rather than raw query text by default.

Each event includes:

- timestamp
- query hash
- retrieval mode
- index and model versions
- page ID and rank
- action

Supported actions are:

- `shown`
- `opened`
- `cited`
- `ignored`
- `relevant`
- `irrelevant`
- `corrected`
- `conflict_selected`

Explicit corrections are also preserved in human-readable wiki knowledge or resolution records; the feedback log is not their only source of truth.

### Signal strength

- explicit correction or conflict choice: strong
- explicit relevant/irrelevant judgment: strong
- cited or copied result: moderate
- opened result: weak positive
- visibly shown but ignored result: very weak negative
- result not shown: no signal

All boosts decay, remain bounded, and apply only after retrieval. Implicit signals cannot rewrite Markdown, resolve contradictions, or make a non-candidate appear. Position bias is accounted for by giving ignored results minimal weight.

Feedback collection is local and enabled by default in the new major. A single boolean setting disables implicit event capture without disabling explicit corrections.

## Card Promotion

The existing corpus is indexed immediately without bulk conversion.

A background promotion queue prioritizes evidence that is:

- repeatedly retrieved
- frequently cited or opened
- involved in explicit corrections
- repeated across several sources
- linked from multiple canonical pages
- central to active projects
- contradictory or time-sensitive

The model may propose a canonical card containing one durable idea and exact source references. Proposed metadata and body content remain draft until reviewed. Promotion does not delete, merge, or rewrite underlying source pages.

Low-value observations remain searchable evidence indefinitely. The target is a useful canonical layer, not one generated card per observation.

## Error Handling

| Failure | Behavior |
|---|---|
| vectors missing or stale | continue with BM25; report stale vector status |
| embedding model load fails | fall back to lexical retrieval |
| reranker fails or times out | return fused hybrid results |
| QMD store cannot open | automatic recall injects nothing; explicit recall returns a structured diagnostic |
| incremental update fails | retain previous usable index and mark it stale |
| full rebuild fails | keep previous database; remove temporary replacement |
| malformed Markdown | exclude page from new results and report shared parser diagnostic |
| index/model mismatch | mark stale and recommend `wiki_reindex` |
| deleted page referenced by feedback | ignore feedback entry during aggregation |
| low confidence | return no reliable memory rather than weak results |

Model downloads and long-running indexing show visible progress. Cancellation stops new work without deleting the last usable index.

## Tools and Interfaces

### Updated

- `wiki_recall` uses the shared QMD-backed recall service.
- automatic `before_agent_start` recall uses the same service with precision-first policy.
- MCP `wiki_recall` uses the same structured operation.
- `wiki_status` reports QMD document, chunk, embedding, model, and stale-index state.
- `wiki_lint` reports missing evidence, invalid typed relations, unresolved conflict markers, and stale search state.
- `wiki_rebuild_meta` schedules incremental QMD update after successful projection rebuild.

### Added

- `wiki_reindex` consolidates lexical and vector reindexing.
- one focused conflict-resolution operation records user-approved resolutions safely.

### Deprecated

- `wiki_reindex_embeddings` delegates to `wiki_reindex` for one major release cycle.
- the old heuristic recall and page-level embedding scorer are removed from active `wiki_recall` paths.
- `wiki_search` remains a fast exact registry lookup and is not presented as relevance-ranked recall.

## Configuration

First-release configuration remains narrow:

| Setting | Default | Meaning |
|---|---:|---|
| `retrievalMode` | `adaptive` | `lexical`, `hybrid`, `adaptive`, or `quality` |
| `recallFeedback` | `true` | capture bounded local implicit signals |
| `recallLinksThreshold` | existing default | switch interactive rendering to links-first |
| `recallSkillInlineMax` | existing default | inline recalled skills/cases |

QMD model overrides use QMD's documented environment variables. Candidate counts, adaptive thresholds, fusion constants, and feedback weights remain implementation constants until benchmark evidence justifies exposing them.

## Migration and Release

The next major release:

1. raises `engines.node` to Node.js 22 or newer
2. adds QMD as a runtime dependency
3. creates QMD stores lazily per vault
4. keeps Markdown and existing metadata schemas readable without content migration
5. ignores old page-level embedding sidecars after QMD activation
6. prompts users to run `wiki_reindex` for full hybrid/quality recall
7. supports immediate lexical recall after document indexing, even before embeddings finish
8. documents QMD model download size and first-run latency
9. leaves the previous major release available for Node.js 18 users

No existing source or canonical page is deleted or rewritten merely to adopt QMD. Card promotion and typed-link enrichment remain incremental, reviewable work.

## Evaluation

### Benchmark

Create a versioned benchmark from 50–100 real queries, with at least 20% held out from tuning. Include:

- exact note lookup
- vague recollection
- paraphrased conceptual recall
- entity and alias lookup
- “what did I conclude about” questions
- source and evidence requests
- temporal questions
- contradictory claims
- multi-note synthesis
- multilingual queries represented in the vault
- generic language that may produce dense-retrieval false positives

Each query receives graded relevance judgments for both canonical cards and evidence excerpts. Acceptable competing claims are identified for contradiction cases.

### Metrics

- candidate Recall@20
- MRR
- nDCG@5 and nDCG@10
- canonical-card-first success rate
- evidence precision and evidence recall
- contradiction coverage
- duplicate/context waste
- automatic-recall false-positive rate
- warm and cold latency by mode
- model download and steady-state resource cost

### Ablations

Run the same benchmark against:

1. current heuristic recall baseline
2. QMD lexical
3. QMD hybrid
4. adaptive reranking
5. quality mode
6. quality mode without typed-link assembly
7. quality mode without feedback adjustments

### Release gates

- no regression on exact identifier and title lookup
- lower automatic-recall false-positive rate than the current baseline
- material held-out improvement in canonical-card and evidence ranking
- contradiction cases surface all judged competing claims
- malformed pages and unavailable models degrade as specified
- Pi and MCP return equivalent structured results
- every explicit correction becomes a persistent regression case

Exact numeric improvement thresholds are set after the initial benchmark establishes baseline variance; they must be recorded before tuning final ranking constants.

## Testing Strategy

### Unit tests

- retrieval-mode parsing and fail-closed invalid values
- QMD adapter request mapping
- canonical/evidence classification
- layered rank fusion and project duplicate precedence
- bounded trust, freshness, and feedback adjustments
- typed-link admission and one-hop cap
- canonical/evidence bundle grouping
- contradiction preservation
- context deduplication and budget trimming
- query hashing and feedback aggregation
- stale and deleted feedback references
- fallback state machine

QMD adapter tests use fakes and do not load local models.

### Integration tests

- temporary Markdown vault indexed through the QMD SDK
- incremental add, update, and delete
- lexical recall before embeddings
- forced vector reindex
- failed rebuild preserving the prior database
- personal and project store isolation
- Pi/MCP parity
- automatic recall suppressing low-confidence results
- conflict-resolution operation preserving both claims

Model-heavy embedding and reranking smoke tests may use a separate CI job with cached models; ordinary unit tests must remain deterministic and network-free.

### Benchmark tests

Benchmark runs are versioned artifacts, not ordinary per-commit unit tests. Release candidates run the complete benchmark and publish mode-by-mode metrics, regressions, model versions, index versions, and hardware context.

## Risks and Mitigations

- **Generated cards distort evidence:** require exact source references and review before stable status.
- **Dense retrieval overmatches generic prose:** preserve BM25, use RRF and reranking, and include this failure class in the benchmark.
- **Reranker hides minority evidence:** add contradiction neighbors after seed ranking and test contradiction coverage.
- **Implicit feedback creates popularity bias:** keep it weak, bounded, decayed, and post-retrieval only.
- **QMD/model upgrade changes ranking:** record versions, mark affected indexes stale, and rerun benchmark before release.
- **Native dependency or model failure:** fall back to QMD lexical search or no injection with clear diagnostics.
- **Index contains sensitive content:** keep it under protected local `meta/`, exclude it from OKF exports, and document that full-vault backups contain derived searchable text.
- **Graph hubs dominate:** only typed one-hop relationships can add candidates; generic links do not boost rank.
- **Over-atomization harms browsing:** atomicity follows useful idea boundaries, not arbitrary size limits.
- **Stale sidecars:** content hashes, incremental updates, status diagnostics, and explicit reindexing keep them rebuildable.

## Success Criteria

The design succeeds when:

1. unrelated automatic recall is measurably reduced
2. reviewed canonical cards appear before raw observations for judged queries
3. correct evidence accompanies the selected card
4. relevant conflicts appear together and remain unresolved until user input
5. lexical recall works without loading local models
6. adaptive and quality modes materially improve held-out ranking
7. users can inspect status and repair search with one reindex tool
8. feedback improves repeated use without mutating facts
9. Obsidian and plain Markdown workflows remain intact
10. all generated search state can be rebuilt from Markdown plus durable feedback events

## Research References

- QMD repository and SDK documentation: https://github.com/tobi/qmd
- Obsidian Graph View documentation: https://obsidian.md/help/plugins/graph
- Zettelkasten introduction: https://zettelkasten.de/introduction/
- Zettelkasten atomicity guide: https://zettelkasten.de/atomicity/guide/
- Reciprocal Rank Fusion, Cormack, Clarke, and Buettcher: https://doi.org/10.1145/1571941.1572114
- Existing pi-llm-wiki architecture: `docs/architecture.md`
- Existing OKF interoperability design: `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md`
