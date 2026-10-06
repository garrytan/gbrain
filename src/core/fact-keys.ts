/**
 * Fact keys: short facts extracted from a page, merged into the embedding
 * input of the page's own chunks so a question phrased like the fact finds
 * the page — while search still returns the page's original text.
 *
 * Merging the facts into the chunk's embedding input (one key per chunk) is
 * the measured-better design; adding each fact as its own separately-ranked
 * key enlarges the index and ranks worse than no expansion at all.
 *
 * Pure: no DB, no network. Callers supply the extracted items and the page's
 * chunks; this module decides which facts each chunk carries and builds the
 * embedding input. The stored `chunk_text` is never changed.
 */

export type FactKeyAssignment = 'chunk' | 'page';

/** Maximum fact-key characters attached to one chunk. */
export const FACT_KEYS_MAX_CHARS = 800;

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'was', 'are', 'were',
  'be', 'been', 'it', 'that', 'this', 'at', 'by', 'from', 'as', 'user', 'users', 'i', 'my', 'me', 'they', 'their', 'has', 'have', 'had']);

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 2 && !STOPWORDS.has(t)));
}

function sanitize(item: string): string {
  return item.replace(/<\/?context>/gi, '').replace(/\s+/g, ' ').trim();
}

function capJoin(items: string[]): string | null {
  let out = '';
  for (const item of items) {
    const next = out ? `${out}; ${item}` : item;
    if (next.length > FACT_KEYS_MAX_CHARS) break;
    out = next;
  }
  return out || null;
}

/**
 * Fact-key text per chunk (null = no keys). `chunk` assigns each fact to the
 * chunk sharing the most content words with it (ties to the earliest chunk;
 * a fact sharing none goes to the first chunk); `page` gives every chunk all
 * of the page's facts. Code and image chunks never carry keys.
 */
export function assignFactKeys(
  items: readonly string[],
  chunks: ReadonlyArray<{ chunk_text: string; chunk_source?: string | null }>,
  assignment: FactKeyAssignment,
): Array<string | null> {
  const clean = [...new Set(items.map(sanitize).filter(Boolean))];
  const eligible = chunks.map(c => c.chunk_source !== 'fenced_code' && c.chunk_source !== 'image_asset');
  const out: Array<string | null> = chunks.map(() => null);
  if (clean.length === 0 || !eligible.some(Boolean)) return out;
  if (assignment === 'page') {
    const text = capJoin(clean);
    return chunks.map((_, i) => (eligible[i] ? text : null));
  }
  const chunkTokens = chunks.map(c => tokens(c.chunk_text));
  const buckets: string[][] = chunks.map(() => []);
  const first = eligible.indexOf(true);
  for (const item of clean) {
    const t = tokens(item);
    let best = first;
    let bestScore = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (!eligible[i]) continue;
      let score = 0;
      for (const w of t) if (chunkTokens[i].has(w)) score++;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    buckets[best].push(item);
  }
  return buckets.map((b, i) => (eligible[i] ? capJoin(b) : null));
}

/**
 * The embedding input for a chunk carrying fact keys, in the same
 * `<context>` wrapper the title prefix uses. Null keys return the plain
 * title-wrapped (or raw, without a title) input unchanged.
 */
export function factKeyedEmbeddingInput(chunkText: string, title: string | null, factKeys: string | null): string {
  const safeTitle = (title ?? '').replace(/<\/?context>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!factKeys) return safeTitle ? `<context>${safeTitle}\n</context>\n${chunkText}` : chunkText;
  return `<context>${safeTitle}\nFacts: ${factKeys}\n</context>\n${chunkText}`;
}
