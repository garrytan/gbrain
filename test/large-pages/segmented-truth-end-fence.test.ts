/**
 * GBRA-133: a segmented page whose truth ends with a facts fence reads back whole for a trusted caller when the source
 * has withdrawals.
 *
 * 1. Protects: the trusted stored read joins segments only around a marker a cut splits (markerCarry carries a proper
 *    prefix of a marker, never a whole one), so the truth's last segment is not glued to the timeline's first, where
 *    the end marker would read as quoted prose and the fence as crossing a forced cut.
 * 2. Fails when: markerCarry returns a complete end marker (the read refuses with page_projection_stale, or keeps a
 *    purged row).
 * 3. PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { markerCarry, openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { PRIVATE, importSegmented, overlaidStoredBody, pageContent, privacyFacts, privacyText, readRange, seedLedger } from '../helpers/segmented-privacy-fixture.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('a facts fence at the end of a segmented truth', () => {
  test('markerCarry carries only a marker a cut splits', () => {
    expect(markerCarry(`row\n${FACTS_FENCE_END}`)).toBe('');
    expect(markerCarry(`row\n${FACTS_FENCE_BEGIN}`)).toBe('');
    expect(markerCarry(`row\n${FACTS_FENCE_END.slice(0, 12)}`)).toBe(FACTS_FENCE_END.slice(0, 12));
    expect(markerCarry(`row\n${FACTS_FENCE_BEGIN.slice(0, -1)}`)).toBe(FACTS_FENCE_BEGIN.slice(0, -1));
  });

  test('the trusted stored read equals the overlaid stored body, purged row dropped', async () => {
    const slug = 'notes/fence-at-truth-end';
    const pageId = await importSegmented(engine, slug, pageContent(`${privacyText(mulberry32(7), 1_100_000, { keys: false })}\n${privacyFacts()}`, 'notes on the timeline\n'));
    await seedLedger(engine, slug);
    const stored = await overlaidStoredBody(engine, slug, pageId);
    expect(stored.compiled_truth.endsWith(FACTS_FENCE_END)).toBe(true);
    expect(stored.compiled_truth).not.toContain(PRIVATE.purged);
    const body = await openSegmentedBody(engine, { pageId });
    const trusted = await readRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', body });
    expect(trusted.bytes.toString('utf8')).toBe(stored.compiled_truth + stored.timeline);
  }, 120_000);
});
