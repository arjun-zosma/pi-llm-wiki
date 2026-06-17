/**
 * System-prompt context injection primitives (issue #87).
 *
 * The `before_agent_start` hook augments the chained system prompt with a
 * visible wiki-status footer. This module isolates that append so it can be
 * unit-tested for idempotency — a turn that aborts (network error / ESC) and is
 * retried can carry the prior injection forward, and a naive append stacks the
 * footer 2x, 3x, ...
 */

/** The always-injected wiki-status footer (sans surrounding whitespace). */
export const WIKI_STATUS_BLOCK =
  "<wiki_status>LLM Wiki active — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>";

/**
 * Append the wiki-status footer to a system prompt — idempotently (issue #87).
 *
 * Strips any already-present footer (with its leading blank line) before
 * appending exactly one. This makes the injection safe across aborted/retried
 * agent starts that carry the prior injection forward in the chained system
 * prompt, so the footer never stacks (2x, 3x, ...).
 * See test/inject-idempotent.test.ts.
 */
export function appendWikiStatus(systemPrompt: string): string {
  const base = systemPrompt.split(`\n\n${WIKI_STATUS_BLOCK}`).join("");
  return `${base}\n\n${WIKI_STATUS_BLOCK}`;
}
