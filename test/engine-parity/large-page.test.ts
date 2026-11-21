/**
 * BrainEngine parity — the large-page write guard's read (engine-sql/large-page.ts): the stored body size of a live
 * page, which a remote put_page measures before it is queued.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readStoredBodyBytes returns the same size on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the UTF-8 bytes of an inline page's
 *    compiled_truth plus timeline, a segmented page's body_bytes, and null for a missing or soft-deleted page.
 *  - Regression: an engine that measures a different size lets a remote put_page replace a large page with a window
 *    of it (the shrink and revision checks never fire), or refuses a small page's ordinary replacement. The Rust
 *    engine has no SQL, so the statement has to exist as a typed member.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside persistence/large-page-guard.ts,
 *    which the parity cases cannot call (D18).
 *  - readPageBodySizes (append_page's read after its write, persistence/page-append.ts): the body and truth sizes of a
 *    page by id, deleted or not; a segmented page answers body_bytes and truth_bytes. A wrong size breaks the append's
 *    receipt (body_bytes, appended_bytes) and the mention range of its added bytes.
 *  - Seam: none. Typed members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta, publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Size note' };
const ONE = segmentText('# Intro\nfirst segment of the large page\n');
const TWO = segmentText('## Rest\nsecond segment, two-byte é and three-byte € included\n');

describe('engine parity: large-page write guard', () => {
  parityTest('readStoredBodyBytes measures inline bodies in UTF-8 bytes, segmented bodies by body_bytes, and no dead page', {
    methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging',
      'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'readStoredBodyBytes'],
  }, async (engine) => {
    await engine.putPage('notes/size-inline', { ...NOTE, compiled_truth: 'café body', timeline: '- 2026-01-01 € event' });
    await engine.putPage('notes/size-no-timeline', { ...NOTE, compiled_truth: 'plain body', timeline: '' });
    await engine.putPage('notes/size-gone', { ...NOTE, compiled_truth: 'gone body', timeline: '' });
    await engine.softDeletePage('notes/size-gone');
    await publishSegmentedPage(engine, 'notes/size-segmented', [ONE, TWO]);
    await engine.createSegmentedPageShell('notes/size-shell', pageMeta('Shell'), { sourceId: 'default' });
    const sizes: Record<string, number | null> = {};
    for (const slug of ['notes/size-inline', 'notes/size-no-timeline', 'notes/size-gone', 'notes/size-segmented', 'notes/size-shell', 'notes/size-missing']) {
      sizes[slug] = await engine.readStoredBodyBytes(slug, 'default');
    }
    const otherSource = await engine.readStoredBodyBytes('notes/size-inline', 'parity-missing');
    expect(sizes['notes/size-inline']).toBe(Buffer.byteLength('café body') + Buffer.byteLength('- 2026-01-01 € event'));
    expect(sizes['notes/size-no-timeline']).toBe(Buffer.byteLength('plain body'));
    expect(sizes['notes/size-gone']).toBeNull();
    expect(sizes['notes/size-segmented']).toBe(ONE.body.byteLength + TWO.body.byteLength);
    expect(sizes['notes/size-missing']).toBeNull();
    expect(otherSource).toBeNull();
    return { sizes, otherSource };
  });

  parityTest('readPageBodySizes answers a page\'s body and truth sizes by id, deleted or not, and null for no page', {
    methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging',
      'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'getPage', 'readPageBodySizes'],
  }, async (engine) => {
    const inline = await engine.putPage('notes/sizes-inline', { ...NOTE, compiled_truth: 'café body', timeline: '- 2026-01-01 € event' });
    const empty = await engine.putPage('notes/sizes-empty', { ...NOTE, compiled_truth: '', timeline: '' });
    const gone = await engine.putPage('notes/sizes-gone', { ...NOTE, compiled_truth: 'gone body', timeline: '' });
    await engine.softDeletePage('notes/sizes-gone');
    await publishSegmentedPage(engine, 'notes/sizes-segmented', [ONE, TWO]);
    const segmented = await engine.getPage('notes/sizes-segmented');
    expect(segmented).not.toBeNull();
    const sizes = {
      inline: await engine.readPageBodySizes(Number(inline.id)),
      empty: await engine.readPageBodySizes(Number(empty.id)),
      gone: await engine.readPageBodySizes(Number(gone.id)),
      segmented: await engine.readPageBodySizes(Number(segmented!.id)),
      missing: await engine.readPageBodySizes(Number(inline.id) + 100_000),
    };
    expect(sizes.inline).toEqual({ bytes: Buffer.byteLength('café body') + Buffer.byteLength('- 2026-01-01 € event'), truth: Buffer.byteLength('café body') });
    expect(sizes.empty).toEqual({ bytes: 0, truth: 0 });
    expect(sizes.gone).toEqual({ bytes: Buffer.byteLength('gone body'), truth: Buffer.byteLength('gone body') });
    expect(sizes.segmented?.bytes).toBe(ONE.body.byteLength + TWO.body.byteLength);
    expect(sizes.missing).toBeNull();
    return sizes;
  });
});
