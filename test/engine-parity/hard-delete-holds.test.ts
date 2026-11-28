/**
 * BrainEngine parity — the write-gate holds a page hard delete drops (src/core/engine-sql/pages.ts deletePages and
 * purgeDeletedPages, through scrubPurgedSlugHolds), and the single deletePage that keeps them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: deletePages drops every hold of each deleted page's slug in its source, with the receipts of those holds;
 *    purgeDeletedPages drops only the holds last seen up to the page's soft delete, so a hold that arrived after it stays;
 *    the single deletePage leaves the holds and their receipts in place. A slug with no page, another page's slug and another
 *    source keep theirs. Same answer and the same rows left on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a Rust brain kept a hard-deleted page's holds and receipts, so the held content of a page that no longer
 *    exists stayed in the review queue, and a later page at the slug inherited holds it never had.
 *  - Why existing coverage misses it: purge-slug-stores.test.ts calls deletePurgedSlugHolds directly, and
 *    test/page-purge*.test.ts run on the SQL engines only.
 *  - Seam: every hold is unbound on every arm (no page id, no candidate pages), so the three arms judge the same slug rule:
 *    the SQL engines bind a hold to the page at its slug when either is written, so the SQL arms clear that bind through
 *    `executeRaw` (harness-only SQL behind the backend switch); the Rust store keeps holds by slug alone. Each case reads
 *    the holds back and asserts they are unbound before it deletes anything. Ids and times are never compared.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other-src';
const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, frontmatter: {} });

/**
 * Fixture: one unbound hold of `slug` with one receipt. The SQL engines bind a new hold to the page at its slug; the SQL arms
 * clear that bind (harness-only SQL), so the hold matches by slug as the Rust store's holds do. Returns the hold id.
 */
async function seedUnboundHold(engine: BrainEngine, backend: ParityBackend, sourceId: string, slug: string, fingerprint: string): Promise<number> {
  const id = await engine.upsertWriteGateHold({
    kind: 'fact', source_id: sourceId, slug, fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'],
    reasons: ['ignore previous instructions'], detector_error: false, payload: { fact: fingerprint, kind: 'preference' }, write_origin: null, request_id: null,
  });
  switch (backend) {
    case 'rust':
      break;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw('UPDATE write_gate_holds SET page_id = NULL, page_candidates = NULL WHERE id = $1', [id]);
      break;
  }
  await engine.upsertWriteGateReceipt({
    target_table: 'write_gate_holds', target_id: String(id), source_id: sourceId, content_hash: `h-${fingerprint}`, tier: 'agent_written',
    detector_version: 1, verdict: 'flag', reason_families: ['prompt_injection'], reasons: ['x'], detector_error: false, request_id: null,
  });
  return id;
}

/** Every hold as `source/slug/fingerprint` (the fixture writes the fingerprint into the payload, which the row returns) with its binding and receipt count, sorted. */
async function holdsLeft(engine: BrainEngine): Promise<Array<{ hold: string; page_id: number | null; page_candidates: number[] | null; receipts: number }>> {
  const rows = await engine.listWriteGateHoldRows({ status: 'all', limit: 100 });
  const out = [];
  for (const r of rows) {
    const receipts = await engine.listWriteGateReceiptsFor('write_gate_holds', String(r.id), 100);
    out.push({ hold: `${r.source_id}/${r.slug}/${String(r.payload.fact)}`, page_id: r.page_id, page_candidates: r.page_candidates, receipts: receipts.length });
  }
  return out.sort((a, b) => a.hold.localeCompare(b.hold));
}

/** Asserts the seeded holds are all unbound (no page id, no candidates) and returns their names. */
async function assertUnbound(engine: BrainEngine): Promise<string[]> {
  const holds = await holdsLeft(engine);
  expect(holds.filter(h => h.page_id !== null || h.page_candidates !== null)).toEqual([]);
  return holds.map(h => h.hold);
}

const left = (holds: Awaited<ReturnType<typeof holdsLeft>>) => holds.map(h => ({ hold: h.hold, receipts: h.receipts }));

describe('engine parity: a hard delete drops the page\'s write-gate holds', () => {
  parityTest(
    'deletePages drops the deleted slug\'s holds and their receipts, in its source only',
    { methods: ['deletePages', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      for (const [src, slug] of [[SRC, 'notes/gone'], [SRC, 'notes/kept'], [OTHER, 'notes/gone']] as const) {
        await engine.putPage(slug, note(slug), { sourceId: src });
      }
      await seedUnboundHold(engine, backend, SRC, 'notes/gone', 'fp-1');
      await seedUnboundHold(engine, backend, SRC, 'notes/gone', 'fp-2');
      await seedUnboundHold(engine, backend, SRC, 'notes/kept', 'fp-3');
      await seedUnboundHold(engine, backend, OTHER, 'notes/gone', 'fp-4');
      // A hold whose slug has no page: deletePages names no page there, so it stays.
      await seedUnboundHold(engine, backend, SRC, 'notes/never', 'fp-5');
      const seeded = await assertUnbound(engine);
      const out = {
        seeded,
        deleted: await engine.deletePages(['notes/gone', 'notes/never'], { sourceId: SRC }),
        left: left(await holdsLeft(engine)),
      };
      expect(out).toEqual({
        seeded: ['default/notes/gone/fp-1', 'default/notes/gone/fp-2', 'default/notes/kept/fp-3', 'default/notes/never/fp-5', 'other-src/notes/gone/fp-4'],
        deleted: ['notes/gone'],
        left: [
          { hold: 'default/notes/kept/fp-3', receipts: 1 },
          { hold: 'default/notes/never/fp-5', receipts: 1 },
          { hold: 'other-src/notes/gone/fp-4', receipts: 1 },
        ],
      });
      return out;
    },
  );

  parityTest(
    'purgeDeletedPages drops the holds last seen up to the soft delete and keeps one that arrived after it',
    { methods: ['purgeDeletedPages', 'softDeletePage', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      for (const [src, slug] of [[SRC, 'notes/gone'], [SRC, 'notes/live'], [OTHER, 'notes/gone']] as const) {
        await engine.putPage(slug, note(slug), { sourceId: src });
      }
      await seedUnboundHold(engine, backend, SRC, 'notes/gone', 'fp-before');
      await seedUnboundHold(engine, backend, SRC, 'notes/live', 'fp-live');
      await seedUnboundHold(engine, backend, OTHER, 'notes/gone', 'fp-other');
      await engine.softDeletePage('notes/gone', { sourceId: SRC });
      await new Promise(r => setTimeout(r, 50));
      // Seen after the soft delete: the purge's deletedAt cut-off keeps it.
      await seedUnboundHold(engine, backend, SRC, 'notes/gone', 'fp-after');
      await new Promise(r => setTimeout(r, 50));
      const seeded = await assertUnbound(engine);
      const purged = await engine.purgeDeletedPages(0);
      const out = { seeded, purged: { slugs: purged.slugs, count: purged.count }, left: left(await holdsLeft(engine)) };
      expect(out).toEqual({
        seeded: ['default/notes/gone/fp-after', 'default/notes/gone/fp-before', 'default/notes/live/fp-live', 'other-src/notes/gone/fp-other'],
        purged: { slugs: ['notes/gone'], count: 1 },
        left: [
          { hold: 'default/notes/gone/fp-after', receipts: 1 },
          { hold: 'default/notes/live/fp-live', receipts: 1 },
          { hold: 'other-src/notes/gone/fp-other', receipts: 1 },
        ],
      });
      return out;
    },
  );

  parityTest(
    'the single deletePage leaves the page\'s holds and their receipts in place',
    { methods: ['deletePage', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor'] },
    async (engine, backend) => {
      await engine.putPage('notes/single', note('notes/single'));
      await seedUnboundHold(engine, backend, SRC, 'notes/single', 'fp-s1');
      await seedUnboundHold(engine, backend, SRC, 'notes/single', 'fp-s2');
      const seeded = await assertUnbound(engine);
      await engine.deletePage('notes/single');
      const out = { seeded, page: await engine.getPage('notes/single'), left: left(await holdsLeft(engine)) };
      expect(out).toEqual({
        seeded: ['default/notes/single/fp-s1', 'default/notes/single/fp-s2'],
        page: null,
        left: [
          { hold: 'default/notes/single/fp-s1', receipts: 1 },
          { hold: 'default/notes/single/fp-s2', receipts: 1 },
        ],
      });
      return out;
    },
  );
});
