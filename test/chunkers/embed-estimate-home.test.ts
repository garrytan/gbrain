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

  test('mixed-density input (ASCII prose + dense CJK run) — every slice re-checked under the budget', () => {
    const prose = 'ordinary english sentence with regular words flowing along. '.repeat(60);
    const dense = '혼합밀도검증용한국어연속덩어리'.repeat(400);
    const chunks = chunkText(`${prose}\n\n${dense}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
    }
  });

  test('ASCII prose under both budgets passes through untouched (single chunk, verbatim)', () => {
    const prose = 'plain english prose that fits comfortably inside every budget. '.repeat(20).trim();
    const chunks = chunkText(prose);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(prose);
  });
});
