/**
 * Write comparisons for swap criterion 5 (src/shadow/write-compare.ts, write-capture.ts, write-compare-child.ts): the PGLite arm.
 * Scenarios shared with the Postgres twin (test/e2e/shadow-write-compare.test.ts) are in test/helpers/shadow-write-compare-scenarios.ts.
 *
 * Authoring gate (docs/TESTING.md): (1) protects the count criterion 5 reads: a sampled page or link write is replayed on a scratch Rust
 * store and counted `comparable` only when the changed rows match. (2) Fails when a match is not counted, a mismatch is not unexplained,
 * a write from another family is counted anywhere but `capability_missing`, an uncomparable or unreadable write is ever `comparable`,
 * criterion 5 leaves `missing` with no comparison behind it, the pilot changes a primary write, or a shadow that is off or unseeded
 * reads anything. (3) Nothing else compares writes. (4) The real scratch replay needs the built addon and skips without it
 * (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 or GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error; the Rust engine workflow runs it that way through its rust-store receipt lane); everything else uses fake engines or no engine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WRITE_COVERAGE_LIMIT, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus } from '../src/shadow/follow-status.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { pageRefs, readWriteTally, writeTallyPath, WriteTally, type WriteEvent } from '../src/shadow/write-compare.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { defineWriteCompareScenarios, fakeComparer, page, row5, settle, watchPreimage } from './helpers/shadow-write-compare-scenarios.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 or GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${BUILT} does not exist; run bun run rust:build`);

const NOW = new Date('2026-12-01T00:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-')); dirs.push(d); return d; };

let primary: PGLiteEngine;
let addon: RustAddon | undefined;
beforeAll(async () => {
  primary = new PGLiteEngine(); await primary.connect({}); await primary.initSchema();
  if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
});
afterAll(async () => { await primary.disconnect(); });
beforeEach(async () => { await resetPgliteState(primary); });

describe('write comparisons on PGLite', () => {
  defineWriteCompareScenarios({ primary: () => primary, reset: async () => { await resetPgliteState(primary); }, kind: 'pglite', tempDir: tmp, ...(HAVE_ADDON ? { addon: () => addon!, addonPath: BUILT } : {}) });
});

describe('write comparison counts', () => {
  test('the child never takes a verdict from the serving process', async () => {
    const dir = tmp();
    const comparer = fakeComparer(dir);
    await settle(comparer, [{ t: 'write', op: 'putPage', outcome: 'comparable' }, { t: 'write', op: 'putPage', outcome: 'unexplained_difference' }]);
    expect(readWriteTally(dir, 'e1')).toMatchObject({ comparable: 0, unexplained_difference: 0 });
  });


  test('with no comparison the state stays capability_missing and criterion 5 stays missing', () => {
    const dir = tmp();
    const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as never, NOW.getTime());
    expect(buildFollowStatus(dir, { sample_rate: 0.1 } as never, NOW).write_comparisons.state).toBe('capability_missing');
    // Writes were sampled, but none produced a verdict: still no evidence.
    const tally = new WriteTally(dir, () => epoch.epoch_id);
    tally.note('capability_missing', 'tags');
    tally.note('uncomparable', 'in_transaction');
    const status = buildFollowStatus(dir, { sample_rate: 0.1 } as never, NOW);
    expect(status.write_comparisons).toMatchObject({ state: 'capability_missing', comparable: 0, uncomparable: 1, capability_missing: 1, capability_missing_by_family: { tags: 1 } });
    const row = row5({ write_comparisons: status.write_comparisons as ShadowStatus["write_comparisons"] });
    expect(row.state).toBe('missing');
    expect(row.detail).toContain(WRITE_COVERAGE_LIMIT);
    expect(row.detail).toContain('every other write family is capability_missing (sampled so far: tags 1)');
    // The first verdict moves it off missing; a count from another epoch does not count.
    tally.note('comparable');
    expect(buildFollowStatus(dir, { sample_rate: 0.1 } as never, NOW).write_comparisons.state).toBe('measured');
    expect(readWriteTally(dir, 'another-epoch')).toBeNull();
  });
});

describe('write comparison rules (review findings)', () => {
  const sample = (over: Partial<WriteEvent> = {}): WriteEvent => ({
    t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[],
    pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over,
  });

  test('putPage takes its source from its options (third argument), and a link origin with no source is the default source', () => {
    const page = { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' };
    expect(pageRefs('putPage', ['people/pat-example', page, { sourceId: 'team-example' }])).toEqual([{ source: 'team-example', slug: 'people/pat-example' }]);
    expect(pageRefs('putPage', ['people/pat-example', { ...page, sourceId: 'not-an-option' }])).toEqual([{ source: 'default', slug: 'people/pat-example' }]);
    expect(pageRefs('deletePage', ['people/pat-example', { sourceId: 'team-example' }])).toEqual([{ source: 'team-example', slug: 'people/pat-example' }]);
    const link = pageRefs('addLink', ['a/x', 'a/y', 'c', 'knows', 'markdown', 'a/origin', 'f', { fromSourceId: 'team-example', toSourceId: 'team-example' }]);
    expect(link).toEqual([{ source: 'team-example', slug: 'a/x' }, { source: 'team-example', slug: 'a/y' }, { source: 'default', slug: 'a/origin' }]);
    const batch = pageRefs('addLinksBatch', [[{ from_slug: 'a/x', to_slug: 'a/y', from_source_id: 'team-example', to_source_id: 'team-example', origin_slug: 'a/origin' }]]);
    expect(batch.map((r) => r.source)).toEqual(['team-example', 'team-example', 'default']);
  });

  test('a sample that is known to have had another write land is uncomparable even when the rows match', async () => {
    const dir = tmp();
    await settle(fakeComparer(dir), [sample({ moved: true }), sample()]);
    expect(readWriteTally(dir, 'e1')).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { moved: 1 } });
  });

  test('a verdict that could not be written never leaves a passing count behind, and is counted when the next one is written', () => {
    const dir = tmp();
    const tally = new WriteTally(dir, () => 'e1');
    tally.note('comparable'); tally.note('comparable');
    mkdirSync(`${writeTallyPath(dir)}.${process.pid}.tmp`); // the write fails (a directory is in its way)
    tally.note('unexplained_difference');
    expect(readWriteTally(dir, 'e1')).toBeNull(); // the two comparable writes no longer stand as evidence without the mismatch
    rmSync(`${writeTallyPath(dir)}.${process.pid}.tmp`, { recursive: true });
    tally.note('comparable');
    expect(readWriteTally(dir, 'e1')).toMatchObject({ comparable: 1, unexplained_difference: 1 });
    expect(row5({ write_comparisons: { state: 'measured', comparable: 5000, unexplained_difference: readWriteTally(dir, 'e1')!.unexplained_difference } }).state).toBe('fail');
  });

  test('a second child never deletes the store a first one is using, and a dead process\'s leftover store is removed', async () => {
    const dir = tmp(); const scratch = tmp();
    let opened = ''; let release = (): void => {}; let entered = (): void => {};
    const inside = new Promise<void>((r) => { entered = r; });
    const first = fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => { opened = path; entered(); await new Promise<void>((r) => { release = r; }); } });
    first.handle(sample());
    await inside;
    mkdirSync(join(scratch, 'gbrain-write-compare-2147483646-leftover')); // a pid that is not running
    fakeComparer(dir, { scratchRoot: scratch }); // another child starts in the same temp directory
    expect(existsSync(dirname(opened))).toBe(true);
    expect(existsSync(join(scratch, 'gbrain-write-compare-2147483646-leftover'))).toBe(false);
    release(); await first.idle();
    expect(readdirSync(scratch)).toEqual([]);
  });

  test('a replay that is still opening when stop --delete removes the shadow directory does not bring it back', async () => {
    const dir = tmp(); const scratch = tmp();
    let release = (): void => {}; let entered = (): void => {};
    const inside = new Promise<void>((r) => { entered = r; });
    const comparer = fakeComparer(dir, { scratchRoot: scratch, alive: () => existsSync(dir), connect: async (path) => {
      entered(); await new Promise<void>((r) => { release = r; });
      mkdirSync(path, { recursive: true }); // what the owner election does to the ancestors of a store it opens
    } });
    comparer.handle(sample());
    await inside;
    rmSync(dir, { recursive: true, force: true }); // stop --delete
    release(); await comparer.idle();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('shadow mode off', () => {
  test('the engine factory hands out the bare engine and no preimage read happens', async () => {
    const home = tmp();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const engine = await createEngine(config);
      await engine.connect(config);
      try {
        await engine.initSchema();
        const watch = watchPreimage(engine);
        await engine.putPage('people/off-example', page('Off Example'));
        await engine.deletePage('people/off-example');
        expect(watch.count()).toBe(0);
        watch.restore();
        expect(existsSync(join(home, '.gbrain', 'shadow'))).toBe(false); // nothing of shadow mode was even created
      } finally { await engine.disconnect(); }
    });
  }, 60_000);
});
