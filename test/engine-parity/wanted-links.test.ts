/**
 * BrainEngine parity — the wanted-link writes the extract path ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: lockRegisteredSourceIds and replaceWantedLinkRows return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), and the wanted rows they
 *    leave read back the same through the store's `listWantedPages` read (SQL on the SQL arms).
 *  - Regression: an engine that writes wanted rows differently changes which missing targets `gbrain wanted` lists,
 *    how many pages reference each, which bare names match an existing page and which origins stale extraction
 *    re-reads; the Rust engine has no SQL, so the writes have to exist as typed methods it can implement.
 *  - Why existing coverage misses it: wanted-links-store.ts ran these statements through `executeRaw`, which the
 *    parity cases cannot call (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: `readWanted` below reads the rows back through the store's `listWantedPages` helper (it uses `executeRaw`, so
 *    the Rust arm stops on that typed refusal there; its own read member arrives with the engine member that replaces it). Generated
 *    values (first_seen, now() check times) are compared by shape or by a relation, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { rethrowCapabilityRefusal } from '../../src/core/engine-capability-refusal.ts';
import type { BrainEngine, WantedLinkRowInput } from '../../src/core/engine.ts';
import { listWantedPages, type WantedPageRow } from '../../src/core/wanted-links-store.ts';

const { parityTest } = parityArms(testBackends());

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const READ_AT = '2026-01-02T03:04:05.678Z';

type WantedQuery = { sourceId?: string; sourceIds?: string[]; limit: number; offset: number };

async function readWanted(engine: BrainEngine, _backend: ParityBackend, query: WantedQuery = { limit: 50, offset: 0 }): Promise<{ total: number; rows: WantedPageRow[] }> {
  return listWantedPages(engine, query);
}

/** A row with its generated times replaced by their shape. */
function view(row: WantedPageRow) {
  expect(row.first_seen).toMatch(ISO_MS);
  const lastChecked = row.last_checked === 'pending' || row.last_checked === READ_AT ? row.last_checked : ISO_MS.test(row.last_checked) ? 'now' : row.last_checked;
  return { ...row, first_seen: 'iso', last_checked: lastChecked };
}

async function note(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<number> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId });
  return Number(page.id);
}

function wanted(producer: 'body' | 'frontmatter', ref_kind: 'slug' | 'name', target_ref: string, link_type = '', target_source_id = 'default'): WantedLinkRowInput {
  return { producer, ref_kind, target_source_id, target_ref, link_type, context: `ctx ${target_ref}` };
}

describe('engine parity: wanted links', () => {
  parityTest('lockRegisteredSourceIds keeps the registered ids, sorted, once each', { methods: ['lockRegisteredSourceIds'] }, async (engine, backend) => {
    await createSource(engine, backend, 'zeta');
    await createSource(engine, backend, 'alpha');
    const ids = await engine.lockRegisteredSourceIds(['zeta', 'no-such-source', 'alpha', 'zeta', 'default']);
    expect(ids).toEqual(['alpha', 'default', 'zeta']);
    const empty = await engine.lockRegisteredSourceIds([]);
    expect(empty).toEqual([]);
    return { ids, empty };
  });

  parityTest('replaceWantedLinkRows inserts, updates in place and deletes only the named producers', { methods: ['replaceWantedLinkRows'] }, async (engine, backend) => {
    const origin = { pageId: await note(engine, 'notes/a'), sourceId: 'default' };
    const first = await engine.replaceWantedLinkRows(origin, {
      rows: [wanted('body', 'slug', 'missing/x', 'mentions'), wanted('body', 'name', 'Ghost'), wanted('frontmatter', 'slug', 'missing/y', 'parent')],
      producers: ['body', 'frontmatter'], readAt: READ_AT,
    });
    expect(first).toBe(3);
    const before = await readWanted(engine, backend);
    const seenBefore = before.rows.find(r => r.target === 'missing/x')?.first_seen;
    const second = await engine.replaceWantedLinkRows(origin, { rows: [wanted('body', 'slug', 'missing/x', 'cites')], producers: ['body'], readAt: READ_AT });
    expect(second).toBe(1);
    const none = await engine.replaceWantedLinkRows(origin, { rows: [wanted('body', 'slug', 'ignored')], producers: [] });
    expect(none).toBe(0);
    const after = await readWanted(engine, backend);
    expect(after.rows.map(r => r.target)).toEqual(['missing/x', 'missing/y']);
    const x = after.rows.find(r => r.target === 'missing/x');
    expect(x?.first_seen).toBe(seenBefore);
    expect(x?.link_types).toEqual(['cites']);
    return { first, second, none, before: { total: before.total, rows: before.rows.map(view) }, after: { total: after.total, rows: after.rows.map(view) }, firstSeenKept: x?.first_seen === seenBefore };
  });

  parityTest('replaceWantedLinkRows marks a live slug target pending; a bare name lists its basename matches', { methods: ['replaceWantedLinkRows'] }, async (engine, backend) => {
    await note(engine, 'notes/b');
    await note(engine, 'people/c');
    await note(engine, 'topics/c');
    const origin = { pageId: await note(engine, 'notes/a'), sourceId: 'default' };
    const written = await engine.replaceWantedLinkRows(origin, {
      rows: [wanted('body', 'slug', 'notes/b'), wanted('frontmatter', 'name', 'c', 'works_at')], producers: ['body', 'frontmatter'], readAt: READ_AT,
    });
    const live = await readWanted(engine, backend);
    expect(live.rows.map(r => r.target)).toEqual(['c']);
    expect(live.rows[0]?.existing_matches).toEqual([{ slug: 'people/c', source_id: 'default' }, { slug: 'topics/c', source_id: 'default' }]);
    await engine.deletePage('notes/b');
    const gone = await readWanted(engine, backend);
    const b = gone.rows.find(r => r.target === 'notes/b');
    expect(b?.last_checked).toBe('pending');
    return { written, live: live.rows.map(view), gone: { total: gone.total, rows: gone.rows.map(view) } };
  });

  parityTest('wanted rows count live origins only, rank by references and honour scope and paging', { methods: ['replaceWantedLinkRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const slugRow = (target: string) => ({ rows: [wanted('body', 'slug', target, 'mentions')], producers: ['body' as const], readAt: READ_AT });
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await engine.replaceWantedLinkRows({ pageId: await note(engine, slug), sourceId: 'default' }, slugRow('missing/z'));
    await engine.replaceWantedLinkRows({ pageId: await note(engine, 'notes/d'), sourceId: 'default' }, slugRow('missing/w'));
    await engine.replaceWantedLinkRows({ pageId: await note(engine, 'notes/w', 'work'), sourceId: 'work' }, slugRow('missing/v'));
    const all = await readWanted(engine, backend);
    expect(all.rows.map(r => [r.target, r.referenced_by])).toEqual([['missing/z', 3], ['missing/v', 1], ['missing/w', 1]]);
    await engine.softDeletePage('notes/b');
    const afterDelete = await readWanted(engine, backend);
    expect(afterDelete.rows[0]?.referenced_by).toBe(2);
    expect(afterDelete.rows[0]?.sample_origins).toEqual([{ slug: 'notes/a', source_id: 'default' }, { slug: 'notes/c', source_id: 'default' }]);
    const work = await readWanted(engine, backend, { sourceId: 'work', limit: 50, offset: 0 });
    const scoped = await readWanted(engine, backend, { sourceIds: ['default'], limit: 1, offset: 1 });
    expect(work.rows.map(r => r.target)).toEqual(['missing/v']);
    expect({ total: scoped.total, targets: scoped.rows.map(r => r.target) }).toEqual({ total: 2, targets: ['missing/w'] });
    return {
      all: all.rows.map(view), afterDelete: afterDelete.rows.map(view),
      work: { total: work.total, rows: work.rows.map(view) }, scoped: { total: scoped.total, rows: scoped.rows.map(view) },
    };
  });

  parityTest('replaceWantedLinkRows refuses a repeated reference and a missing origin page', { methods: ['replaceWantedLinkRows'] }, async (engine) => {
    const pageId = await note(engine, 'notes/a');
    const outcome = async (run: () => Promise<number>) => run().then(n => ({ written: n }), (err: unknown) => { rethrowCapabilityRefusal(err); return { threw: true }; });
    const repeated = await outcome(() => engine.replaceWantedLinkRows({ pageId, sourceId: 'default' }, {
      rows: [wanted('body', 'slug', 'missing/x'), wanted('body', 'slug', 'missing/x')], producers: ['body'],
    }));
    const missing = await outcome(() => engine.replaceWantedLinkRows({ pageId: pageId + 1000, sourceId: 'default' }, {
      rows: [wanted('body', 'slug', 'missing/x')], producers: ['body'],
    }));
    expect({ repeated, missing }).toEqual({ repeated: { threw: true }, missing: { threw: true } });
    return { repeated, missing };
  });
});
