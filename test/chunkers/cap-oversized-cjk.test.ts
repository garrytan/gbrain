/**
 * capOversizedChunks — CJK-aware oversize measurement (follow-up to #1675,
 * shape requested in #3475's closing review).
 *
 * cl100k (estimateTokens) matches embedding-family tokenizers on pure-ASCII
 * source (measured identical on English prose and JSON vs Qwen3-Embedding),
 * but undercounts MIXED CJK+ASCII chunks — measured −31% on URL-dense Korean
 * text (#2826's failure shape). estimateEmbedTokens lifts only that class:
 * ASCII-only input short-circuits to estimateTokens verbatim, and max()
 * keeps CJK-dominant text at the cl100k count it gets today.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeText, estimateTokens, estimateEmbedTokens } from '../../src/core/chunkers/code.ts';

/** URL-dense Korean rollup lines — the measured −31% divergence shape. */
function urlDenseKoreanMix(lines: number): string {
  return Array.from({ length: lines }, (_, i) =>
    `- 항목 ${i}: 검증용 한국어 문장 · 링크: https://docs.example.com/pages/${String(i).padStart(32, '0')}?v=abcdef0123456789&ref=sample`,
  ).join('\n');
}

function bigJsonWithKoreanValues(targetChars: number): string {
  const entries: string[] = [];
  let i = 0;
  let len = 0;
  while (len < targetChars) {
    const row =
      `  "item_${i}": { "name": "예시-${i}", "url": "https://example.com/api/v2/items/${i}?token=abc${i}def", "qty": ${i % 100}, "memo": "한국어 값이 섞인 예시 데이터" }`;
    entries.push(row);
    len += row.length;
    i++;
  }
  return `{\n${entries.join(',\n')}\n}`;
}

describe('estimateEmbedTokens — measurement gate', () => {
  test('ASCII-only input is bit-identical to estimateTokens (no CJK → short-circuit)', () => {
    const en = 'function ordinary() { return compute(42) + helper(); } '.repeat(80);
    const json = '{"item": {"name": "sample", "url": "https://example.com/a?b=c", "qty": 42}}, '.repeat(60);
    expect(estimateEmbedTokens(en)).toBe(estimateTokens(en));
    expect(estimateEmbedTokens(json)).toBe(estimateTokens(json));
  });

  test('never estimates below estimateTokens (max composition)', () => {
    for (const s of [urlDenseKoreanMix(20), '이 문장은 순수 한국어 산문 예시입니다. '.repeat(40), 'plain ascii ', '']) {
      expect(estimateEmbedTokens(s)).toBeGreaterThanOrEqual(estimateTokens(s));
    }
  });

  test('mixed CJK+ASCII (the measured divergence class) estimates strictly higher', () => {
    const mix = urlDenseKoreanMix(20);
    // Real Qwen3-Embedding count for this shape measures ~45% ABOVE cl100k;
    // the weighted form stays above the real count (+15% measured margin).
    expect(estimateEmbedTokens(mix)).toBeGreaterThan(estimateTokens(mix));
  });
});

describe('capOversizedChunks with the CJK-aware estimate', () => {
  test('oversized json fence with Korean values re-splits under the default cap', async () => {
    const src = bigJsonWithKoreanValues(14_000);
    const chunks = await chunkCodeText(src, 'fence.json');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Small slack for the "[JSON] fence.json:…" header buildChunk re-adds
      // after the body-level split.
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(2000 + 60);
    }
    // Content preserved — spot-check first / last entries survive.
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('"item_0"');
    expect(joined).toContain('한국어 값이 섞인 예시 데이터');
  });

  test('hard-split fallback makes progress on whitespace-less CJK-mixed input and stays under cap', async () => {
    const blob = '한a민b국c'.repeat(3_000); // 18K chars, no whitespace
    const chunks = await chunkCodeText(`{"blob": "${blob}"}`, 'fence.json');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(2000 + 60);
    }
  });

  test('pure-ASCII chunks are measured by the identical estimator (cap decisions unchanged)', async () => {
    const entries = Array.from({ length: 120 }, (_, i) =>
      `  "item_${i}": { "name": "sample-${i}", "url": "https://example.com/api/v2/items/${i}?token=abc${i}def", "qty": ${i % 100} }`,
    );
    const src = `{\n${entries.join(',\n')}\n}`;
    const chunks = await chunkCodeText(src, 'fence.json');
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      // For ASCII-only chunks the two estimators are identical (pinned
      // above), so cap decisions — and therefore boundaries — are unchanged.
      expect(estimateEmbedTokens(c.text)).toBe(estimateTokens(c.text));
    }
  });
});
