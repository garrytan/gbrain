/**
 * Bullet-aligned timeline passages in the segmented chunker (chunkers/bullet-chunks.ts; Wave B PR 4 lane recall, #7172
 * follow-up).
 *
 * 1. Protects: a timeline segment with bullet lines breaks only at bullet starts the bullet itself chooses, so an entry
 *    added at the top of a 55-bullet descending timeline leaves every passage but at most two (the one it joins and one
 *    neighbour) byte for byte the same; passages fit maxChunkTokens and their spans tile the segment; a timeline
 *    without bullet lines and every truth segment chunk exactly as before; the work is linear in the bullets.
 * 2. Fails when: timeline passages pack greedily (a top entry shifts every boundary: the recursive chunker rewrites all
 *    4 passages for 184 of these 200 seeds), carry overlap, or a run re-split for size rewrites more than its top
 *    piece; or bullet alignment leaks into truth segments or bullet-free timelines.
 * 3. Engines: test/large-pages/timeline-top-insert-reembed.test.ts counts embedder inputs on PGLite and Postgres.
 * 4. No production seam: pure functions.
 */
import { describe, expect, test } from 'bun:test';
import { bulletChunkWork, chunkTimelineBullets } from '../../src/core/chunkers/bullet-chunks.ts';
import { chunkProjectedText } from '../../src/core/chunkers/recursive.ts';
import { estimateEmbedTokens } from '../../src/core/chunkers/token-estimate.ts';
import { initialEntryState, timelineEntryState } from '../../src/core/page-body/entry-state.ts';
import { segmentString } from '../../src/core/page-body/segmenter.ts';
import { prepareSegmentChunks } from '../../src/core/page-body/segment-chunks.ts';
import { descendingTimeline } from '../helpers/timeline-bullets.ts';
import { segmentOptions } from '../helpers/segment-bodies.ts';

const SEGMENTED = { maxTokens: 2000, spans: true, headingsLead: true, boundaryCuts: true } as const;
const fresh = (before: readonly string[], after: readonly string[]) => { const old = new Set(before); return after.filter(t => !old.has(t)).length; };

async function segmentChunks(text: string, region: 'truth' | 'timeline') {
  const entry = region === 'truth' ? initialEntryState({ region }) : timelineEntryState(initialEntryState({ region: 'truth' }));
  const segments = segmentString(text, entry, segmentOptions('trusted'));
  expect(segments.length).toBe(1);
  return { segment: segments[0]!, chunks: await prepareSegmentChunks(segments[0]!, { fenceTrust: 'trusted' }) };
}

describe('timeline passages break at bullet starts', () => {
  test('a top entry in a 55-bullet descending timeline changes at most 2 passages, for each of 200 seeds', () => {
    let oldRewritesAll = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { bullets, top } = descendingTimeline(seed);
      const before = bullets.join('\n') + '\n', after = [top, ...bullets].join('\n') + '\n';
      const passages = chunkTimelineBullets(after)!.map(c => c.text);
      expect(fresh(chunkTimelineBullets(before)!.map(c => c.text), passages)).toBeLessThanOrEqual(2);
      for (const p of passages) expect(p.startsWith('- **')).toBe(true);
      const old = chunkProjectedText(after, SEGMENTED).map(c => c.text);
      if (fresh(chunkProjectedText(before, SEGMENTED).map(c => c.text), old) === old.length) oldRewritesAll++;
    }
    expect(oldRewritesAll).toBe(184);
  });

  test('a timeline segment chunks into bullet-aligned passages that fit the token cap and tile the segment', async () => {
    const { bullets } = descendingTimeline(7);
    const text = '## Timeline\n\n' + bullets.join('\n') + '\n';
    for (const max of [2000, 256]) {
      const segments = segmentString(text, timelineEntryState(initialEntryState({ region: 'truth' })), segmentOptions('trusted'));
      const chunks = await prepareSegmentChunks(segments[0]!, { fenceTrust: 'trusted', maxChunkTokens: max });
      const bytes = Buffer.from(text);
      expect(chunks[0]!.projected_byte_start).toBe(0);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(max);
        expect(c.chunk_source).toBe('timeline');
        expect(bytes.subarray(c.projected_byte_start!, c.projected_byte_end!).toString()).toBe(c.chunk_text);
        if (i > 0) {
          expect(c.chunk_text.startsWith('- **')).toBe(true);
          expect(bytes.subarray(chunks[i - 1]!.projected_byte_end!, c.projected_byte_start!).toString().trim()).toBe('');
        }
      }
      expect(chunks[chunks.length - 1]!.projected_byte_end).toBe(Buffer.byteLength(text.trimEnd()));
    }
  });

  test('truth segments and timelines without bullet lines chunk exactly as before', async () => {
    const { bullets } = descendingTimeline(11);
    const withBullets = bullets.join('\n') + '\n';
    const prose = bullets.map(b => b.slice(2)).join('\n\n') + '\n';
    for (const [text, region] of [[withBullets, 'truth'], [prose, 'timeline'], [prose, 'truth']] as const) {
      const { chunks } = await segmentChunks(text, region);
      expect(chunks.map(c => [c.chunk_text, c.projected_byte_start, c.projected_byte_end]))
        .toEqual(chunkProjectedText(text, SEGMENTED).map(c => [c.text, c.byte_start, c.byte_end]));
    }
    expect(chunkTimelineBullets(prose)).toBeNull();
  });

  test('a bullet over the size bound falls back to the hard-capped chunker inside its own span', () => {
    const { bullets } = descendingTimeline(13, 6);
    const giant = '- **2020-01-01** | source-a — ' + 'the acme-example review covered latency and budget at length. '.repeat(400);
    const text = [bullets[0], giant, ...bullets.slice(1)].join('\n') + '\n';
    const chunks = chunkTimelineBullets(text, { maxTokens: 512 })!;
    for (const c of chunks) expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(512);
    expect(chunks.filter(c => c.text.includes('acme-example review')).length).toBeGreaterThan(2);
    const bytes = Buffer.from(text);
    for (const c of chunks) expect(bytes.subarray(c.byte_start!, c.byte_end!).toString()).toBe(c.text);
  });

  test('work is linear in the bullets: each is hashed once and runs measured stay a small multiple of them', () => {
    const measure = (n: number) => {
      const r = descendingTimeline(17, n).bullets.join('\n') + '\n';
      bulletChunkWork.units = 0;
      bulletChunkWork.runs = 0;
      chunkTimelineBullets(r);
      return { ...bulletChunkWork };
    };
    const small = measure(4000), large = measure(8000);
    expect(small.units).toBe(4000);
    expect(large.units).toBe(8000);
    expect(large.runs / large.units).toBeLessThan(2);
    expect(large.runs / small.runs).toBeLessThan(2.1);
  });
});
