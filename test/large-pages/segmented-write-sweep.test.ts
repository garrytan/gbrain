/**
 * #9213 sweep, below the 24 MiB ceiling: every write that can target an existing page, run against a page stored in
 * segments under every credential binding, reads only what it needs.
 *
 * 1. Protects: a label check (visibility, readers, folder rules, scope sharing) never touches the body of a page stored
 *    in segments, so on a 1.3 MB segmented page no op refuses page_body_segmented under any binding (local CLI, unbound
 *    token, member-bound, owner-bound, attested for the memory ops), except revert_version, which refuses every
 *    segmented page by design; a dispatched write refused page_body_segmented never hands back the get_page read fix.
 * 2. Fails when: a write or access-check path spreads, stringifies or copies a page loaded with guardSegmentedBody's
 *    throwing getters (rowToPage.compiled_truth), or a new mutating op joins the registry without being classified in
 *    test/helpers/segmented-write-sweep.ts.
 * 3. Existing coverage: test/remember-segmented-entity-9213.test.ts pins the remember and scope-page cases with their
 *    stored facts; segmented-write-sweep-over-ceiling.slow.test.ts runs the same ops over the ceiling.
 * 4. Real seams: the operation registry, OAuth client-credentials tokens, MCP dispatch as remote and local callers, a
 *    repo-less brain, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations } from '../../src/core/operations.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { NO_PAGE_TARGET, PAGE_OPS, SEGMENTED_LINES, SRC, openSweepBrain, outcome, pageBody, type Outcome, type SweepBrain } from '../helpers/segmented-write-sweep.ts';

const SWEEP_MS = 900_000;
/** Ops whose every binding is refused for a reason of their own. */
const NOT_REACHED: Record<string, string> = {
  revert_version: 'refuses every segmented page by design (page_body_segmented, reason segmented_revert)',
};

describe('the sweep classifies every mutating op in the registry', () => {
  test('each mutating op is a page op or names why it loads no page; no stale names, no overlap', () => {
    const mutating = operations.filter(o => o.mutating).map(o => o.name).sort();
    const classified = [...Object.keys(PAGE_OPS), ...Object.keys(NO_PAGE_TARGET)];
    expect(mutating.filter(name => !classified.includes(name))).toEqual([]);
    expect(classified.filter(name => !mutating.includes(name))).toEqual([]);
    expect(Object.keys(PAGE_OPS).filter(name => name in NO_PAGE_TARGET)).toEqual([]);
  });
});

for (const kind of testBackends()) {
  describe('writes on a segmented page below the ceiling (' + kind + ', repo-less, #9213 sweep)', () => {
    let brain: SweepBrain;
    beforeAll(async () => { brain = await openSweepBrain(kind); }, SWEEP_MS);
    afterAll(async () => { await brain?.close(); }, SWEEP_MS);

    /** A live page stored in segments at slug: imported when it is missing, deleted or no longer segmented. */
    async function segmentedPage(slug: string): Promise<void> {
      const row = await brain.storage(slug);
      if (!row || row.deleted || row.body_storage !== 'segmented') {
        if (row?.deleted) await brain.call('local', 'restore_page', { slug, expected_revision: await brain.revision(slug) });
        await importFromContent(brain.engine, slug, pageBody(SEGMENTED_LINES, 'Acme Example'), { sourceId: SRC });
      }
      const after = await brain.storage(slug);
      expect({ slug, storage: after?.body_storage, deleted: after?.deleted }).toEqual({ slug, storage: 'segmented', deleted: false });
    }

    test('no op refuses page_body_segmented under any binding, and each op lands for some binding', async () => {
      const outcomes: Outcome[] = [];
      for (const [name, c] of Object.entries(PAGE_OPS)) {
        const slug = 'companies/sweep-' + name.replace(/_/g, '-');
        for (const who of c.who) {
          await segmentedPage(slug);
          outcomes.push(outcome(name, who, await c.run(brain, slug, who)));
        }
      }
      console.log('[sweep below ceiling] refusals ' + JSON.stringify(outcomes.filter(o => o.error).map(o => [o.op, o.who, o.error])));
      expect(outcomes.filter(o => o.getter)).toEqual([]);
      expect(outcomes.filter(o => o.segmented && !(o.op in NOT_REACHED))).toEqual([]);
      const landed = new Set(outcomes.filter(o => o.error === null).map(o => o.op));
      expect(Object.keys(PAGE_OPS).filter(name => !landed.has(name) && !(name in NOT_REACHED))).toEqual([]);
      expect(outcomes.filter(o => o.op === 'revert_version').map(o => [o.error, o.ceiling])).toEqual(PAGE_OPS.revert_version!.who.map(() => ['page_body_segmented', true]));
      expect(outcomes.filter(o => o.segmented && o.dispatched && o.readFix)).toEqual([]);
    }, SWEEP_MS);
  });
}
