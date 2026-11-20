/**
 * BrainEngine parity — the rows a repair's busy set is built from (persistence/repair-busy.ts `loadRepairBusySet`, the
 * typed member readRepairBusyRows of engine-sql/repair-busy.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), a source with no open
 *    write and no unfinished sync is not busy; a queued write names its slug, path, origin path and both rename
 *    endpoints; an unfinished managed sync cursor of the source's incarnation names every manifest entry from its index on,
 *    except a held path, while a finished cursor, another incarnation's cursor and another source's cursor name nothing;
 *    a cursor whose manifest is missing makes the set unknown. The member's rows come back in the same order on every arm.
 *  - Regression: the busy read ran its SQL through `executeRaw`, which a Rust brain refuses; the read fails closed, so
 *    on a Rust brain every repair candidate was busy and `gbrain repair frontmatter --apply` wrote nothing.
 *  - Why existing coverage misses it: test/repair-busy.test.ts runs on PGLite only, and the repair parity cases
 *    previewed without reading the busy set.
 *  - Seam: none. Incarnations are generated, so they are read from readSourceIncarnation.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { loadRepairBusySet } from '../../src/core/persistence/repair-busy.ts';
import { writeGitHold } from '../../src/core/persistence/sync-holds.ts';

const { parityTest } = parityArms(testBackends());

const REQUEST = 'c0000000-0000-4000-8000-0000000000b1';

/** The busy set with its sets as sorted arrays, so every arm compares by value. */
async function busy(engine: BrainEngine, sourceId: string, incarnation: string) {
  const set = await loadRepairBusySet(engine, sourceId, incarnation);
  return { paths: [...set.paths].sort(), slugs: [...set.slugs].sort(), unknown: set.unknown };
}

/** Admits one put_page request whose intent names a path, an origin path and a rename, through the real admission path. */
async function admitRename(engine: BrainEngine, incarnation: string) {
  const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const slug = 'notes/renamed';
  const authority = await submissionAuthority(ctx, 'put_page', 'default', incarnation, slug);
  const intent = { body: slug, path: 'notes/renamed.md', sourcePath: 'origin/renamed.md', renameFrom: { slug: 'notes/old', sourcePath: 'origin/old.md' } };
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: incarnation, slug, requestId: REQUEST, callerIntent: intent, intent });
}

const cursor = (sourceId: string, incarnation: string, runId: string, index: number, done = false) =>
  [{ runId, index, sourceId, incarnation, done }];

describe('engine parity: repair busy set', () => {
  parityTest('the busy set names open writes and unfinished sync entries alike on every engine', {
    methods: ['declarePersistence', 'transaction', 'readSourceIncarnation', 'insertWriteRequest', 'insertSource',
      'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'writeGitHoldRow', 'readRepairBusyRows'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const inc = (await engine.readSourceIncarnation('default'))!.incarnation;
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    const otherInc = (await engine.readSourceIncarnation('other-example'))!.incarnation;
    const steps: Record<string, unknown> = {};
    steps.idle = { set: await busy(engine, 'default', inc), rows: await engine.readRepairBusyRows('default', inc) };

    await admitRename(engine, inc);
    steps.queued = { set: await busy(engine, 'default', inc), rows: await engine.readRepairBusyRows('default', inc) };

    // Cursors written out of fingerprint order; the finished, stale-incarnation and other-source cursors name nothing.
    await engine.writeOpCheckpointRecord('managed-sync', 'z-cursor', cursor('default', inc, 'run-b', 1));
    await engine.writeOpCheckpointRecord('managed-sync', 'B-cursor', cursor('default', inc, 'run-a', 0));
    await engine.writeOpCheckpointRecord('managed-sync', 'done-cursor', cursor('default', inc, 'run-done', 0, true));
    await engine.writeOpCheckpointRecord('managed-sync', 'old-cursor', cursor('default', '00000000-0000-4000-8000-000000000000', 'run-old', 0));
    await engine.writeOpCheckpointRecord('managed-sync', 'other-cursor', cursor('other-example', otherInc, 'run-other', 0));
    await engine.writeOpCheckpointRecord('managed-sync-manifest', 'run-a', [
      { path: 'a/one.md', slug: 'a/one' }, { path: 'a/held.md', slug: 'a/held' },
      { path: 'a/moved.md', sourcePath: 'a/moved.md', slug: 'a/moved', renameFrom: { sourcePath: 'a/was.md', slug: 'a/was' } },
    ]);
    await engine.writeOpCheckpointRecord('managed-sync-manifest', 'run-b', [{ path: 'b/skipped.md', slug: 'b/skipped' }, { path: 'b/two.md', slug: 'b/two' }]);
    for (const path of ['a/held.md', 'Z/held.md']) {
      await writeGitHold(engine, { source_id: 'default', incarnation: inc, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null,
        code: 'invalid_frontmatter', message: 'held', upstream_version: 'sha-1', observed_at: '2026-01-01T00:00:00.000Z', run_id: 'run-a', mode: 'managed', meta: { recovery_version: 1 } });
    }
    steps.syncing = { set: await busy(engine, 'default', inc), rows: await engine.readRepairBusyRows('default', inc) };
    // The other source's cursor has no manifest, so its set is unknown.
    const other = await busy(engine, 'other-example', otherInc);
    expect(other.unknown).toContain('run-other');
    steps.other = { set: other, rows: await engine.readRepairBusyRows('other-example', otherInc) };
    return steps;
  });
});
