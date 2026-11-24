/**
 * BrainEngine parity — the source-resolution reads (`listLocalPathSources`, `countRepoBoundSources`, `listSourceRoutingRows`,
 * `countDefaultSourceSplit`, `listAllSources`, `getSource`, `listSourceRecords`, `listStaleSyncSourceIds`, `readSourceRow`,
 * `lockSourceRow`, `readSourceChunkerVersion`, `countSourcePages`, `insertSource`, `listSourceIds`, `readSoleSourceId`, `readFirstSourceId`, `lockAllSourceRows`) that `src/core/source-resolver.ts`
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
 *    Every source id lists in byte order, archived ones too, on any Postgres locale; the sole-source read answers the
 *    only id or null; the first-source read answers `default`, else the lowest id in byte order; the all-rows lock
 *    leaves the rows as they were.
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
 *    the config into a JSON string (every config key then reads as absent); a source-id list or first-source read in
 *    the server locale, or a default-first source list with a locale id tie-break (an en_US.utf8 Postgres then orders
 *    `a-c` after `ab` and `B` after `a_b`, unlike PGLite).
 *  - Why existing coverage misses it: test/source-resolver*.test.ts drive the resolver through fake engines keyed on
 *    SQL text, so they never compare real engines, and the Rust engine has no raw SQL to answer.
 *  - Seam: none. Real engines, typed reads only; sources are made and archived through the harness fixtures.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markedScopeSources, withoutScopeSources } from '../../src/core/access/attest-sources.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { loadConnectorSourceIds } from '../../src/commands/orphans.ts';
import { sourceConfigText, sourceRecordsRawConfig } from '../../src/core/source-rows.ts';
import { ownerOnlySourcesPresent, sourceIsOwnerOnly } from '../../src/core/access/owner-only.ts';
import { confirmRenameIdentities } from '../../src/core/sync-rename-identity.ts';

const { parityTest } = parityArms(testBackends());

const NOTE: PageInput = { type: 'note', title: 'Note', compiled_truth: 'A short note.' };

async function seed(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<void> {
  for (const slug of slugs) await engine.putPage(slug, NOTE, { sourceId });
}


// The SQL engines return these rows in no set order and the Rust store in slug order; the cases compare in slug byte order.
const bySlug = <T extends { slug: string }>(rows: T[]): T[] => [...rows].sort((x, y) => Buffer.compare(Buffer.from(x.slug), Buffer.from(y.slug)));

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

  parityTest('advanceSourceCommit advances one source\'s last commit, and its newest content time only when given', {
    methods: ['advanceSourceCommit', 'attachSourcePath', 'getSource', 'readPlainSyncSource', 'listSourceRecords'],
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
    await engine.advanceSourceCommit('wiki', 'c1', '2026-01-02T03:04:05.000Z');
    const stamped = await view('wiki');
    await engine.advanceSourceCommit('wiki', 'c2');
    const kept = await view('wiki');
    await engine.advanceSourceCommit('wiki', 'c3', null);
    const cleared = await view('wiki');
    await engine.attachSourcePath('wiki', '/srv/wiki');
    await engine.advanceSourceCommit('missing', 'c9');
    await engine.attachSourcePath('missing', '/srv/missing');
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
    methods: ['writeSourceSyncHeartbeat', 'advanceSourceCommit', 'getSource'],
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
    await engine.advanceSourceCommit('wiki', 'c1');
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
    methods: ['writeSourceUpstreamObservation', 'advanceSourceCommit', 'getSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'other');
    await engine.advanceSourceCommit('wiki', 'c1');
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

  parityTest('listSourcePathPages lists one source\'s live file-backed pages', { methods: ['listSourcePathPages', 'refreshPageOrigin'] }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    await createSource(engine, backend, 'ab');
    await seed(engine, 'a', ['notes/b', 'notes/ab', 'notes/a-c', 'notes/no-file', 'notes/gone']);
    await seed(engine, 'ab', ['notes/z']);
    for (const [sourceId, slug, sourcePath] of [['a', 'notes/b', 'notes/b.md'], ['a', 'notes/ab', 'notes/ab.md'], ['a', 'notes/a-c', 'notes/a-c.md'], ['a', 'notes/gone', 'notes/gone.md'], ['ab', 'notes/z', 'notes/z.md']] as const) {
      await engine.refreshPageOrigin(slug, { sourceId, sourcePath });
    }
    await engine.softDeletePage('notes/gone', { sourceId: 'a' });
    const seen = { a: bySlug(await engine.listSourcePathPages('a')), ab: bySlug(await engine.listSourcePathPages('ab')), missing: await engine.listSourcePathPages('missing') };
    expect(seen).toEqual({
      a: [{ slug: 'notes/a-c', source_path: 'notes/a-c.md' }, { slug: 'notes/ab', source_path: 'notes/ab.md' }, { slug: 'notes/b', source_path: 'notes/b.md' }],
      ab: [{ slug: 'notes/z', source_path: 'notes/z.md' }],
      missing: [],
    });
    return seen;
  });

  parityTest('the rename confirmation reads match live pages by path, slug, frontmatter id and title', {
    methods: ['putPage', 'refreshPageOrigin', 'softDeletePage', 'readRenameIdentityRows', 'readLiveIdentityHolders', 'readPageIdentity'],
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
      titles: bySlug(await engine.readRenameIdentityRows('a', ['notes/spec.md'], ['notes/plain', 'notes/gone', 'notes/missing'])),
      holders: bySlug(await engine.readLiveIdentityHolders('a', ['doc-1', '7', 'doc-é'], ['Spec'])),
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

  parityTest('a non-string frontmatter id reads as jsonb text: object, array and nested values', {
    methods: ['putPage', 'readLiveIdentityHolders', 'readPageIdentity'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    const put = (slug: string, title: string, id: unknown) => engine.putPage(slug, { ...NOTE, title, frontmatter: { id } }, { sourceId: 'a' });
    // jsonb's text form, as Postgres `frontmatter->>'id'` prints it: ", " and ": " separators, keys by (length, bytes).
    const object = await put('notes/id-object', 'Object', { bb: 1, a: [1, 2] });
    await put('notes/id-array', 'Array', [1, 'x', null, 2.5]);
    await put('notes/id-nested', 'Nested', { outer: { k: [true, { z: 'é' }] }, n: null });
    const seen = {
      byId: bySlug(await engine.readLiveIdentityHolders('a', ['{"a": [1, 2], "bb": 1}', '[1, "x", null, 2.5]', '{"n": null, "outer": {"k": [true, {"z": "é"}]}}'], [])),
      compact: await engine.readLiveIdentityHolders('a', ['{"bb":1,"a":[1,2]}', '[1,"x",null,2.5]'], []),
      object: await engine.readPageIdentity(object.id),
    };
    expect(seen).toEqual({
      byId: [
        { slug: 'notes/id-array', source_path: null, fm_id: '[1, "x", null, 2.5]', title: 'Array' },
        { slug: 'notes/id-nested', source_path: null, fm_id: '{"n": null, "outer": {"k": [true, {"z": "é"}]}}', title: 'Nested' },
        { slug: 'notes/id-object', source_path: null, fm_id: '{"a": [1, 2], "bb": 1}', title: 'Object' },
      ],
      compact: [],
      object: { fm_id: '{"a": [1, 2], "bb": 1}', title: 'Object' },
    });
    return seen;
  });

  parityTest('a rename compares the stored title of the first page in slug byte order when two live pages match its path', {
    methods: ['putPage', 'refreshPageOrigin', 'readRenameIdentityRows', 'readLiveIdentityHolders'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'a');
    // The source lives in sub/ of its Git repository, so a page can record the old file as sub/notes/old.md (the Git
    // path) or notes/old.md (the source path); the live-origin index allows both. notes/z-first is written first, so
    // Postgres and PGLite return it first (heap order) while the Rust store returns notes/a-second first (slug order).
    // The caller sorts by slug bytes, so every engine compares notes/a-second's stored title, which differs.
    for (const [slug, title, sourcePath] of [['notes/z-first', 'Plan', 'sub/notes/old.md'], ['notes/a-second', 'Other', 'notes/old.md']] as const) {
      await engine.putPage(slug, { ...NOTE, title }, { sourceId: 'a' });
      await engine.refreshPageOrigin(slug, { sourceId: 'a', sourcePath });
    }
    const root = mkdtempSync(join(tmpdir(), 'gbrain-rename-order-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const commit = () => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'step'); return git('rev-parse', 'HEAD'); };
      git('init', '-q', '-b', 'main');
      mkdirSync(join(root, 'sub/notes'), { recursive: true });
      writeFileSync(join(root, 'sub/notes/old.md'), '---\ntitle: Plan\n---\nThe plan, first draft.\n');
      const base = commit();
      rmSync(join(root, 'sub/notes/old.md'));
      writeFileSync(join(root, 'sub/notes/new.md'), '---\ntitle: Plan\n---\nThe plan, second draft with more text.\n');
      const target = commit();
      const manifest = { added: [], modified: [], deleted: [], renamed: [{ from: 'sub/notes/old.md', to: 'sub/notes/new.md', similarity: 80 }] };
      const decided = await confirmRenameIdentities(engine, root, base, target, manifest, { sourceId: 'a', sourcePathOf: path => path.replace(/^sub\//, '') });
      const seen = { renamed: decided.renamed, downgraded: (decided.downgradedRenames ?? []).map(pair => ({ from: pair.from, to: pair.to, reason: pair.reason })) };
      expect(seen).toEqual({ renamed: [], downgraded: [{ from: 'sub/notes/old.md', to: 'sub/notes/new.md', reason: 'no_identity_signal' }] });
      return seen;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  parityTest('listSourceIds lists every source id, archived ones too, in byte order whatever the server locale', { methods: ['listSourceIds'] }, async (engine, backend) => {
    // Byte order and en_US.utf8 disagree here: en_US skips the hyphen (a0 < ab < a-c) and folds case (a_b < B);
    // byte order is '-' < '0' < 'B' < '_' < 'a'. The Rust store keeps `default` first, so its member must sort too.
    for (const id of ['zz', 'ab', 'a-c', 'a0']) await createSource(engine, backend, id);
    await archiveSource(engine, backend, 'zz');
    const common = ['a-c', 'a0', 'ab', 'default', 'zz'];
    if (backend !== 'rust') {
      // Ids the Rust store refuses (upper case, underscore) can exist only on a SQL brain.
      for (const id of ['B', 'a_b']) await createSource(engine, backend, id);
      expect(await engine.listSourceIds()).toEqual(['B', 'a-c', 'a0', 'a_b', 'ab', 'default', 'zz']);
    }
    const ids = (await engine.listSourceIds()).filter(id => common.includes(id));
    expect(ids).toEqual(common);
    return ids;
  });
  parityTest('readSoleSourceId answers the only source, and null once a second one exists', { methods: ['readSoleSourceId'] }, async (engine, backend) => {
    const alone = await engine.readSoleSourceId();
    await createSource(engine, backend, 'a-c');
    await archiveSource(engine, backend, 'a-c');
    const two = await engine.readSoleSourceId();
    expect([alone, two]).toEqual(['default', null]);
    return [alone, two];
  });

  parityTest('readFirstSourceId answers default first, else the lowest id in byte order whatever the server locale', { methods: ['readFirstSourceId'] }, async (engine, backend) => {
    for (const id of ['ab', 'a0', 'a-c']) await createSource(engine, backend, id);
    const first = await engine.readFirstSourceId();
    expect(first).toBe('default');
    if (backend !== 'rust') {
      // Only a SQL brain can drop `default`. en_US.utf8 skips the hyphen and answers a0; byte order answers a-c.
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'default'`);
      expect(await engine.readFirstSourceId()).toBe('a-c');
      await engine.executeRaw('DELETE FROM sources');
      expect(await engine.readFirstSourceId()).toBeNull();
    }
    return first;
  });

  parityTest('lockAllSourceRows locks every source row inside a transaction and leaves the rows unchanged', { methods: ['lockAllSourceRows', 'listSourceIds'] }, async (engine, backend) => {
    await createSource(engine, backend, 'a-c');
    const seen = await engine.transaction(async tx => {
      await tx.lockAllSourceRows('update');
      await tx.lockAllSourceRows('share');
      return tx.listSourceIds();
    });
    expect(seen).toEqual(['a-c', 'default']);
    return seen;
  });
  parityTest('listAllSources and listSourceRecords put default first, then ids in byte order whatever the server locale', { methods: ['listAllSources', 'listSourceRecords'] }, async (engine, backend) => {
    // en_US.utf8 skips the hyphen (a0 < ab < a-c); byte order puts '-' before '0' before 'b'.
    for (const id of ['ab', 'a0', 'a-c']) await createSource(engine, backend, id);
    const all = (await engine.listAllSources()).map(r => r.id);
    const records = (await engine.listSourceRecords()).map(r => r.id);
    expect(all).toEqual(['default', 'a-c', 'a0', 'ab']);
    expect(records).toEqual(['default', 'a-c', 'a0', 'ab']);
    return { all, records };
  });

  // A remote memory_recall drops the QM scope sources it did not name (withoutScopeSources); the census found the Rust
  // engine refused it, because the scope check read the sources through sqlQueryForEngine. It reads readScopeSourceConfigs now.
  parityTest('the scope-source check of a remote recall drops marked sources and keeps the rest', { methods: ['readScopeSourceConfigs'] }, async (engine, backend) => {
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
