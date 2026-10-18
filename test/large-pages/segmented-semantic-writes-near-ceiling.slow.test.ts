/**
 * Wave B PR 2 fix lane L (decision #1, option d): the put path of a semantic write on a page stored in segments near
 * the 24 MiB single-string ceiling.
 *
 * 1. Protects: add_timeline_entry on a segmented page within 640 KiB of 24 MiB reads it back whole and writes it as a
 *    normal segmented put, with the result its inline twin gets (body bytes, frontmatter, tags, content_hash,
 *    timeline rows, takes, facts, canonical file); the page stays segmented.
 * 2. Fails when: the write refuses page_body_segmented below the ceiling, or its result differs from the inline twin's.
 * 3. Slow lane: two pages near 24 MiB per engine. PGLite always; PostgreSQL when DATABASE_URL is set
 *    (test/postgres-unit-arms.txt). The pages just over 1 MiB and over 24 MiB are segmented-semantic-writes.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { testBackends } from '../helpers/test-backends.ts';

const INLINE = 'people/nia-example';
const SEGMENTED = 'people/nes-example';
const BYTES = PAGE_MAX_BYTES - 640 * 1024;

for (const kind of testBackends()) {
  describe(kind + ': a semantic write on a segmented page near 24 MiB', () => {
    let brain: TwinBrain;
    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.imported(INLINE, BYTES);
        await seed.setSwitch(true);
        await seed.imported(SEGMENTED, BYTES);
      });
      expect([await brain.storageOf(INLINE), await brain.storageOf(SEGMENTED)]).toEqual(['inline', 'segmented']);
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('add_timeline_entry writes the segmented page as the inline twin is written', async () => {
      const params = { date: '2026-10-04', summary: 'near ceiling entry' };
      const inline = await brain.call('add_timeline_entry', { slug: INLINE, ...params });
      const segmented = await brain.call('add_timeline_entry', { slug: SEGMENTED, ...params });
      expect(inline).toMatchObject({ status: 'ok' });
      expect(segmented).toMatchObject({ status: 'ok' });
      expect(await brain.view(SEGMENTED)).toEqual(await brain.view(INLINE));
      expect(await brain.storageOf(SEGMENTED)).toBe('segmented');
    }, 900_000);
  });
}
