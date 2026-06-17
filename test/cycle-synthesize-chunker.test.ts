/**
 * Unit tests for the v0.30.2 dream/synthesize chunker (D9 hash-deterministic
 * boundaries) and orchestrator slug rewrite (D6).
 *
 * Pure functions only. Exercises:
 *   - Single-chunk pass-through under budget.
 *   - 3-tier boundary ladder: ## Topic: > --- > nearest \n.
 *   - Hash determinism: same (content, hash, maxChars) → identical chunks
 *     regardless of how many times you call it.
 *   - Different content_hash → potentially different boundaries (jitter
 *     within back-half-of-budget window).
 *   - Hard fallback when no boundary fits.
 *   - Slug rewrite: bare hash6 → adds -c<idx>; correctly suffixed → unchanged;
 *     unknown shape → pass-through.
 *
 * No DB, no Anthropic, no fixtures.
 */

import { describe, test, expect } from 'bun:test';
import { splitTranscriptByBudget, rewriteChunkedSlug } from '../src/core/cycle/synthesize.ts';

describe('splitTranscriptByBudget — single chunk path', () => {
  test('returns single-element array when content <= maxChars', () => {
    const out = splitTranscriptByBudget('hello world', 'abc123def', 1000);
    expect(out).toEqual(['hello world']);
  });

  test('content exactly at maxChars stays one chunk', () => {
    const content = 'x'.repeat(500);
    const out = splitTranscriptByBudget(content, 'abc123def', 500);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(content);
  });

  test('throws on non-positive maxChars', () => {
    expect(() => splitTranscriptByBudget('hi', 'abc', 0)).toThrow(/maxChars/);
    expect(() => splitTranscriptByBudget('hi', 'abc', -5)).toThrow(/maxChars/);
  });
});

describe('splitTranscriptByBudget — boundary ladder', () => {
  test('Tier 1: prefers \\n## Topic: separator inside back-half window', () => {
    // Budget = 300 → searchStart ∈ [150, 179]. Place the topic separator
    // around position 220 so it's deep in the back-half window.
    const padding = 'x'.repeat(220);                             // 0..219
    const sep = '\n## Topic: chunk-break\nafter break content';  // pos 220+
    const tail = 'y'.repeat(200);                                // overflow
    const content = padding + sep + tail;
    const out = splitTranscriptByBudget(content, 'abcdef0123456789', 300);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Chunk 2 starts at the "\n## Topic:" boundary (the boundary char is
    // included with the second chunk by design — `slice(0, split)` cuts
    // before, `slice(split)` keeps the newline).
    expect(out[1].startsWith('\n## Topic:')).toBe(true);
  });

  test('Tier 2: falls back to --- HR marker when no Topic separator in window', () => {
    // Budget = 300, searchStart ∈ [150, 179]. HR marker around pos 220.
    const padding = 'no-topic-marker-here\n'.repeat(10); // 210 chars (~10x21)
    const sep = '\n---\nafter rule\n';
    const tail = 'tail content '.repeat(20); // overflow
    const content = padding + sep + tail;
    const out = splitTranscriptByBudget(content, 'aabbccdd11223344', 300);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Chunk 2 starts at the HR marker.
    expect(out[1].startsWith('\n---\n')).toBe(true);
  });

  test('Tier 3: falls back to nearest newline when no Topic / HR in window', () => {
    // No topic separators, no HR markers — just paragraphs.
    const para = 'sentence one. sentence two.\nmore prose to fill space\n';
    const content = para.repeat(20); // ~1080 chars
    const out = splitTranscriptByBudget(content, '11223344aabbccdd', 200);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every chunk other than the last should END with content that allowed
    // a newline split — chunks 2..N should NOT begin with a partial word.
    for (let i = 1; i < out.length; i++) {
      // After the split, the rest begins at the boundary char (newline);
      // when the boundary is "\n", chunk i starts with the newline char.
      expect(out[i].startsWith('\n')).toBe(true);
    }
  });

  test('hard-split when no boundary fits anywhere in the window', () => {
    // Single huge run of non-newline chars exceeding budget.
    const content = 'a'.repeat(1500); // no newlines, no separators
    const out = splitTranscriptByBudget(content, 'cafebabe12345678', 500);
    // Walks deterministically: first split at maxChars=500, so chunks
    // are [500, 500, 500].
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(500);
    expect(out[1]).toHaveLength(500);
    expect(out[2]).toHaveLength(500);
    expect(out.join('')).toEqual(content);
  });
});

describe('splitTranscriptByBudget — D9 hash-deterministic identity', () => {
  test('same inputs → identical chunks across many calls', () => {
    const content = ('paragraph with some text\nand a newline\n').repeat(100);
    const hash = '0123456789abcdef0123456789abcdef';
    const a = splitTranscriptByBudget(content, hash, 500);
    const b = splitTranscriptByBudget(content, hash, 500);
    const c = splitTranscriptByBudget(content, hash, 500);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('different content_hash CAN produce different boundaries (jitter)', () => {
    // Construct content with multiple newline candidates inside the
    // back-half-of-budget search window, so different hash offsets pick
    // different newlines.
    const content = ('w1 w2 w3 w4 w5\n').repeat(200);
    const a = splitTranscriptByBudget(content, '00000000aabbccdd', 500);
    const b = splitTranscriptByBudget(content, 'ffffffff77665544', 500);
    // The two splits MAY differ; assertion is that determinism is per-hash,
    // not that the function is hash-invariant.
    expect(a.join('')).toEqual(content);
    expect(b.join('')).toEqual(content);
  });

  test('reconstructs content exactly when joined back', () => {
    const content = ('# heading\n\nbody line\n## Topic: something\nmore body\n').repeat(50);
    const out = splitTranscriptByBudget(content, 'aaaaaaaa11111111', 400);
    expect(out.join('')).toEqual(content);
  });

  test('non-hex hash falls through to offset 0', () => {
    // parseHashOffset returns 0 on bad hex; chunks should still be valid.
    const content = ('xx\n').repeat(1000);
    const out = splitTranscriptByBudget(content, '!!!not-hex!!!', 500);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.join('')).toEqual(content);
  });
});

describe('rewriteChunkedSlug — D6 zero-Sonnet-trust slug rewrite', () => {
  test('appends -c<idx> when slug ends with bare hash6', () => {
    expect(rewriteChunkedSlug('wiki/originals/ideas/2026-05-08-thesis-abc123', 'abc123', 0))
      .toBe('wiki/originals/ideas/2026-05-08-thesis-abc123-c0');
    expect(rewriteChunkedSlug('wiki/personal/reflections/2026-05-08-foo-deadbe', 'deadbe', 2))
      .toBe('wiki/personal/reflections/2026-05-08-foo-deadbe-c2');
  });

  test('passes through when slug already correctly chunk-suffixed', () => {
    expect(rewriteChunkedSlug('wiki/originals/ideas/2026-05-08-thesis-abc123-c0', 'abc123', 0))
      .toBe('wiki/originals/ideas/2026-05-08-thesis-abc123-c0');
    expect(rewriteChunkedSlug('foo-bar-deadbe-c5', 'deadbe', 5))
      .toBe('foo-bar-deadbe-c5');
  });

  test('does not double-rewrite when -c<otherIdx> would conflict with idx', () => {
    // If a slug already has a chunk suffix (any idx) it ends with -c<digits>;
    // the regex is anchored on bare hash6 at end, so this case passes through.
    const result = rewriteChunkedSlug('foo-abc123-c1', 'abc123', 0);
    expect(result).toBe('foo-abc123-c1'); // unchanged — does not become foo-abc123-c1-c0
  });

  test('passes through when slug does not end with the expected hash6', () => {
    expect(rewriteChunkedSlug('wiki/foo/bar', 'abc123', 0)).toBe('wiki/foo/bar');
    expect(rewriteChunkedSlug('wiki/foo/bar-xyzxyz', 'abc123', 0)).toBe('wiki/foo/bar-xyzxyz');
  });

  test('handles slug that IS exactly hash6', () => {
    expect(rewriteChunkedSlug('abc123', 'abc123', 3)).toBe('abc123-c3');
  });

  test('handles slug ending with /<hash6> path-segment shape', () => {
    expect(rewriteChunkedSlug('foo/bar/abc123', 'abc123', 1))
      .toBe('foo/bar/abc123-c1');
  });

  test('empty slug passes through', () => {
    expect(rewriteChunkedSlug('', 'abc123', 0)).toBe('');
  });
});

describe('splitTranscriptByBudget — UTF-16 surrogate-pair safety (v0.42.0.0)', () => {
  // 🚀 = U+1F680 (surrogate pair: 0xD83D 0xDE80; JS string length = 2).
  // 𠀀 = U+20000 (non-BMP CJK: 0xD840 0xDC00).
  const ROCKET = '🚀';
  const NBMP_HAN = '𠀀';

  test('hard-split lands at emoji boundary — pair not orphaned', () => {
    // Build a content with NO `## Topic:`, NO `---`, NO `\n` past the
    // first half so all three boundary tiers fail and findBoundary falls
    // through to the surrogate-safe hard-split. Emoji at maxChars=300.
    // Budget = 300; searchStart somewhere in [150, 179]. No newlines in
    // back-half → tier-3 hard-split fires.
    const head = 'x'.repeat(298);          // ASCII pad to position 298
    const tail = ROCKET + 'y'.repeat(200); // 🚀 at positions [298, 299]
    const content = head + tail;
    const out = splitTranscriptByBudget(content, 'cafebabedeadbeef', 300);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // chunk 1 must not orphan a surrogate: every chunk-1 char.codeAt
    // must be paired (or non-surrogate).
    const c1 = out[0]!;
    const lastCode = c1.charCodeAt(c1.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    // joined chunks reconstruct the source byte-identical
    expect(out.join('')).toBe(content);
  });

  test('determinism preserved with non-BMP CJK at hard-split boundary', () => {
    const head = 'a'.repeat(298);
    const tail = NBMP_HAN + 'b'.repeat(200);
    const content = head + tail;
    const refs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      refs.add(JSON.stringify(splitTranscriptByBudget(content, 'cafebabedeadbeef', 300)));
    }
    // same (content, hash, maxChars) → byte-identical chunks every time
    expect(refs.size).toBe(1);
  });

  test('joined chunks always reconstruct source — fuzz across multiple hashes', () => {
    const head = 'h'.repeat(297);
    const tail = ROCKET + NBMP_HAN + 't'.repeat(200);
    const content = head + tail;
    // exercise jitter window across 5 different content hashes
    const hashes = ['0', '1f', '7fffffff', 'cafebabe', 'deadbeef'];
    for (const h of hashes) {
      const out = splitTranscriptByBudget(content, h.padStart(16, '0'), 300);
      expect(out.join('')).toBe(content);
      // no chunk ends with an unpaired high surrogate
      for (const c of out) {
        if (c.length === 0) continue;
        const last = c.charCodeAt(c.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });
});
