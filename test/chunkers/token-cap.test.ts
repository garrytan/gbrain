/**
 * Opt-in estimated-token chunk cap — `embedding_max_chunk_tokens` config
 * key → ChunkOptions.maxEmbedTokens / CodeChunkOptions.maxEmbedTokens.
 *
 * Field failure this exists for: a local llama-server embedding backend
 * (`-ub 2048`) crashes deterministically (trace/BPT trap → EOF at the
 * client) when a single chunk exceeds ~2,050 real tokens; Ollama's runner
 * EOFs the same way past its physical batch size. Two content shapes
 * trigger it:
 *
 *   1. Korean docs carrying one long source URL per line.
 *      The URLs' ASCII mass pushes CJK density below 0.30, flipping
 *      countCJKAwareWords to whitespace counting, where a 150-char URL
 *      counts as ONE word → chunks balloon to 3-4K chars ≈ 2,000+
 *      real tokens (URL soup tokenizes at ~1.6 chars/token).
 *
 *   2. Large JSON code blocks (~7K chars) that the word pipeline
 *      undercounts the same way (few whitespace tokens).
 *
 * With the option SET, every emitted chunk satisfies
 *   estimateEmbeddingTokens(chunk) <= maxEmbedTokens
 * where the estimate deliberately OVERSTATES real tokenizer counts.
 * With the option UNSET (the default), chunking is byte-identical to
 * previous releases — pinned below.
 */

import { describe, test, expect } from 'bun:test';
import { chunkText, capByEstimatedTokens } from '../../src/core/chunkers/recursive.ts';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';
import { estimateEmbeddingTokens } from '../../src/core/cjk.ts';

/** Cap under test — headroom for the contextual-retrieval prefix under a ~2,050-token server limit. */
const CAP = 1500;

/** Synthesize the failing shape: Korean rollup lines each ending in a long Notion-style URL. */
function urlDenseKoreanRollup(lines: number): string {
  const out: string[] = ['# 링크가 줄마다 붙는 한국어 예시 문서', ''];
  for (let i = 0; i < lines; i++) {
    const hex32 = (i * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(4);
    out.push(
      `- **항목 ${i}**: 이 줄은 청커 동작 검증을 위한 의미 없는 한국어 예시 문장입니다 · 전화 000-0000-${String(1000 + i)} · ` +
      `이메일 user${i}@example.com · 링크: https://docs.example.com/pages/${hex32}?v=abcdef0123456789&ref=sample`,
    );
  }
  return out.join('\n');
}

/** Synthesize a large pretty-printed JSON block with CJK values. */
function bigJsonBlock(targetChars: number): string {
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

describe('default behavior (maxEmbedTokens unset) — unchanged', () => {
  test('URL-dense doc still emits over-cap chunks by default (cap is opt-in, not a silent default)', () => {
    const md = urlDenseKoreanRollup(60);
    const chunks = chunkText(md);
    expect(chunks.length).toBeGreaterThan(0);
    // This is the failure shape the option exists for: without opting in,
    // the word pipeline's whitespace undercount still produces chunks past
    // the estimate — proof the default path took no cap.
    expect(chunks.some((c) => estimateEmbeddingTokens(c.text) > CAP)).toBe(true);
  });

  test('unset option and empty options object produce identical chunks', () => {
    const md = urlDenseKoreanRollup(60);
    expect(chunkText(md, {})).toEqual(chunkText(md));
  });
});

describe('opt-in cap — URL-dense Korean doc (field-failure shape)', () => {
  test('every chunk stays under the estimated-token cap', () => {
    const md = urlDenseKoreanRollup(60);
    const chunks = chunkText(md, { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(CAP);
    }
  });

  test('no chunk reaches the measured 3K-char danger zone for URL soup', () => {
    const md = urlDenseKoreanRollup(60);
    const chunks = chunkText(md, { maxEmbedTokens: CAP });
    // 1500 est tokens at the OTHER weight (0.75/char) bounds chunks to
    // ~2,000 chars for pure ASCII — well under the ~3,300 chars where
    // URL-dense content crosses ~2,050 real tokens (1.6 chars/token).
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(2600);
    }
  });

  test('content is preserved (no lines dropped by the cap)', () => {
    const md = urlDenseKoreanRollup(60);
    const chunks = chunkText(md, { maxEmbedTokens: CAP });
    const joined = chunks.map((c) => c.text).join('\n');
    // Spot-check first / middle / last rollup lines survive chunking.
    for (const marker of ['항목 0', '항목 30', '항목 59']) {
      expect(joined).toContain(marker);
    }
  });
});

describe('opt-in cap — large JSON blocks', () => {
  test('7K-char pretty JSON through the prose path stays under the cap', () => {
    const md = `설정 파일 원문 보존:\n\n\`\`\`\n${bigJsonBlock(7000)}\n\`\`\`\n`;
    const chunks = chunkText(md, { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(CAP);
    }
  });

  test('7K-char minified JSON (single whitespace-less token) stays under the cap', () => {
    const minified = bigJsonBlock(7000).replace(/\n\s*/g, '');
    const chunks = chunkText(minified, { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(CAP);
    }
  });

  test('json fence via the code chunker stays under the cap (+header slack)', async () => {
    const chunks = await chunkCodeText(bigJsonBlock(7000), 'fence.json', { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      // buildChunk prepends a short "[JSON] fence.json:…" header AFTER the
      // body-level cap; allow ~60 est tokens of header slack. Real-token
      // safety margin (2,050 − overestimated 1,500) absorbs this easily.
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(CAP + 60);
    }
  });
});

describe('opt-in cap — normal content is untouched even when enabled', () => {
  test('Latin prose chunks are identical when the cap clears their estimate', () => {
    const prose = Array.from({ length: 120 }, (_, i) =>
      `This is sentence number ${i} and it talks about ordinary things in plain words.`,
    ).join(' ');
    // Largest chunk of this fixture estimates ~1,730 (merge-inflated ~450
    // words at 0.75/char) — a 2,000 cap clears it, so output is untouched.
    const chunks = chunkText(prose, { maxEmbedTokens: 2000 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks).toEqual(chunkText(prose));
  });

  test('tight caps split long Latin chunks conservatively — bound still guaranteed', () => {
    // The ASCII weight (0.75/char) overstates real Latin tokenization ~3×
    // BY DESIGN (the cap must hold against any tokenizer). Consequence,
    // pinned here so it is a documented trade-off and not a surprise: a
    // cap of 1500 splits merge-inflated (~450-word) English chunks that a
    // real tokenizer would count at only ~600 tokens. Users pick the cap
    // for THEIR backend's limit; strict caps trade chunk size for the
    // guarantee.
    const prose = Array.from({ length: 120 }, (_, i) =>
      `This is sentence number ${i} and it talks about ordinary things in plain words.`,
    ).join(' ');
    const chunks = chunkText(prose, { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(chunkText(prose).length);
    for (const c of chunks) {
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(CAP);
    }
  });

  test('Korean prose (CJK-dense, no URLs) chunks are identical with and without the cap', () => {
    const prose = Array.from({ length: 80 }, (_, i) =>
      `이 문장은 순수 한국어 산문의 청킹 동작을 확인하기 위한 ${i}번째 예시 문장입니다.`,
    ).join(' ');
    const chunks = chunkText(prose, { maxEmbedTokens: CAP });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toEqual(chunkText(prose));
    for (const c of chunks) {
      // CJK-dense chunks are char-counted (≈450 max) — nowhere near 1500.
      expect(estimateEmbeddingTokens(c.text)).toBeLessThanOrEqual(700);
    }
  });
});

describe('capByEstimatedTokens unit behavior', () => {
  test('returns input unchanged when under the cap', () => {
    expect(capByEstimatedTokens('short text', 1500)).toEqual(['short text']);
    expect(capByEstimatedTokens('', 1500)).toEqual([]);
  });

  test('prefers newline cut points within the lookback window', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 40 }, () => line).join('\n');
    const pieces = capByEstimatedTokens(text, 1000);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) {
      // Every piece should be whole lines (multiples of the 100-char line);
      // a cut piece carries its trailing newline, so filter the empty tail.
      for (const l of p.split('\n').filter((s) => s.length > 0)) {
        expect(l).toBe(line);
      }
    }
  });

  test('reassembles byte-for-byte — boundary whitespace survives cuts', () => {
    // Regression (found in production-scale review of the non-config
    // predecessor PR #2847): trim() on each forced-split piece dropped
    // cut-boundary whitespace — 15,882 of 157,823 replayed rows failed
    // byte-for-byte reassembly.
    const line = '  indented, with trailing spaces  ';
    const doc = Array.from({ length: 200 }, () => line).join('\n');
    const pieces = capByEstimatedTokens(doc, 500);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(doc);
  });

  test('makes forward progress on whitespace-less input (hard cut)', () => {
    const blob = 'a'.repeat(10_000);
    const pieces = capByEstimatedTokens(blob, 1000);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(blob);
    for (const p of pieces) {
      expect(estimateEmbeddingTokens(p)).toBeLessThanOrEqual(1000);
    }
  });
});

describe('estimateEmbeddingTokens — weight sanity', () => {
  test('overestimates URL-dense ASCII (0.75/char ≥ measured ~0.63/char)', () => {
    const url = 'https://docs.example.com/pages/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4?v=abc&ref=sample';
    const est = estimateEmbeddingTokens(url);
    expect(est).toBeGreaterThanOrEqual(Math.floor(url.length * 0.7));
  });

  test('counts CJK at 1 token/char', () => {
    expect(estimateEmbeddingTokens('가나다라마')).toBe(5);
  });

  test('whitespace is nearly free', () => {
    expect(estimateEmbeddingTokens('   \n\t  ')).toBeLessThanOrEqual(1);
  });

  test('empty string is 0', () => {
    expect(estimateEmbeddingTokens('')).toBe(0);
  });
});
