/**
 * #3800: subagent token economy — cap the `chunk_text` payload of search
 * results at the OP layer (search + query), so an LLM tool loop reading
 * 20 results doesn't pay for 20 full chunks (~400 tokens each) when a
 * ~300-char snippet answers "is this the right page?". The full text is one
 * `get_page` away, and the marker tells the agent exactly that.
 *
 * Resolution (op layer): explicit `snippet_chars` param wins; else, when the
 * caller is a subagent tool loop (`ctx.viaSubagent`), the
 * `agent.search_snippet_chars` config applies (default 300; 0 = full text);
 * every other caller gets full text — this changes nothing for humans, MCP
 * clients, or internal consumers.
 *
 * Truncation is chunk_text-only and NON-mutating: results may be shared with
 * a pending semantic-cache write (hybridSearchCached stores fire-and-forget),
 * so capped copies are new objects — a truncated snippet must never be what
 * gets cached.
 */

/** Default snippet budget (chars) for subagent callers when config is unset. */
export const DEFAULT_AGENT_SNIPPET_CHARS = 300;

export function buildSnippetMarker(slug: string | undefined, droppedChars: number): string {
  const target = slug && slug.length > 0 ? `get_page ${slug}` : 'get_page <slug>';
  return `… [truncated ${droppedChars} chars — ${target} for full text]`;
}

/**
 * Cap each result's `chunk_text` at `chars` characters, appending a marker
 * naming the recovery move. `chars <= 0` (or non-finite) means "no cap".
 * Returns the ORIGINAL array (same object identities) when nothing needed
 * truncation, so untouched paths stay allocation-free.
 */
export function applySnippetCap<T extends { chunk_text?: unknown; slug?: unknown }>(
  results: T[],
  chars: number,
): T[] {
  if (!Number.isFinite(chars) || chars <= 0) return results;
  let anyTruncated = false;
  const out = results.map((r) => {
    const text = r.chunk_text;
    if (typeof text !== 'string' || text.length <= chars) return r;
    anyTruncated = true;
    const slug = typeof r.slug === 'string' ? r.slug : undefined;
    return {
      ...r,
      chunk_text: text.slice(0, chars) + buildSnippetMarker(slug, text.length - chars),
    };
  });
  return anyTruncated ? out : results;
}
