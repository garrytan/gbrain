/**
 * BrainEngine parity — a clean `gbrain import --source-id` of a folder source stamps the source's last sync time
 * (#1691), on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an import that covers a folder source's registered root (not a git checkout, no remote URL, not
 *    connector-managed) and finishes clean sets `sources.last_sync_at`, and the import reports the same counts on every
 *    engine arm; a git checkout keeps `last_sync_at` unset (`gbrain sync` owns its freshness). `markSourceSynced` sets
 *    the time on a known source and reports false for an unknown one.
 *  - Regression: the stamp ran as raw SQL inside a best-effort try/catch, so the Rust engine refused it, the catch
 *    swallowed the refusal and the source stayed "never synced" (doctor's `sync_freshness` then nags for ever).
 *  - Why existing coverage misses it: test/import-source-id-last-sync-at.test.ts runs on PGLite only, where the raw SQL
 *    works.
 *  - Seam: none. Real engines and the real `runImport`; the source row is made through the harness fixture; the clock
 *    is compared by "set and not in the future", never by value.
 */
import { describe, expect } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runImport } from '../../src/commands/import.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SEED = '---\ntype: note\n---\n# Seed\n\nbody\n';

/** A temporary folder holding one note (a git checkout when `git` is set), and a GBRAIN_HOME for the import's ledger. */
function folder(git: boolean): { dir: string; home: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-parity-folder-')));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-home-'));
  writeFileSync(join(dir, 'seed.md'), SEED);
  if (git) {
    execSync('git init -q && git -c user.email=t@t.t -c user.name=T add -A && git -c user.email=t@t.t -c user.name=T commit -qm seed', { cwd: dir, stdio: 'pipe' });
  }
  return { dir, home, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** The sync time as an observable that does not depend on the clock: unset, or set and not in the future. */
function stamp(at: Date | null | undefined, before: number): 'unset' | 'set' | 'future' {
  if (at === null || at === undefined) return 'unset';
  return at.getTime() <= Date.now() + 1000 && at.getTime() >= before - 60_000 ? 'set' : 'future';
}

async function importFolder(engine: BrainEngine, backend: Parameters<typeof createSource>[1], git: boolean) {
  const f = folder(git);
  try {
    await createSource(engine, backend, 'dept-x', {}, f.dir);
    const before = Date.now();
    const result = await withEnv({ GBRAIN_HOME: f.home }, () => runImport(engine, [f.dir, '--no-embed', '--json', '--source-id', 'dept-x']));
    const source = await engine.getSource('dept-x');
    return {
      imported: result.imported, skipped: result.skipped, errors: result.errors, failures: result.failures,
      lastSync: stamp(source?.last_sync_at, before),
    };
  } finally {
    f.cleanup();
  }
}

describe('engine parity: the folder-source sync stamp', () => {
  parityTest('a clean import of a folder source sets its last sync time', { methods: ['readSourceRow', 'markSourceSynced', 'getSource'], timeout: 120_000 }, async (engine, backend) => {
    const out = await importFolder(engine, backend, false);
    expect(out).toEqual({ imported: 1, skipped: 0, errors: 0, failures: [], lastSync: 'set' });
    return out;
  });

  parityTest('a clean import of a git checkout leaves its last sync time unset', { methods: ['readSourceRow', 'getSource'], timeout: 120_000 }, async (engine, backend) => {
    const out = await importFolder(engine, backend, true);
    expect(out).toEqual({ imported: 1, skipped: 0, errors: 0, failures: [], lastSync: 'unset' });
    return out;
  });

  parityTest('markSourceSynced sets a known source\'s last sync time and reports false for an unknown one', { methods: ['markSourceSynced', 'getSource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'dept-y', {}, '/srv/brain/dept-y');
    const before = Date.now();
    const unsetFirst = stamp((await engine.getSource('dept-y'))?.last_sync_at, before);
    const known = await engine.markSourceSynced('dept-y');
    const unknown = await engine.markSourceSynced('no-such-source');
    const after = stamp((await engine.getSource('dept-y'))?.last_sync_at, before);
    const out = { unsetFirst, known, unknown, after };
    expect(out).toEqual({ unsetFirst: 'unset', known: true, unknown: false, after: 'set' });
    return out;
  });

  parityTest('markSourceSynced with an incarnation stamps only the source of that incarnation', { methods: ['markSourceSynced', 'getSource', 'readSourceMembership'] }, async (engine, backend) => {
    await createSource(engine, backend, 'dept-z', {}, '/srv/brain/dept-z');
    const incarnation = (await engine.readSourceMembership('dept-z'))!.incarnation;
    const before = Date.now();
    // A managed sync run guards its stamp with the incarnation it started under: another one stamps nothing.
    const other = await engine.markSourceSynced('dept-z', { incarnation: 'f0000000-0000-4000-8000-000000000000' });
    const afterOther = stamp((await engine.getSource('dept-z'))?.last_sync_at, before);
    const upper = await engine.markSourceSynced('dept-z', { incarnation: incarnation.toUpperCase() });
    const afterOwn = stamp((await engine.getSource('dept-z'))?.last_sync_at, before);
    const unknown = await engine.markSourceSynced('no-such-source', { incarnation });
    const malformed = await engine.markSourceSynced('dept-z', { incarnation: 'not-a-uuid' }).then(() => 'answered', (e: { code?: string }) =>
      e?.code === 'invalid_argument' || e?.code === '22P02' ? 'refused' : `other: ${String(e)}`);
    const out = { other, afterOther, upper, afterOwn, unknown, malformed };
    expect(out).toEqual({ other: false, afterOther: 'unset', upper: true, afterOwn: 'set', unknown: false, malformed: 'refused' });
    return out;
  });

  parityTest('markSourceSynced with newestContentAt sets the newest content time, keeps it for null, and obeys the incarnation guard', { methods: ['markSourceSynced', 'getSource', 'listSourceRecords', 'readSourceMembership'] }, async (engine, backend) => {
    await createSource(engine, backend, 'feed-a', {}, '/srv/brain/feed-a');
    const incarnation = (await engine.readSourceMembership('feed-a'))!.incarnation;
    const newest = async () => {
      const row = (await engine.listSourceRecords()).find(r => r.id === 'feed-a');
      const at = row?.newest_content_at;
      return at === null || at === undefined ? null : new Date(at).toISOString();
    };
    const before = Date.now();
    // A connector's clean run (github, google): the newest item's time.
    const set = await engine.markSourceSynced('feed-a', { newestContentAt: '2026-03-04T05:06:07.000Z' });
    const afterSet = { newest: await newest(), synced: stamp((await engine.getSource('feed-a'))?.last_sync_at, before) };
    // A run that saw nothing newer (meetings, slack, imessage pass null): COALESCE keeps the stored time.
    const kept = await engine.markSourceSynced('feed-a', { newestContentAt: null });
    const afterNull = await newest();
    // A time with an offset is the same instant.
    await engine.markSourceSynced('feed-a', { newestContentAt: '2026-05-06T09:08:09+02:00' });
    const afterOffset = await newest();
    // The managed connector sync (lane 7) guards with its incarnation: another one changes nothing.
    const other = await engine.markSourceSynced('feed-a', { incarnation: 'f0000000-0000-4000-8000-000000000000', newestContentAt: '2027-01-01T00:00:00.000Z' });
    const afterOther = await newest();
    const own = await engine.markSourceSynced('feed-a', { incarnation, newestContentAt: '2027-01-01T00:00:00.000Z' });
    const afterOwn = await newest();
    // Refused as an input error: Rust's invalid_argument, the cast's SQLSTATE on PGLite, or postgres.js refusing an
    // unparsable timestamp before it sends it (RangeError "Invalid Date").
    const badTime = await engine.markSourceSynced('feed-a', { newestContentAt: 'not a time' }).then(() => 'answered', (e: { code?: string; message?: string }) =>
      e?.code === 'invalid_argument' || e?.code === '22007' || e?.code === '22008' || (e instanceof RangeError && /Invalid Date/.test(e.message)) ? 'refused' : `other: ${String(e)}`);
    const out = { set, afterSet, kept, afterNull, afterOffset, other, afterOther, own, afterOwn, badTime };
    expect(out).toEqual({
      set: true, afterSet: { newest: '2026-03-04T05:06:07.000Z', synced: 'set' }, kept: true, afterNull: '2026-03-04T05:06:07.000Z',
      afterOffset: '2026-05-06T07:08:09.000Z', other: false, afterOther: '2026-05-06T07:08:09.000Z', own: true, afterOwn: '2027-01-01T00:00:00.000Z', badTime: 'refused',
    });
    return out;
  });
});
