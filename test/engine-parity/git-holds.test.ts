/**
 * BrainEngine parity — the git sync hold store (`lockGitHoldSummary`, `adjustGitHoldSummary`, `readGitHoldRow`,
 * `writeGitHoldRow`, `replaceGitHoldRow`, `deleteGitHoldRow`, `countGitHolds`), the held-file reads built on it
 * (`readHeldPageRows`, `readHeldCoverageRows`, `readGitHoldRecords`, `readGitHoldReportInputs`), the managed sync pass
 * row (`writeSyncPassRow`, `readSyncPassRow`, `readLiveSyncPassRows`), and the status reads (`readGitHoldListingRows`,
 * `readGitHoldCodeCountRows`, `readGitImageHoldCountRows`, `readSyncConversionRows`) and the conversion log write
 * (`recordSyncConversion`), which persistence/sync-holds.ts and persistence/sync-pass-row.ts call instead of raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a hold write inserts, a re-write of the same path updates and counts an attempt, an older run's write is
 *    skipped; the summary counts each held path once with its counters; a clear by an older run is refused, by a newer
 *    run lands once. Readers see only the source's current incarnation, mark a read-only mirror's holds, and name a
 *    held page with its revision. The pass row lands under its lease (or a pin), refuses another lease, and with
 *    `onlyOpen` lands only on an open row. A conversion goes first in its source incarnation's log, the log keeps the
 *    newest SYNC_CONVERSION_KEEP, the stored record keeps its other keys and reads back in jsonb key order.
 *  - Regression: an engine that refuses these as raw SQL (the Rust engine did, which stopped every first sync at the
 *    hold count), double-counts a re-written hold, leaks an old incarnation's holds, or lets a stale lease overwrite
 *    the pass row, or a conversion log write that drops the record's keys, the bound, or jsonb's key order.
 *  - Why existing coverage misses it: the sync-holds and sync-pass-row tests run on PGLite and Postgres only.
 *  - Seam: none. Real engines and the callers' own functions over the typed members.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  clearGitHold, countGitHolds, readGitHoldCodeCounts, readGitHoldListing, readGitImageHoldCounts, readGitSourceHolds, readSyncConversions,
  readGitHoldRetryPaths, recordHoldAttempt, recordSyncConversion, requestGitHoldRetry, writeGitHold, SYNC_CONVERSION_KEEP, SYNC_CONVERSION_OP, type GitHoldRecord,
} from '../../src/core/persistence/sync-holds.ts';
import { readLivePassRows, readPassRow, writePassRow } from '../../src/core/persistence/sync-pass-row.ts';
import { heldFileCount } from '../../src/core/persistence/applied-watermark.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const incarnationOf = async (engine: BrainEngine, id: string) => String((await engine.readSourceState(id))!.incarnation);

type HoldInput = Parameters<typeof writeGitHold>[1];
const hold = (sourceId: string, incarnation: string, path: string, over: Partial<HoldInput> = {}): HoldInput => ({
  source_id: sourceId, incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null,
  code: 'invalid_frontmatter', message: 'line 1: bad key', upstream_version: 'v1', observed_at: '2026-01-01T00:00:01.000Z',
  run_id: 'run-1', mode: 'managed', meta: {}, ...over,
} as HoldInput);

/** The stable fields of a hold record (its stamps are the clock's). */
const shape = (r: Partial<GitHoldRecord>) => ({
  source_id: r.source_id, path: r.path, code: r.code, page_id: r.page_id ?? null, run_id: r.run_id ?? null,
  attempts: r.meta?.attempts ?? null, read_only_checkout: r.read_only_checkout ?? false,
});

describe('engine parity: git sync holds', () => {
  parityTest('hold writes, re-writes, clears and counts keep one summary, and the readers see the current incarnation only',
    { methods: ['lockGitHoldSummary', 'adjustGitHoldSummary', 'readGitHoldRow', 'writeGitHoldRow', 'replaceGitHoldRow', 'deleteGitHoldRow', 'countGitHolds', 'readHeldPageRows', 'readHeldCoverageRows', 'readGitHoldRecords', 'readGitHoldReportInputs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'mirror', { mirror_read_only: 'true' }, '/srv/brain/mirror');
      const inc = await incarnationOf(engine, 'repo');
      const mirrorInc = await incarnationOf(engine, 'mirror');
      const page = await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'body', timeline: '' }, { sourceId: 'repo' });

      const first = await writeGitHold(engine, hold('repo', inc, 'notes/a.md', { page_id: Number(page.id) }));
      const again = await writeGitHold(engine, hold('repo', inc, 'notes/a.md', { page_id: Number(page.id), observed_at: '2026-01-01T00:00:02.000Z' }));
      const older = await writeGitHold(engine, hold('repo', inc, 'notes/a.md', { page_id: Number(page.id), observed_at: '2026-01-01T00:00:00.000Z' }));
      const fence = await writeGitHold(engine, hold('repo', inc, 'notes/b.md', { code: 'invalid_fence' } as Partial<HoldInput>));
      await writeGitHold(engine, hold('repo', 'stale-incarnation', 'notes/c.md'));
      await writeGitHold(engine, hold('mirror', mirrorInc, 'notes/m.md'));
      const attempted = await recordHoldAttempt(engine, { sourceId: 'repo', incarnation: inc, path: 'notes/b.md', code: 'invalid_fence' });
      const wrongCode = await recordHoldAttempt(engine, { sourceId: 'repo', incarnation: inc, path: 'notes/b.md', code: 'invalid_frontmatter' });

      const coverage = (await engine.readHeldCoverageRows(null)).map(r => ({ ...r, count: Number(r.count), stale: Number(r.stale), fences: Number(r.fences) }));
      const held = (await engine.readHeldPageRows([String(page.id), '999999'])).map(r => ({ ...shape(r.record as unknown as GitHoldRecord), revision: r.revision !== null }));
      const records = (await readGitSourceHolds(engine, {})).flatMap(s => s.holds.map(shape));
      const runOnly = (await engine.readGitHoldRecords({ sourceIds: ['repo'], runId: 'run-none' })).length;
      const report = await engine.readGitHoldReportInputs('repo', `repo:${inc}`);
      const counted = await countGitHolds(engine, 'repo', inc);

      const staleClear = await clearGitHold(engine, { sourceId: 'repo', incarnation: inc, path: 'notes/b.md', observedAt: '2025-12-31T00:00:00.000Z' });
      const clear = await clearGitHold(engine, { sourceId: 'repo', incarnation: inc, path: 'notes/b.md', observedAt: '2026-01-02T00:00:00.000Z' });
      const clearAgain = await clearGitHold(engine, { sourceId: 'repo', incarnation: inc, path: 'notes/b.md', observedAt: '2026-01-02T00:00:00.000Z' });
      const after = await countGitHolds(engine, 'repo', inc);
      const afterReport = await engine.readGitHoldReportInputs('repo', `repo:${inc}`);

      const result = {
        writes: [first, again, older, fence], attempted, wrongCode, coverage, held, records, runOnly,
        report: { summary: report.summary && Object.fromEntries(Object.entries(report.summary).map(([k, v]) => [k, Number(v)])), mirror: report.mirror },
        counted, clears: [staleClear, clear, clearAgain], after,
        afterFences: Number(afterReport.summary?.fences), missing: await engine.readGitHoldReportInputs('repo', 'repo:none'),
      };
      expect(result).toEqual({
        writes: ['inserted', 'updated', 'skipped', 'inserted'], attempted: true, wrongCode: false,
        coverage: [
          { source_id: 'mirror', count: 1, stale: 0, fences: 0, concurrent: 0, stalled: 0, dirty: 0, drift: 0 },
          { source_id: 'repo', count: 2, stale: 1, fences: 1, concurrent: 0, stalled: 0, dirty: 0, drift: 0 },
        ],
        held: [{ source_id: 'repo', path: 'notes/a.md', code: 'invalid_frontmatter', page_id: Number(page.id), run_id: 'run-1', attempts: 2, read_only_checkout: false, revision: true }],
        records: [
          { source_id: 'mirror', path: 'notes/m.md', code: 'invalid_frontmatter', page_id: null, run_id: 'run-1', attempts: 1, read_only_checkout: true },
          { source_id: 'repo', path: 'notes/a.md', code: 'invalid_frontmatter', page_id: Number(page.id), run_id: 'run-1', attempts: 2, read_only_checkout: false },
          { source_id: 'repo', path: 'notes/b.md', code: 'invalid_fence', page_id: null, run_id: 'run-1', attempts: 2, read_only_checkout: false },
        ],
        runOnly: 0,
        report: { summary: { count: 2, drift: 0, images: 0, fences: 1, stalled: 0, concurrent: 0, dirty: 0 }, mirror: null },
        counted: 2, clears: [false, true, false], after: 1, afterFences: 0,
        missing: { summary: null, mirror: null },
      });
      return result;
    });

  parityTest('the status reads list each source\'s first holds by path and count codes and images; no source has a conversion log',
    { methods: ['writeGitHoldRow', 'readGitHoldListingRows', 'readGitHoldCodeCountRows', 'readGitImageHoldCountRows', 'readSyncConversionRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'mirror', { mirror_read_only: 'true' }, '/srv/brain/mirror');
      await createSource(engine, backend, 'quiet', {}, '/srv/brain/quiet');
      const inc = await incarnationOf(engine, 'repo');
      const mirrorInc = await incarnationOf(engine, 'mirror');
      await writeGitHold(engine, hold('repo', inc, 'notes/c.md'));
      await writeGitHold(engine, hold('repo', inc, 'notes/a.md', { code: 'invalid_fence' } as Partial<HoldInput>));
      await writeGitHold(engine, hold('repo', inc, 'img/b.png', { code: 'managed_image_sync_unsupported' } as Partial<HoldInput>));
      await writeGitHold(engine, hold('repo', 'stale-incarnation', 'notes/z.md'));
      await writeGitHold(engine, hold('mirror', mirrorInc, 'notes/m.md'));
      const ids = ['repo', 'mirror', 'quiet', 'missing'];
      const listing = (limit: number) => readGitHoldListing(engine, ids, limit).then(list => list.map(s => ({ ...s, holds: s.holds.map(shape) })));
      const result = {
        one: await listing(1), all: await listing(10), none: await listing(0),
        codes: Object.fromEntries([...(await readGitHoldCodeCounts(engine, ids))].sort(([a], [b]) => a.localeCompare(b))),
        images: [...(await readGitImageHoldCounts(engine, ids))],
        conversions: [...(await readSyncConversions(engine, ids, 5))],
        empty: [await engine.readGitHoldListingRows([], 5), await engine.readGitHoldCodeCountRows([]), await engine.readGitImageHoldCountRows([]), await engine.readSyncConversionRows([])],
      };
      const repoHold = (path: string, code = 'invalid_frontmatter') => ({ source_id: 'repo', path, code, page_id: null, run_id: 'run-1', attempts: 1, read_only_checkout: false });
      const mirrorHold = { source_id: 'mirror', path: 'notes/m.md', code: 'invalid_frontmatter', page_id: null, run_id: 'run-1', attempts: 1, read_only_checkout: true };
      expect(result as unknown).toEqual({
        one: [
          { sourceId: 'mirror', incarnation: mirrorInc, count: 1, holds: [mirrorHold] },
          { sourceId: 'repo', incarnation: inc, count: 3, holds: [repoHold('img/b.png', 'managed_image_sync_unsupported')] },
        ],
        all: [
          { sourceId: 'mirror', incarnation: mirrorInc, count: 1, holds: [mirrorHold] },
          { sourceId: 'repo', incarnation: inc, count: 3, holds: [repoHold('img/b.png', 'managed_image_sync_unsupported'), repoHold('notes/a.md', 'invalid_fence'), repoHold('notes/c.md')] },
        ],
        none: [
          { sourceId: 'mirror', incarnation: mirrorInc, count: 1, holds: [] },
          { sourceId: 'repo', incarnation: inc, count: 3, holds: [] },
        ],
        codes: { mirror: { invalid_frontmatter: 1 }, repo: { invalid_frontmatter: 1, invalid_fence: 1, managed_image_sync_unsupported: 1 } },
        images: [['repo', 1]],
        conversions: [],
        empty: [[], [], [], []],
      });
      // Incarnations are random per brain: the arms compare everything else.
      const plain = (list: typeof result.one) => list.map(({ incarnation: _inc, ...rest }) => rest);
      return { ...result, one: plain(result.one), all: plain(result.all), none: plain(result.none) };
    });

  parityTest('the conversion log reads newest first per source, current incarnation only',
    { methods: ['recordSyncConversion', 'readSyncConversionRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'quiet', {}, '/srv/brain/quiet');
      const inc = await incarnationOf(engine, 'repo');
      const quietInc = await incarnationOf(engine, 'quiet');
      await recordSyncConversion(engine, 'repo', inc, { request_id: 'r1', path: 'notes/a.md', slug: 'notes/a', run_id: 'run-1', outcome: 'held' });
      await recordSyncConversion(engine, 'repo', inc, { request_id: 'r2', path: 'notes/d.md', slug: 'notes/d', run_id: 'run-2', outcome: 'refrozen' });
      await recordSyncConversion(engine, 'quiet', quietInc, { request_id: 'r3', path: null, slug: null, run_id: 'run-3', outcome: 'held' });
      await recordSyncConversion(engine, 'repo', 'stale-incarnation', { request_id: 'r4', path: null, slug: null, run_id: 'run-4', outcome: 'held' });
      const read = async (limit: number) => [...(await readSyncConversions(engine, ['repo', 'quiet', 'missing'], limit))]
        .map(([id, list]) => [id, list.map(c => c.request_id)] as const).sort(([a], [b]) => a.localeCompare(b));
      const result = { five: await read(5), one: await read(1), zero: await read(0) };
      expect(result).toEqual({ five: [['quiet', ['r3']], ['repo', ['r2', 'r1']]], one: [['quiet', ['r3']], ['repo', ['r2']]], zero: [] });
      return result;
    });

  parityTest('recordSyncConversion keeps the newest SYNC_CONVERSION_KEEP and stores the record byte for byte as jsonb does',
    { methods: ['recordSyncConversion', 'readSyncConversionRows', 'readOpCheckpointRecord', 'writeOpCheckpointRecord'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'kept', {}, '/srv/brain/kept');
      const inc = await incarnationOf(engine, 'repo');
      const keptInc = await incarnationOf(engine, 'kept');
      for (let i = 0; i < SYNC_CONVERSION_KEEP + 2; i++) {
        await recordSyncConversion(engine, 'repo', inc, { request_id: `r${i}`, path: `notes/${i}.md`, slug: `notes/${i}`, run_id: 'run-1', outcome: i % 2 ? 'held' : 'refrozen' });
      }
      // A stored record with another key and a log that is not an array: the write keeps the key, and jsonb's `||`
      // takes the old log as one element after the new conversion.
      await engine.writeOpCheckpointRecord(SYNC_CONVERSION_OP, `kept:${keptInc}`, [{ source_id: 'kept', incarnation: keptInc, note: 'kept', conversions: 'old' }]);
      await recordSyncConversion(engine, 'kept', keptInc, { request_id: 'k1', path: null, slug: null, run_id: 'run-2', outcome: 'held' });
      /** The stored record as JSON text, with the clock stamp and the random incarnation checked and set in place. */
      const stored = async (id: string, incarnation: string) => {
        const keys = (await engine.readOpCheckpointRecord(SYNC_CONVERSION_OP, `${id}:${incarnation}`))!.completed_keys as Array<Record<string, unknown>>;
        for (const record of keys) {
          expect(record.incarnation).toBe(incarnation);
          record.incarnation = 'INC';
          for (const c of (Array.isArray(record.conversions) ? record.conversions : []) as Array<Record<string, unknown>>) {
            if (typeof c !== 'object' || c === null) continue;
            expect(String(c.converted_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
            c.converted_at = 'AT';
          }
        }
        return JSON.stringify(keys);
      };
      const log = (await readSyncConversions(engine, ['repo'], 100)).get('repo')!.map(c => c.request_id);
      const result = { log, repo: await stored('repo', inc), kept: await stored('kept', keptInc) };
      expect(result.log).toEqual(Array.from({ length: SYNC_CONVERSION_KEEP }, (_, i) => `r${SYNC_CONVERSION_KEEP + 1 - i}`));
      expect(result.repo.startsWith('[{"source_id":"repo","conversions":[{"path":"notes/21.md","slug":"notes/21","run_id":"run-1","outcome":"held","request_id":"r21","converted_at":"AT"},')).toBe(true);
      expect(result.repo.endsWith('{"path":"notes/2.md","slug":"notes/2","run_id":"run-1","outcome":"refrozen","request_id":"r2","converted_at":"AT"}],"incarnation":"INC"}]')).toBe(true);
      expect(result.kept).toBe('[{"note":"kept","source_id":"kept","conversions":[{"path":null,"slug":null,"run_id":"run-2","outcome":"held","request_id":"k1","converted_at":"AT"},"old"],"incarnation":"INC"}]');
      return result;
    });

  parityTest('the pass row lands under its lease or a pin, refuses another lease, and onlyOpen lands only on an open row',
    { methods: ['writeSyncPassRow', 'readSyncPassRow', 'readLiveSyncPassRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      await createSource(engine, backend, 'other', {}, '/srv/brain/other');
      const inc = await incarnationOf(engine, 'repo');
      const pass = (lease: string, outcome: string, step: number) =>
        ({ source_id: 'repo', incarnation: inc, lease_token: lease, step, telemetry: { outcome, started_at: '2000-01-01T00:00:00.000Z' } }) as never;

      const openMissing = await writePassRow(engine, pass('t1', 'open', 0), { onlyOpen: true });
      const pinned = await writePassRow(engine, pass('t1', 'open', 1), { pin: true, clock: true });
      const clocked = (await readPassRow(engine, 'repo', inc))?.value as { telemetry: { started_at: string } } | undefined;
      const otherLease = await writePassRow(engine, pass('t2', 'open', 2));
      const sameLease = await writePassRow(engine, pass('t1', 'synced', 3));
      const closed = await writePassRow(engine, pass('t1', 'open', 4), { onlyOpen: true });
      const stolen = await writePassRow(engine, pass('t2', 'open', 5), { pin: true });
      const row = await readPassRow(engine, 'repo', inc);

      const result = {
        openMissing, pinned, clockMoved: clocked?.telemetry.started_at !== '2000-01-01T00:00:00.000Z', otherLease, sameLease, closed, stolen,
        value: row?.value && { ...(row.value as object), incarnation: (row.value as { incarnation: string }).incarnation === inc } as Record<string, unknown>, stamped: typeof row?.updated_at === 'string' && typeof row?.read_at === 'string',
        otherIncarnation: await readPassRow(engine, 'repo', 'none'),
        live: [...(await readLivePassRows(engine)).entries()].map(([id, r]) => [id, (r.value as unknown as { step: number }).step]),
        scoped: [...(await readLivePassRows(engine, ['other'])).keys()],
      };
      expect(result).toEqual({
        openMissing: false, pinned: true, clockMoved: true, otherLease: false, sameLease: true, closed: false, stolen: true,
        value: { source_id: 'repo', incarnation: true, lease_token: 't2', step: 5, telemetry: { outcome: 'open', started_at: '2000-01-01T00:00:00.000Z' } },
        stamped: true, otherIncarnation: null, live: [['repo', 5]], scoped: [],
      });
      return result;
    });

  parityTest('the watermark held-file count reads a failed count as 0 on PGLite and Postgres, and a Rust brain rethrows it',
    { methods: ['countGitHolds'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
      const inc = await incarnationOf(engine, 'repo');
      await writeGitHold(engine, hold('repo', inc, 'notes/a.md'));
      const counted = await heldFileCount(engine, 'repo', inc);
      // A count that fails: the engine's typed member throws (a broken store read).
      const failing = new Proxy(engine, {
        get(target, key) {
          if (key === 'countGitHolds') return async () => { throw new Error('hold count failed'); };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const failed = await heldFileCount(failing, 'repo', inc).then(n => ({ count: n }), (error: Error) => ({ error: error.message }));
      expect(counted).toBe(1);
      expect(failed).toEqual(engine.kind === 'rust' ? { error: 'hold count failed' } : { count: 0 });
      // The same result on every arm: each arm met its own contract.
      return { counted, contract: engine.kind === 'rust' ? 'error' in failed : (failed as { count: number }).count === 0 };
    });

  parityTest('a retry request keeps each path once, in byte order, across requests on every engine', {
    methods: ['readSourceState', 'requestGitHoldRetry', 'readGitHoldRetryRequest'],
  }, async (engine) => {
    const inc = await incarnationOf(engine, 'default');
    const none = await readGitHoldRetryPaths(engine, 'default', inc);
    await requestGitHoldRetry(engine, 'default', inc, ['b.md', 'B.md', 'b.md', 'a/z.md']);
    const first = await readGitHoldRetryPaths(engine, 'default', inc);
    await engine.requestGitHoldRetry('default', inc, ['a.md', 'b.md', 'Z.md'], '2026-01-02T00:00:00.000Z');
    return { none, first, merged: await readGitHoldRetryPaths(engine, 'default', inc) };
  });
});
