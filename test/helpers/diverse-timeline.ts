/**
 * Timeline text that stresses the page keyword vector: hyphenated pairs of
 * astral or CJK code points are the densest tsvector input measured (every
 * character lands in two lexemes, the compound and its part, at up to 4
 * bytes each; about 7.5-7.8 lexeme-area bytes per character under Postgres
 * 16), and distinct code points keep every lexeme unique.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { PAGE_TIMELINE_FTS_MAX_CHARS } from '../../src/core/fts-language.ts';

export const PREFIX_NEEDLE = 'zzprefixneedle';
export const BEYOND_NEEDLE = 'zzbeyondneedle';
/** Postgres's limit on a tsvector's lexeme and position area (MAXSTRPOS). */
export const TSVECTOR_MAX_STRING_BYTES = 1_048_575;

/** `count` space-separated `A-B` words of `width` consecutive code points each, from `start`. */
export function hyphenPairs(start: number, count: number, width = 1): string {
  const words: string[] = [];
  let cp = start;
  const take = () => {
    let s = '';
    for (let w = 0; w < width; w++) s += String.fromCodePoint(cp++);
    return s;
  };
  for (let i = 0; i < count; i++) words.push(`${take()}-${take()}`);
  return words.join(' ');
}

/** Code points `hyphenPairs(start, count, width)` consumes. */
export const pairsSpan = (count: number, width = 1) => 2 * count * width;

/**
 * About `chars` characters: PREFIX_NEEDLE, then dense astral pairs past the
 * indexed timeline prefix, then BEYOND_NEEDLE, then distinct ASCII tokens
 * (an old full-timeline vector of this overflows the lexeme cap many times).
 */
export function diverseTimeline(chars: number): string {
  const dense = hyphenPairs(0x20000, Math.ceil(PAGE_TIMELINE_FTS_MAX_CHARS / 10) + 100, 4);
  const head = `- 2026-01-01 ${PREFIX_NEEDLE} ${dense}\n- 2026-01-02 ${BEYOND_NEEDLE}\n`;
  const tokens: string[] = [];
  let length = head.length - 1;
  for (let i = 0; length < chars; i++) {
    const token = `tok${i.toString(36)}`;
    tokens.push(token);
    length += token.length + 1;
  }
  return head + tokens.join(' ');
}

/** The vector's lexeme and position area in bytes (what MAXSTRPOS limits), uncompressed. */
export async function vectorStringBytes(engine: BrainEngine, slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ bytes: number }>(
    `SELECT (pg_column_size(search_vector || ''::tsvector) - 8 - 4 * length(search_vector))::int AS bytes FROM pages WHERE slug = $1`,
    [slug],
  );
  return Number(row!.bytes);
}

/** Whether the page vector (the title arm's document) matches `words`. */
export async function vectorMatches(engine: BrainEngine, slug: string, words: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ hit: boolean }>(
    `SELECT search_vector @@ plainto_tsquery('english', $2) AS hit FROM pages WHERE slug = $1`,
    [slug, words],
  );
  return row!.hit === true;
}
