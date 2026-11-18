/**
 * BrainEngine parity — the source-resolution reads (`listLocalPathSources`, `listSourceRoutingRows`,
 * `countDefaultSourceSplit`, `listAllSources`, `getSource`, `listSourceRecords`) that `src/core/source-resolver.ts`
 * and the other `sources` readers make to pick a source or list the registered ones.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm answers the same rows: sources with a checkout path keep their archived flag; every
 *    source row carries its config, archived flag and whether `default` holds a live page; the default-write guard's
 *    split counts live pages only and counts distinct non-default sources; `listAllSources` hides archived sources
 *    unless asked, orders `default` first then by id, and its local-path filter also drops the storage manifest;
 *    `getSource` still finds an archived source; `listSourceRecords` keeps archived sources with their flag.
 *  - Regression: an engine that drops archived sources from tier 4 (a cwd inside an archived checkout then falls
 *    through silently instead of refusing), counts soft-deleted pages (the guard then nags or routes a write to the
 *    wrong source), or counts pages instead of sources in `nonDefaultSources`; an engine that lists archived sources
 *    by default (a removed source comes back in `sources list`, doctor and the resolver's existence checks).
 *  - Why existing coverage misses it: test/source-resolver*.test.ts drive the resolver through fake engines keyed on
 *    SQL text, so they never compare real engines, and the Rust engine has no raw SQL to answer.
 *  - Seam: none. Real engines, typed reads only; sources are made and archived through the harness fixtures.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE: PageInput = { type: 'note', title: 'Note', compiled_truth: 'A short note.' };

async function seed(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<void> {
  for (const slug of slugs) await engine.putPage(slug, NOTE, { sourceId });
}

describe('engine parity: source-resolution reads', () => {
  parityTest('listLocalPathSources keeps archived sources and drops sources without a path', { methods: ['listLocalPathSources'] }, async (engine, backend) => {
    const empty = await engine.listLocalPathSources();
    expect(empty).toEqual([]);
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await createSource(engine, backend, 'nopath');
    await archiveSource(engine, backend, 'beta');
    const rows = sorted(await engine.listLocalPathSources(), (r) => r.id);
    expect(rows).toEqual([
      { id: 'alpha', local_path: '/srv/brain/alpha', archived: false },
      { id: 'beta', local_path: '/srv/brain/beta', archived: true },
    ]);
    return { empty, rows };
  });

  parityTest('listSourceRoutingRows carries config, archived and whether default has a live page', { methods: ['listSourceRoutingRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki', { role: 'storage_manifest' }, '/srv/brain/wiki');
    await createSource(engine, backend, 'old');
    await archiveSource(engine, backend, 'old');
    await seed(engine, 'wiki', ['notes/a']);
    const before = await engine.listSourceRoutingRows();
    expect(before.map((r) => r.id)).toEqual(['default', 'old', 'wiki']);
    expect(before.every((r) => r.default_has_pages === false)).toBe(true);
    await seed(engine, 'default', ['notes/d']);
    const withDefault = (await engine.listSourceRoutingRows()).map((r) => r.default_has_pages);
    await engine.softDeletePage('notes/d', { sourceId: 'default' });
    const afterDelete = (await engine.listSourceRoutingRows()).map((r) => r.default_has_pages);
    expect(withDefault).toEqual([true, true, true]);
    expect(afterDelete).toEqual([false, false, false]);
    return { before, withDefault, afterDelete };
  });

  parityTest('countDefaultSourceSplit counts live pages and distinct non-default sources', { methods: ['countDefaultSourceSplit'] }, async (engine, backend) => {
    const empty = await engine.countDefaultSourceSplit();
    expect(empty).toEqual({ defaultPages: 0, nonDefaultPages: 0, nonDefaultSources: 0 });
    await createSource(engine, backend, 'aa');
    await createSource(engine, backend, 'bb');
    await seed(engine, 'default', ['d1', 'd2']);
    await seed(engine, 'aa', ['x', 'y']);
    await seed(engine, 'bb', ['z']);
    const full = await engine.countDefaultSourceSplit();
    expect(full).toEqual({ defaultPages: 2, nonDefaultPages: 3, nonDefaultSources: 2 });
    await engine.softDeletePage('z', { sourceId: 'bb' });
    await engine.softDeletePage('d2', { sourceId: 'default' });
    const live = await engine.countDefaultSourceSplit();
    expect(live).toEqual({ defaultPages: 1, nonDefaultPages: 2, nonDefaultSources: 1 });
    return { empty, full, live };
  });

  parityTest('listAllSources hides archived sources unless asked, default first then by id', { methods: ['listAllSources'] }, async (engine, backend) => {
    await createSource(engine, backend, 'zeta', { keep: 1 }, '/srv/brain/zeta');
    await createSource(engine, backend, 'alpha');
    await createSource(engine, backend, 'manifest', { role: 'storage_manifest' }, '/srv/brain/manifest');
    await createSource(engine, backend, 'gone', {}, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const view = (rows: Awaited<ReturnType<BrainEngine['listAllSources']>>) =>
      rows.map((r) => ({ id: r.id, name: r.name, local_path: r.local_path, config: r.config, synced: r.last_sync_at !== null }));
    const live = view(await engine.listAllSources());
    const all = view(await engine.listAllSources({ includeArchived: true }));
    const localOnly = (await engine.listAllSources({ localPathOnly: true })).map((r) => r.id);
    const localAll = (await engine.listAllSources({ includeArchived: true, localPathOnly: true })).map((r) => r.id);
    expect(live.map((r) => r.id)).toEqual(['default', 'alpha', 'manifest', 'zeta']);
    expect(all.map((r) => r.id)).toEqual(['default', 'alpha', 'gone', 'manifest', 'zeta']);
    expect(localOnly).toEqual(['zeta']);
    expect(localAll).toEqual(['gone', 'zeta']);
    expect(live[3]).toEqual({ id: 'zeta', name: 'zeta', local_path: '/srv/brain/zeta', config: { keep: 1 }, synced: false });
    return { live, all, localOnly, localAll };
  });

  parityTest('getSource finds an archived source; listSourceRecords keeps it with its archived flag', { methods: ['getSource', 'listSourceRecords'] }, async (engine, backend) => {
    await createSource(engine, backend, 'gone', { keep: 3 }, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const gone = await engine.getSource('gone');
    expect(gone).toMatchObject({ id: 'gone', local_path: '/srv/brain/gone', config: { keep: 3 } });
    const records = await engine.listSourceRecords();
    expect(records.map((r) => [r.id, r.archived ?? false])).toEqual([['default', false], ['gone', true]]);
    const created = records.map((r) => r.created_at instanceof Date && Number.isFinite(r.created_at.getTime()));
    expect(created).toEqual([true, true]);
    return { gone: gone && { id: gone.id, local_path: gone.local_path, config: gone.config }, archived: records.map((r) => r.archived ?? false), created };
  });
});
