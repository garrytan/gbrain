/**
 * BrainEngine parity — the source-resolution reads (`listLocalPathSources`, `countRepoBoundSources`, `listSourceRoutingRows`,
 * `countDefaultSourceSplit`, `listAllSources`, `getSource`, `listSourceRecords`, `listStaleSyncSourceIds`, `readSourceRow`,
 * `lockSourceRow`, `readSourceChunkerVersion`, `countSourcePages`, `insertSource`) that `src/core/source-resolver.ts`
 * and the other `sources` readers make to pick a source or list the registered ones.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm answers the same rows: sources with a checkout path keep their archived flag; the
 *    readiness sync probe counts only live sources with a non-empty path; every
 *    source row carries its config, archived flag and whether `default` holds a live page; the default-write guard's
 *    split counts live pages only and counts distinct non-default sources; `listAllSources` hides archived sources
 *    unless asked, orders `default` first then by id, and its local-path filter also drops the storage manifest;
 *    `getSource` still finds an archived source; `listSourceRecords` keeps archived sources with their flag; a config
 *    stored as a JSON string (a historical double-encoded row) reads as no keys, as `config->>'kind'` did; the advisor's
 *    stale-sync read lists live sources last synced over seven days ago, by id; one source's check row (plain or read FOR
 *    UPDATE) carries its path, raw config and archived flag, archived sources included, and null for an unknown id; the
 *    sync preflight reads the source's stamped chunker version, null before the first stamp; a source's page count keeps
 *    to that source and counts soft-deleted pages only when asked; `sources add` inserts a row with its name, path and
 *    config (a key set to undefined is dropped), and a taken id or name throws and leaves the first row as it was; the
 *    scope-source check of a remote recall (`withoutScopeSources`) drops exactly the sources whose config marks them.
 *  - Regression: an engine that drops archived sources from tier 4 (a cwd inside an archived checkout then falls
 *    through silently instead of refusing), counts soft-deleted pages (the guard then nags or routes a write to the
 *    wrong source), or counts pages instead of sources in `nonDefaultSources`; an engine that lists archived sources
 *    by default (a removed source comes back in `sources list`, doctor and the resolver's existence checks); a reader
 *    that parses a JSON-string config (a broken row then counts as a connector source in orphans and connector holds);
 *    a stale-sync read that lists archived or never-synced sources, or uses the wrong interval (the advisor then nags);
 *    a check row that hides archived sources or parses the config (record-origin, guest init and the anchor-ownership
 *    check then misjudge the source); a chunker-version read of the wrong column (every sync then reimports in full); a
 *    page count that leaks across sources with a shared id prefix or ignores the soft-delete filter (`sources list` and
 *    `sources remove` then report the wrong count); an insert that overwrites a taken id or name, or double-encodes
 *    the config into a JSON string (every config key then reads as absent).
 *  - Why existing coverage misses it: test/source-resolver*.test.ts drive the resolver through fake engines keyed on
 *    SQL text, so they never compare real engines, and the Rust engine has no raw SQL to answer.
 *  - Seam: none. Real engines, typed reads only; sources are made and archived through the harness fixtures.
 */
import { describe, expect } from 'bun:test';
import { markedScopeSources, withoutScopeSources } from '../../src/core/access/attest-sources.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { loadConnectorSourceIds } from '../../src/commands/orphans.ts';
import { sourceConfigText, sourceRecordsRawConfig } from '../../src/core/source-rows.ts';
import { ownerOnlySourcesPresent, sourceIsOwnerOnly } from '../../src/core/access/owner-only.ts';

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

  parityTest('readPlainSyncSource reads the path, last commit and config of a source that is not archived', { methods: ['readPlainSyncSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'plain', { kind: null, note: 'x' }, '/srv/brain/plain');
    await createSource(engine, backend, 'gone', {}, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const result = {
      plain: await engine.readPlainSyncSource('plain'),
      gone: await engine.readPlainSyncSource('gone'),
      missing: await engine.readPlainSyncSource('missing'),
      default: (await engine.readPlainSyncSource('default'))?.last_commit ?? null,
    };
    expect(result.plain?.local_path).toBe('/srv/brain/plain');
    expect(result.plain?.last_commit).toBeNull();
    expect(result.plain?.config as Record<string, unknown> | null | undefined).toEqual({ kind: null, note: 'x' });
    expect(result.gone).toBeNull();
    expect(result.missing).toBeNull();
    return result;
  });

  parityTest('readOwnerOnlySourcesPresent and readOwnerOnlySourceConfig find owner-only sources by kind or flag, archived ones included', { methods: ['readOwnerOnlySourcesPresent', 'readOwnerOnlySourceConfig'] }, async (engine, backend) => {
    const none = await engine.readOwnerOnlySourcesPresent();
    await createSource(engine, backend, 'plain', { note: 'x' });
    await createSource(engine, backend, 'flagstr', { owner_only: 'false' });
    const stillNone = await engine.readOwnerOnlySourcesPresent();
    await createSource(engine, backend, 'phone', { kind: 'imessage' });
    await archiveSource(engine, backend, 'phone');
    const archivedKind = await engine.readOwnerOnlySourcesPresent();
    await createSource(engine, backend, 'flag', { owner_only: true });
    const configs = {
      plain: await engine.readOwnerOnlySourceConfig('plain'),
      phone: await engine.readOwnerOnlySourceConfig('phone'),
      flag: await engine.readOwnerOnlySourceConfig('flag'),
      missing: await engine.readOwnerOnlySourceConfig('missing'),
    };
    const verdicts = {
      plain: await sourceIsOwnerOnly(engine, 'plain'),
      flagstr: await sourceIsOwnerOnly(engine, 'flagstr'),
      phone: await sourceIsOwnerOnly(engine, 'phone'),
      flag: await sourceIsOwnerOnly(engine, 'flag'),
      missing: await sourceIsOwnerOnly(engine, 'missing'),
      present: await ownerOnlySourcesPresent(engine),
    };
    expect([none, stillNone, archivedKind]).toEqual([false, false, true]);
    expect(configs.plain).toEqual({ config: { note: 'x' } });
    expect(configs.missing).toBeNull();
    expect(verdicts).toEqual({ plain: false, flagstr: false, phone: true, flag: true, missing: false, present: true });
    return { none, stillNone, archivedKind, configs, verdicts };
  });

  parityTest('countRepoBoundSources counts live sources with a non-empty local path', { methods: ['countRepoBoundSources'] }, async (engine, backend) => {
    const empty = await engine.countRepoBoundSources();
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await createSource(engine, backend, 'blank', {}, '');
    await createSource(engine, backend, 'nopath');
    await archiveSource(engine, backend, 'beta');
    const bound = await engine.countRepoBoundSources();
    expect({ empty, bound }).toEqual({ empty: 0, bound: 1 });
    return { empty, bound };
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

  parityTest('readSourceChunkerVersion reads the version setSourceChunkerVersion stamped, null before the first stamp', { methods: ['readSourceChunkerVersion', 'setSourceChunkerVersion'] }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'other');
    const before = [await engine.readSourceChunkerVersion('wiki'), await engine.readSourceChunkerVersion('missing')];
    expect(before).toEqual([null, null]);
    await engine.setSourceChunkerVersion('wiki', '7');
    const first = await engine.readSourceChunkerVersion('wiki');
    await engine.setSourceChunkerVersion('wiki', '8;lua=1');
    await engine.setSourceChunkerVersion('missing', '9');
    const after = {
      wiki: await engine.readSourceChunkerVersion('wiki'),
      other: await engine.readSourceChunkerVersion('other'),
      missing: await engine.readSourceChunkerVersion('missing'),
      sources: (await engine.listAllSources()).map(s => s.id).sort(),
    };
    expect({ first, after }).toEqual({ first: '7', after: { wiki: '8;lua=1', other: null, missing: null, sources: ['default', 'other', 'wiki'] } });
    return { before, first, after };
  });

  parityTest('writeSourceCommitAnchor advances one source\'s last commit, and its newest content time only when given', {
    methods: ['writeSourceCommitAnchor', 'writeSourceLocalPath', 'getSource', 'readPlainSyncSource', 'listSourceRecords'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'other');
    const view = async (id: string) => {
      const detail = await engine.getSource(id);
      const record = (await engine.listSourceRecords()).find(r => r.id === id);
      const newest = record?.newest_content_at == null ? null : new Date(record.newest_content_at).toISOString();
      return detail === null ? null : {
        last_commit: detail.last_commit, synced: detail.last_sync_at != null, local_path: detail.local_path,
        plain: (await engine.readPlainSyncSource(id))?.last_commit ?? null, newest,
      };
    };
    const before = await view('wiki');
    await engine.writeSourceCommitAnchor('wiki', 'c1', { newestContentAt: '2026-01-02T03:04:05.000Z' });
    const stamped = await view('wiki');
    await engine.writeSourceCommitAnchor('wiki', 'c2');
    const kept = await view('wiki');
    await engine.writeSourceCommitAnchor('wiki', 'c3', { newestContentAt: null });
    const cleared = await view('wiki');
    await engine.writeSourceLocalPath('wiki', '/srv/wiki');
    await engine.writeSourceCommitAnchor('missing', 'c9');
    await engine.writeSourceLocalPath('missing', '/srv/missing');
    const seen = { before, stamped, kept, cleared, repointed: await view('wiki'), other: await view('other'), missing: await view('missing') };
    expect(seen).toEqual({
      before: { last_commit: null, synced: false, local_path: null, plain: null, newest: null },
      stamped: { last_commit: 'c1', synced: true, local_path: null, plain: 'c1', newest: '2026-01-02T03:04:05.000Z' },
      kept: { last_commit: 'c2', synced: true, local_path: null, plain: 'c2', newest: '2026-01-02T03:04:05.000Z' },
      cleared: { last_commit: 'c3', synced: true, local_path: null, plain: 'c3', newest: null },
      repointed: { last_commit: 'c3', synced: true, local_path: '/srv/wiki', plain: 'c3', newest: null },
      other: { last_commit: null, synced: false, local_path: null, plain: null, newest: null },
      missing: null,
    });
    return seen;
  });

  parityTest('writeSourceSyncHeartbeat stamps one source\'s last sync and leaves its commit anchor alone', {
    methods: ['writeSourceSyncHeartbeat', 'writeSourceCommitAnchor', 'getSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'other');
    const view = async (id: string) => {
      const detail = await engine.getSource(id);
      return detail === null ? null : { last_commit: detail.last_commit, synced: detail.last_sync_at != null };
    };
    const before = await view('wiki');
    await engine.writeSourceSyncHeartbeat('wiki');
    const beat = await view('wiki');
    await engine.writeSourceCommitAnchor('wiki', 'c1');
    await engine.writeSourceSyncHeartbeat('wiki');
    await engine.writeSourceSyncHeartbeat('missing');
    const seen = { before, beat, anchored: await view('wiki'), other: await view('other'), missing: await view('missing') };
    expect(seen).toEqual({
      before: { last_commit: null, synced: false },
      beat: { last_commit: null, synced: true },
      anchored: { last_commit: 'c1', synced: true },
      other: { last_commit: null, synced: false },
      missing: null,
    });
    return seen;
  });

  parityTest('writeSourceUpstreamObservation records one source\'s upstream and leaves its sync anchor alone', {
    methods: ['writeSourceUpstreamObservation', 'writeSourceCommitAnchor', 'getSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'other');
    await engine.writeSourceCommitAnchor('wiki', 'c1');
    await engine.writeSourceUpstreamObservation('wiki', { checkedAt: '2026-01-02T03:04:05.000Z', commit: 'u1', behind: 2 });
    await engine.writeSourceUpstreamObservation('wiki', { checkedAt: '2026-01-03T03:04:05.000Z', commit: 'u2', behind: null });
    await engine.writeSourceUpstreamObservation('missing', { checkedAt: '2026-01-02T03:04:05.000Z', commit: 'u9', behind: 0 });
    const badTime = await engine.writeSourceUpstreamObservation('wiki', { checkedAt: 'not a time', commit: 'u3', behind: 1 }).then(() => 'resolved', () => 'rejected');
    if (backend !== 'rust') {
      // The store has no SQL; its record is checked in rust/crates/gbrain-store/src/sources.rs.
      const rows = await engine.executeRaw<{ id: string; upstream_checked_at: Date | string | null; upstream_commit: string | null; upstream_behind: number | null }>(
        'SELECT id, upstream_checked_at, upstream_commit, upstream_behind FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [['other', 'wiki']]);
      expect(rows.map(r => ({ ...r, upstream_checked_at: r.upstream_checked_at == null ? null : new Date(r.upstream_checked_at).toISOString() }))).toEqual([
        { id: 'other', upstream_checked_at: null, upstream_commit: null, upstream_behind: null },
        { id: 'wiki', upstream_checked_at: '2026-01-03T03:04:05.000Z', upstream_commit: 'u2', upstream_behind: null },
      ]);
    }
    const wiki = await engine.getSource('wiki');
    const seen = { anchor: wiki?.last_commit ?? null, badTime, missing: await engine.getSource('missing') };
    expect(seen).toEqual({ anchor: 'c1', badTime: 'rejected', missing: null });
    return seen;
  });

  parityTest('listSourcePagePaths lists one source\'s live file-backed pages in slug byte order', { methods: ['listSourcePagePaths', 'refreshPageOrigin'] }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    await createSource(engine, backend, 'ab');
    await seed(engine, 'a', ['notes/b', 'notes/ab', 'notes/a-c', 'notes/no-file', 'notes/gone']);
    await seed(engine, 'ab', ['notes/z']);
    for (const [sourceId, slug, sourcePath] of [['a', 'notes/b', 'notes/b.md'], ['a', 'notes/ab', 'notes/ab.md'], ['a', 'notes/a-c', 'notes/a-c.md'], ['a', 'notes/gone', 'notes/gone.md'], ['ab', 'notes/z', 'notes/z.md']] as const) {
      await engine.refreshPageOrigin(slug, { sourceId, sourcePath });
    }
    await engine.softDeletePage('notes/gone', { sourceId: 'a' });
    const seen = { a: await engine.listSourcePagePaths('a'), ab: await engine.listSourcePagePaths('ab'), missing: await engine.listSourcePagePaths('missing') };
    expect(seen).toEqual({
      a: [{ slug: 'notes/a-c', source_path: 'notes/a-c.md' }, { slug: 'notes/ab', source_path: 'notes/ab.md' }, { slug: 'notes/b', source_path: 'notes/b.md' }],
      ab: [{ slug: 'notes/z', source_path: 'notes/z.md' }],
      missing: [],
    });
    return seen;
  });

  parityTest('the rename confirmation reads match live pages by path, slug, frontmatter id and title in slug byte order', {
    methods: ['putPage', 'refreshPageOrigin', 'softDeletePage', 'readRenameStoredTitles', 'readLiveIdentityHolders', 'readPageIdentity'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    await createSource(engine, backend, 'b');
    const put = (sourceId: string, slug: string, title: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { ...NOTE, title, frontmatter }, { sourceId });
    const spec = await put('a', 'notes/spec', 'Spec', { id: 'doc-1' });
    await put('a', 'notes/num', 'Numbered', { id: 7 });
    await put('a', 'notes/plain', 'Spec', {});
    await put('a', 'notes/é-accent', 'Accent', { id: 'doc-é' });
    const gone = await put('a', 'notes/gone', 'Gone', { id: 'doc-1' });
    await put('b', 'notes/spec', 'Spec', { id: 'doc-1' });
    await engine.refreshPageOrigin('notes/spec', { sourceId: 'a', sourcePath: 'notes/spec.md' });
    await engine.softDeletePage('notes/gone', { sourceId: 'a' });
    const seen = {
      titles: await engine.readRenameStoredTitles('a', ['notes/spec.md'], ['notes/plain', 'notes/gone', 'notes/missing']),
      holders: await engine.readLiveIdentityHolders('a', ['doc-1', '7', 'doc-é'], ['Spec']),
      none: await engine.readLiveIdentityHolders('a', [], []),
      otherSource: await engine.readLiveIdentityHolders('missing', ['doc-1'], ['Spec']),
      spec: await engine.readPageIdentity(spec.id),
      gone: await engine.readPageIdentity(gone.id),
      missing: await engine.readPageIdentity(999_999),
    };
    expect(seen).toEqual({
      titles: [{ slug: 'notes/plain', source_path: null, title: 'Spec' }, { slug: 'notes/spec', source_path: 'notes/spec.md', title: 'Spec' }],
      holders: [
        { slug: 'notes/num', source_path: null, fm_id: '7', title: 'Numbered' },
        { slug: 'notes/plain', source_path: null, fm_id: null, title: 'Spec' },
        { slug: 'notes/spec', source_path: 'notes/spec.md', fm_id: 'doc-1', title: 'Spec' },
        { slug: 'notes/é-accent', source_path: null, fm_id: 'doc-é', title: 'Accent' },
      ],
      none: [], otherSource: [],
      spec: { fm_id: 'doc-1', title: 'Spec' }, gone: null, missing: null,
    });
    return seen;
  });

  parityTest('countSourcePages counts one source\'s pages, soft-deleted pages only when asked', { methods: ['countSourcePages'] }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    await createSource(engine, backend, 'ab');
    await seed(engine, 'a', ['notes/x', 'notes/y']);
    await seed(engine, 'ab', ['notes/z']);
    await seed(engine, 'default', ['notes/d']);
    await engine.softDeletePage('notes/y', { sourceId: 'a' });
    const counts = {
      live: await engine.countSourcePages('a'),
      all: await engine.countSourcePages('a', { includeDeleted: true }),
      prefixSibling: await engine.countSourcePages('ab'),
      defaultAll: await engine.countSourcePages('default', { includeDeleted: true }),
      missing: await engine.countSourcePages('missing', { includeDeleted: true }),
    };
    expect(counts).toEqual({ live: 1, all: 2, prefixSibling: 1, defaultAll: 1, missing: 0 });
    return counts;
  });

  parityTest('insertSource writes name, path and config, and refuses a taken id or name', { methods: ['insertSource'] }, async (engine) => {
    await engine.insertSource({ id: 'wiki', name: 'Wiki', local_path: '/srv/brain/wiki', config: { federated: false, kind: 'url', nested: { a: [1, 2], gone: undefined }, unset: undefined } });
    await engine.insertSource({ id: 'bare', name: 'bare', local_path: null, config: {} });
    const refused: string[] = [];
    for (const row of [{ id: 'wiki', name: 'Other' }, { id: 'notes', name: 'Wiki' }]) {
      try {
        await engine.insertSource({ ...row, local_path: null, config: {} });
      } catch {
        refused.push(row.id);
      }
    }
    expect(refused).toEqual(['wiki', 'notes']);
    const rows = [];
    for (const id of ['wiki', 'bare', 'notes']) rows.push(await engine.readSourceRow(id));
    const names = (await engine.listAllSources()).map((r) => [r.id, r.name]);
    expect(rows).toEqual([
      { id: 'wiki', local_path: '/srv/brain/wiki', config: { federated: false, kind: 'url', nested: { a: [1, 2] } }, archived: false },
      { id: 'bare', local_path: null, config: {}, archived: false },
      null,
    ]);
    expect(names).toEqual([['default', 'default'], ['bare', 'bare'], ['wiki', 'Wiki']]);
    return { refused, rows, names };
  });

  // A remote memory_recall drops the QM scope sources it did not name (withoutScopeSources); the census found the Rust
  // engine refused it, because the scope check read the sources through sqlQueryForEngine. It reads getSource now.
  parityTest('the scope-source check of a remote recall drops marked sources and keeps the rest', { methods: ['getSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'scope', { qm_scope: true, federated: false });
    await createSource(engine, backend, 'plain', { federated: true });
    const marked = [...await markedScopeSources(engine, ['plain', 'scope', 'scope', 'default', 'no-such-source'])];
    expect(marked).toEqual(['scope']);
    const remote = await withoutScopeSources({ remote: true, engine }, ['default', 'scope', 'plain']);
    expect(remote).toEqual(['default', 'plain']);
    const local = await withoutScopeSources({ remote: false, engine }, ['default', 'scope']);
    expect(local).toEqual(['default', 'scope']);
    return { marked, remote, local, none: [...await markedScopeSources(engine, [])] };
  });
});
