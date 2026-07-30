/**
 * #3477 follow-up — the two items flagged in its merge review:
 *
 * (1) splitToTokenBudget's hard-split budget is derived from each piece's
 *     own measured density (chars per estimated token) instead of a fixed
 *     3.5 chars/token guess. URL-dense ASCII JSON runs ~2.6 chars/token, so
 *     the old budget let 2,070–2,299-token slices past a 2,000 cap.
 *
 * (3) estimateTokens/estimateEmbedTokens moved below both chunkers
 *     (token-estimate.ts — cjk.ts itself is a check:fuzz-purity target and
 *     tiktoken's loader pulls node:fs; code.ts imports recursive.ts, so
 *     recursive.ts could never reuse them without a cycle), letting
 *     capByChars bound estimated embedding tokens too —
 *     the fix for the #3037 shape (CJK-dense chunks under maxChars=6000
 *     but over the embedder context, permanently unembeddable, silently)
 *     and #2826's markdown reproduction (URL-dense Korean at defaults
 *     emitting ~4,200-char / ~2,200-token chunks).
 */

import { describe, test, expect } from 'bun:test';
import {
  estimateTokens as estimateTokensViaCode,
  estimateEmbedTokens as estimateEmbedTokensViaCode,
  chunkCodeText,
} from '../../src/core/chunkers/code.ts';
import { estimateTokens, estimateEmbedTokens, DEFAULT_MAX_CHUNK_TOKENS } from '../../src/core/chunkers/token-estimate.ts';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

/** A string survives a UTF-8 round trip only if it is well-formed UTF-16 —
 *  i.e. no orphaned surrogate half. Postgres rejects a lone surrogate inside a
 *  `::jsonb` cast and aborts the whole batch (#2011). */
function isWellFormedUtf16(s: string): boolean {
  return Buffer.from(s, 'utf8').toString('utf8') === s;
}

/** ASCII structured header + CJK-dense body: the shape where the re-added
 *  header's token cost is SUPER-additive (see the header-reservation test). */
function mixedScriptTypeScript(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) =>
    `  // 설정 항목 ${i}: 환경 변수와 기본값을 병합해 최종 구성을 만든다 (참조 config/${i})\n` +
    `  const option_${i} = resolveOption('key_${i}', defaults.key_${i}, { 우선순위: ${i} });`,
  ).join('\n');
  return `export function loadEverything(defaults: Defaults) {\n${body}\n  return { ok: true };\n}\n`;
}

/** URL-dense ASCII JSON — ~2.6 chars/token, the (1) leak shape. */
function urlDenseAsciiJson(targetChars: number): string {
  const entries: string[] = [];
  let i = 0;
  let len = 0;
  while (len < targetChars) {
    const hex = ((i * 48271) % 65521).toString(16) + ((i * 69621) % 233280).toString(16) + ((i * 16807) % 104729).toString(16);
    const row =
      `  "row_${i}": { "href": "https://api.example.com/v3/resources/${hex}?sig=ab${i}cd&expires=17${i}&scope=read%2Fwrite", "etag": "W/\\"x${i}y\\"", "n": ${i} }`;
    entries.push(row);
    len += row.length;
    i++;
  }
  return `{\n${entries.join(',\n')}\n}`;
}

/** URL-dense Korean rollup lines — #2826's markdown reproduction shape. */
function urlDenseKoreanMarkdown(lines: number): string {
  return Array.from({ length: lines }, (_, i) =>
    `- 항목 ${i}: 검증용 한국어 설명 문장이 이어집니다 · 링크: https://docs.example.com/pages/${String(i).padStart(32, '0')}?v=abcdef0123456789&ref=sample`,
  ).join('\n');
}

describe('estimator home (cjk.ts) — the (3) move', () => {
  test('code.ts re-exports are the same functions (import sites unchanged)', () => {
    expect(estimateTokensViaCode).toBe(estimateTokens);
    expect(estimateEmbedTokensViaCode).toBe(estimateEmbedTokens);
  });
});

describe('splitToTokenBudget — measured hard-split budget, the (1) leak', () => {
  test('URL-dense ASCII json fence stays under the default cap — headers included, no slack (previously 2,379-token max)', async () => {
    const src = urlDenseAsciiJson(14_400);
    const chunks = await chunkCodeText(src, 'fence.json');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // STRICT: the emitted chunk (structured header + body) fits the cap.
      // The splitter reserves the header's tokens from the body budget, so
      // no "body capped, header pushed it over" residue survives.
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
    }
    // Content preserved — first and last rows survive the re-split.
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('"row_0"');
    expect(joined).toContain('scope=read%2Fwrite');
  });
});

describe('capByChars — token-aware belt, the (3) payoff', () => {
  test('URL-dense Korean markdown at defaults stays under the token budget (previously ~2,200-token chunks)', () => {
    const chunks = chunkText(urlDenseKoreanMarkdown(120));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
    }
  });

  test('low-density bilingual table (the #3037 shape) splits under the budget instead of shipping over-context chunks', () => {
    // #3037's failing chunk: mostly-ASCII with a CJK minority (their repro:
    // 6001 chars, 942 CJK). Density sits BELOW CJK_DENSITY_THRESHOLD, so the
    // word pipeline counts whitespace tokens and happily builds multi-
    // thousand-char chunks; the old belt only checked chars (6000), so these
    // shipped at token counts past strict embedder contexts.
    const table = Array.from({ length: 120 }, (_, i) =>
      `ITEM-${String(i).padStart(6, '0')} | 环境配置说明 段落${i} | https://wiki.example.com/pages/${String(i).padStart(20, '0')}?rev=${i}&lang=zh | flags=prod,readonly,audit`,
    ).join('\n');
    const chunks = chunkText(table);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
    }
  });

  // DROPPED: a 'mixed-density input — every slice re-checked' test used to sit
  // here. It passed against the pre-cap behavior too, so it proved nothing.
  // Measured why: its dense run was whitespace-less CJK, which countCJKAwareWords
  // scores per character, so the word pipeline had already cut it to <=300-char
  // pieces before the belt was ever consulted (baseline: 20 dense chunks, max
  // 300 chars, cap never fires). The discriminating shape for the belt is the
  // LOW-density one — CJK below the density threshold, where the word pipeline
  // counts whitespace tokens and builds multi-thousand-char chunks — and that
  // is the #3037 bilingual-table test above.

  test('ASCII prose under both budgets passes through untouched (single chunk, verbatim)', () => {
    const prose = 'plain english prose that fits comfortably inside every budget. '.repeat(20).trim();
    const chunks = chunkText(prose);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(prose);
  });
});

describe('header reservation is an UPPER bound — estimateEmbedTokens is super-additive', () => {
  test('mixed-script source: the re-added ASCII header never pushes a piece over the cap', async () => {
    // estimateEmbedTokens takes max(cl100k, per-char-class weighted) and only
    // switches on the weighted branch when the text contains CJK. An ASCII
    // header measured ALONE therefore costs cl100k (a 59-char header = 17
    // tokens), but once it is glued onto a body containing CJK the whole
    // chunk measures on the weighted branch, where those same 59 chars cost
    // ~0.75/char (~42 tokens). Reserving the standalone figure under-counts
    // ~2.5x and the re-headered piece re-emerges over the cap: measured 2,006
    // and 2,023-token chunks on src/core/migrate.ts against a 2,000 cap,
    // where the pre-fix chunker emitted none (maxEst 1,439).
    const src = mixedScriptTypeScript(220);
    const chunks = await chunkCodeText(src, 'src/config/loader.ts');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
    }
  });
});

describe('astral surrogate pairs survive the derived-window splits', () => {
  // The hard-split budget and the capByChars window are now DERIVED from
  // measured density, so they land on arbitrary parity. A raw .slice() at
  // such an offset orphans a UTF-16 surrogate half. The repo already ships
  // src/core/text-safe.ts:safeSplitIndex for exactly this: #2011 —
  // `extract --stale` died at ~1,550 pages because excerpt() raw-sliced a
  // window boundary through an emoji, and a lone surrogate is rejected by
  // Postgres inside a ::jsonb cast, aborting the WHOLE batch.
  const ASTRAL = '\u{20000}\u{20001}\u{20002}\u{1F600}';

  test('markdown chunker emits well-formed UTF-16 on an astral-only document', () => {
    const chunks = chunkText(ASTRAL.repeat(1500));
    expect(chunks.length).toBeGreaterThan(1);
    const corrupted = chunks.filter((c) => !isWellFormedUtf16(c.text));
    expect(corrupted.length).toBe(0);
  });

  test('code chunker emits well-formed UTF-16 on a whitespace-less astral blob', async () => {
    const chunks = await chunkCodeText(JSON.stringify({ k: ASTRAL.repeat(3000) }), 'blob.json');
    expect(chunks.length).toBeGreaterThan(1);
    const corrupted = chunks.filter((c) => !isWellFormedUtf16(c.text));
    expect(corrupted.length).toBe(0);
  });

  test('astral content is preserved across the split, not dropped', () => {
    const doc = ASTRAL.repeat(1500);
    const rejoined = chunkText(doc).map((c) => c.text).join('');
    expect(rejoined).toContain(ASTRAL.repeat(4));
  });
});

describe('hard split leaves no runt chunks', () => {
  // A fixed `i += charBudget` stride sheds `length mod charBudget` chars as a
  // standalone piece at EVERY recursion level, and buildChunk re-headers each
  // one into its own embedding row — near-empty fragments that still match
  // queries. Evening the slice width out costs nothing: the piece COUNT is
  // ceil(length / charBudget) either way, so the same content is redistributed
  // over the same number of chunks; only the smallest piece changes (measured
  // on a 45.6K blob: min 589 -> 1900 chars, same 24 pieces).
  const SLIVER_CHARS = 200;

  test('URL-dense ASCII json fence sheds no sliver (pre-fix: 3-56 char fragments)', async () => {
    const chunks = await chunkCodeText(urlDenseAsciiJson(14_400), 'fence.json');
    expect(chunks.length).toBeGreaterThan(1);
    const bodies = chunks.map((c) => c.text.replace(/^\[[^\]]+\] [^\n]+\n\n/, ''));
    expect(bodies.filter((b) => b.length < SLIVER_CHARS)).toEqual([]);
  });

  test('whitespace-less blob — the pure hard-split path — sheds no sliver', async () => {
    // No whitespace to break on, so recursiveChunk cannot help and every
    // boundary comes from the hard splitter: the shape where the remainder
    // stride was most visible (measured 32/54/56-char chunks pre-fix).
    const blob = JSON.stringify({ d: 'https://example.com/a/b/c?q=1&r=2#frag-'.repeat(1200) });
    const chunks = await chunkCodeText(blob, 'blob.json');
    expect(chunks.length).toBeGreaterThan(1);
    const bodies = chunks.map((c) => c.text.replace(/^\[[^\]]+\] [^\n]+\n\n/, ''));
    expect(bodies.filter((b) => b.length < SLIVER_CHARS)).toEqual([]);
    for (const c of chunks) expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
  });
});
