/**
 * BrainEngine parity — the source-resolution reads (`listLocalPathSources`, `listSourceRoutingRows`,
 * `countDefaultSourceSplit`, `listAllSources`, `getSource`, `listSourceRecords`, `listStaleSyncSourceIds`, `readSourceRow`,
 * `lockSourceRow`, `readSourceChunkerVersion`) that `src/core/source-resolver.ts`
 * and the other `sources` readers make to pick a source or list the registered ones.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm answers the same rows: sources with a checkout path keep their archived flag; every
 *    source row carries its config, archived flag and whether `default` holds a live page; the default-write guard's
 *    split counts live pages only and counts distinct non-default sources; `listAllSources` hides archived sources
 *    unless asked, orders `default` first then by id, and its local-path filter also drops the storage manifest;
 *    `getSource` still finds an archived source; `listSourceRecords` keeps archived sources with their flag; a config
 *    stored as a JSON string (a historical double-encoded row) reads as no keys, as `config->>'kind'` did; the advisor's
 *    stale-sync read lists live sources last synced over seven days ago, by id; one source's check row (plain or read FOR
 *    UPDATE) carries its path, raw config and archived flag, archived sources included, and null for an unknown id; the
 *    sync preflight reads the source's stamped chunker version, null before the first stamp.
 *  - Regression: an engine that drops archived sources from tier 4 (a cwd inside an archived checkout then falls
 *    through silently instead of refusing), counts soft-deleted pages (the guard then nags or routes a write to the
 *    wrong source), or counts pages instead of sources in `nonDefaultSources`; an engine that lists archived sources
 *    by default (a removed source comes back in `sources list`, doctor and the resolver's existence checks); a reader
 *    that parses a JSON-string config (a broken row then counts as a connector source in orphans and connector holds);
 *    a stale-sync read that lists archived or never-synced sources, or uses the wrong interval (the advisor then nags);
 *    a check row that hides archived sources or parses the config (record-origin, guest init and the anchor-ownership
 *    check then misjudge the source); a chunker-version read of the wrong column (every sync then reimports in full).
 *  - Why existing coverage misses it: test/source-resolver*.test.ts drive the resolver through fake engines keyed on
 *    SQL text, so they never compare real engines, and the Rust engine has no raw SQL to answer.
 *  - Seam: none. Real engines, typed reads only; sources are made and archived through the harness fixtures.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { loadConnectorSourceIds } from '../../src/commands/orphans.ts';
import { sourceConfigText, sourceRecordsRawConfig } from '../../src/core/source-rows.ts';

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

  // The Rust store keeps a source config as a JSON object, so it cannot hold a JSON-string config; its arm writes `{}`,
  // which reads as no keys too, and both arms must answer the same.
  parityTest('a config stored as a JSON string reads as no keys, as config->>\'kind\' did', { methods: ['listSourceRecords'] }, async (engine, backend) => {
    await createSource(engine, backend, 'mail', { kind: 'google' });
    if (backend === 'rust') await createSource(engine, backend, 'twice', {});
    else await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb)`, ['twice', JSON.stringify(JSON.stringify({ kind: 'google' }))]);
    const kinds = (await sourceRecordsRawConfig(engine)).map((r) => [r.id, sourceConfigText(r.config, 'kind')]);
    expect(kinds).toEqual([['default', null], ['mail', 'google'], ['twice', null]]);
    const connectors = [...await loadConnectorSourceIds(engine)].sort();
    expect(connectors).toEqual(['mail']);
    return { kinds, connectors };
  });

  // The engines compare with their own clock: PGLite and Postgres with the database's `now()`, the Rust store with the
  // process clock. The fixture keeps every sync far from the seven-day edge, so both clocks answer the same.
  parityTest('listStaleSyncSourceIds lists live sources last synced over seven days ago, by id', { methods: ['listStaleSyncSourceIds'] }, async (engine, backend) => {
    const none = await engine.listStaleSyncSourceIds();
    expect(none).toEqual([]);
    const syncedDaysAgo = async (id: string, days: number | null) => {
      await createSource(engine, backend, id);
      if (days === null) return;
      if (backend === 'rust') {
        const at = new Date(Date.now() - days * 86_400_000).toISOString();
        await (engine as unknown as RustEngine).openStore('setLastSync').brain.upsertSource({ id, last_sync_at: at });
      } else {
        await engine.executeRaw(`UPDATE sources SET last_sync_at = now() - make_interval(days => $2::int) WHERE id = $1`, [id, days]);
      }
    };
    await syncedDaysAgo('old', 30);
    await syncedDaysAgo('early', 8);
    await syncedDaysAgo('recent', 6);
    await syncedDaysAgo('never', null);
    await syncedDaysAgo('gone', 30);
    await archiveSource(engine, backend, 'gone');
    const stale = await engine.listStaleSyncSourceIds();
    expect(stale).toEqual(['early', 'old']);
    return { none, stale };
  });

  parityTest('readSourceRow and lockSourceRow read one source\'s path, raw config and archived flag', { methods: ['readSourceRow', 'lockSourceRow'] }, async (engine, backend) => {
    await createSource(engine, backend, 'web', { kind: 'url', remote_url: 'https://example.com/repo.git' }, '/srv/brain/web');
    await createSource(engine, backend, 'gone', { keep: 2 }, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    await createSource(engine, backend, 'bare');
    const ids = ['web', 'gone', 'bare', 'missing'];
    const plain = [];
    const locked = [];
    for (const id of ids) plain.push(await engine.readSourceRow(id));
    for (const id of ids) locked.push(await engine.lockSourceRow(id));
    expect(plain).toEqual([
      { id: 'web', local_path: '/srv/brain/web', config: { kind: 'url', remote_url: 'https://example.com/repo.git' }, archived: false },
      { id: 'gone', local_path: '/srv/brain/gone', config: { keep: 2 }, archived: true },
      { id: 'bare', local_path: null, config: {}, archived: false },
      null,
    ]);
    expect(locked).toEqual(plain);
    return { plain, locked };
  });

  // The Rust store keeps no per-source chunker stamp, so its arm stops on the typed chunks refusal at the first read.
  parityTest('readSourceChunkerVersion reads the stamped chunker version, null before the first stamp', { methods: ['readSourceChunkerVersion'] }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    const before = [await engine.readSourceChunkerVersion('wiki'), await engine.readSourceChunkerVersion('missing')];
    expect(before).toEqual([null, null]);
    await engine.executeRaw('UPDATE sources SET chunker_version = $1 WHERE id = $2', ['7', 'wiki']);
    const after = await engine.readSourceChunkerVersion('wiki');
    expect(after).toEqual('7');
    return { before, after };
  });
});
