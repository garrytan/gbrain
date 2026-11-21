/**
 * BrainEngine parity: flipBodyGeneration builds the page's search vector from the lead it publishes (review pass 3,
 * finding F1 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a flip is one UPDATE that sets the title, the NULL timeline and the new `timeline_lead` together, so
 *    `trg_pages_search_vector` builds the vector from the INCOMING title and lead: a flip whose incoming title and lead
 *    fit is accepted whatever lead the page held before, and the page is then found by the new title and the new lead
 *    only. The Rust arm must do the same.
 *  - Regression: the Rust store checked the vector before it stored the incoming lead, so it read the PREVIOUS lead and
 *    refused a valid flip when the old lead plus the incoming title overflowed the tsvector cap.
 *  - Why existing coverage misses it: no flip case has a long lead. The overflowing flip itself is out of reach here
 *    (a title near the cap is refused by the SQL engines' `lower(title)` index first); the Rust unit tests of
 *    page_body.rs cover it.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SegmentTextInput } from '../../src/core/page-body/types.ts';
import { bodyColumns, flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'notes/flip';
const ONE = segmentText('# Intro\nfirst segment of the page\n');
const TWO = segmentText('## Middle\nsecond segment of the page\n');
/** A 65,536-character lead (what the trigger reads of it): ~9,000 distinct tokens, ~100 KB of vector. */
const LONG_LEAD = Array.from({ length: 9_000 }, (_, i) => `lead${i.toString(36)}z`).join(' ').slice(0, 65_536);

/** Stage `text` as one manifest row of a new staging at `genFrom` (separate calls, no outer transaction). */
async function stageRow(engine: BrainEngine, input: { pageId: number; genFrom: number; text: SegmentTextInput; occurrence: number; seq: number; byteStart: number }) {
  const staging = stagingInput({ slug: SLUG, pageId: input.pageId, mode: input.genFrom === 1 ? 'create' : 'replace',
    baseGeneration: input.genFrom === 1 ? null : input.genFrom - 1 });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', [input.text], { stagingId: staging.id });
  await engine.stageManifestRows([manifestRow({ pageId: input.pageId, occurrenceId: input.occurrence, genFrom: input.genFrom, seq: input.seq,
    text: input.text, byteStart: input.byteStart, stagingId: staging.id })]);
  return staging.id;
}

describe('flipBodyGeneration and the page search vector', () => {
  parityTest(
    'a flip from a long lead to a short one is accepted and the page is found by the incoming title and lead only',
    { methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'flipBodyGeneration', 'sealSegmentedPage', 'searchTitles'] },
    async (engine) => {
      const { id: pageId } = await engine.createSegmentedPageShell(SLUG, pageMeta('Small title'), { sourceId: 'default' });
      const [one, two] = await engine.allocateBodyOccurrenceIds(2);
      const found = async (query: string) => (await engine.searchTitles(query, { limit: 10 })).map((r) => r.slug);
      const first = await stageRow(engine, { pageId, genFrom: 1, text: ONE, occurrence: one!, seq: 0, byteStart: 0 });
      await engine.flipBodyGeneration(flipInput(pageId, 0, first, [ONE], {
        body: bodyColumns([ONE], { timeline_lead: LONG_LEAD }), meta: pageMeta('Small title'),
      }));
      await engine.sealSegmentedPage(pageId);
      const before = { oldLead: await found('lead5z'), title: await found('quillfeather') };
      const second = await stageRow(engine, { pageId, genFrom: 2, text: TWO, occurrence: two!, seq: 1, byteStart: ONE.body.byteLength });
      await engine.flipBodyGeneration(flipInput(pageId, 1, second, [ONE, TWO], {
        body: bodyColumns([ONE, TWO], { timeline_lead: 'short lead zephyrwinds' }), meta: pageMeta('Quillfeather title'),
      }));
      await engine.sealSegmentedPage(pageId);
      const after = { oldLead: await found('lead5z'), title: await found('quillfeather'), newLead: await found('zephyrwinds') };
      expect(after).toEqual({ oldLead: [], title: [SLUG], newLead: [SLUG] });
      return { before, after };
    },
  );
});
