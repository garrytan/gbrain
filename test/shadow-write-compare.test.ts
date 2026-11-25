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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WRITE_COVERAGE_LIMIT, WRITE_NOT_RECORDED, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus, renderFollowStatus } from '../src/shadow/follow-status.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { configDir } from '../src/core/config.ts';
import { shadowRoot } from '../src/shadow/state.ts';
import { scratchRootDefault } from '../src/shadow/write-compare-child.ts';
import { movedOutsideFootprint, pageRefs, type WriteEvent } from '../src/shadow/write-compare.ts';
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
    expect(comparer.counts()).toMatchObject({ comparable: 0, unexplained_difference: 0 });
  });


  test('a sampled comparison changes no criterion 5 state: the outcomes go nowhere, status reads capability_missing with zero counts, and nothing is written', async () => {
    const dir = tmp();
    ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as never, NOW.getTime());
    const state = { sample_rate: 0.1 } as never;
    const before = readdirSync(dir).sort();
    const event: WriteEvent = { t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] } };
    const comparer = fakeComparer(dir, { record: false }); // as the product wires it today: no sink
    await settle(comparer, [event, { t: 'write', op: 'addTag', outcome: 'capability_missing', family: 'tags' }, { t: 'write', op: 'putPage', outcome: 'uncomparable', reason: 'in_transaction' }]);
    expect(readdirSync(dir).sort()).toEqual(before);
    const status = buildFollowStatus(dir, state, NOW);
    expect(status.write_comparisons).toEqual({ state: 'capability_missing', sample_rate: 0.05, comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
    const row = row5({ write_comparisons: status.write_comparisons as ShadowStatus['write_comparisons'] });
    expect(row.state).toBe('missing');
    expect(row.detail).toContain(WRITE_NOT_RECORDED);
    expect(row.detail).toContain(WRITE_COVERAGE_LIMIT);
    expect(row.detail).toContain('every other write family is capability_missing');
    expect(renderFollowStatus(status).join('\n')).toContain(`${WRITE_NOT_RECORDED}; ${WRITE_COVERAGE_LIMIT}`);
    // A recording comparer (what the follow-up PR wires) still gets every outcome, so the code that makes them keeps its tests.
    const recording = fakeComparer(dir);
    await settle(recording, [event]);
    expect(recording.counts()).toMatchObject({ comparable: 1 });
    expect(buildFollowStatus(dir, state, NOW).write_comparisons.state).toBe('capability_missing');
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
    const comparer = fakeComparer(tmp());
    await settle(comparer, [sample({ moved: true }), sample()]);
    expect(comparer.counts()).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { moved: 1 } });
  });

  test('a second child never deletes the store a first one is using, and a dead process\'s leftover store is removed', async () => {
    const dir = tmp(); const scratch = tmp();
    let opened = ''; let release = (): void => {}; let entered = (): void => {};
    const inside = new Promise<void>((r) => { entered = r; });
    const first = fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => { opened = path; entered(); await new Promise<void>((r) => { release = r; }); } });
    first.handle(sample());
    await inside;
    mkdirSync(join(scratch, 'write-compare-2147483646-leftover')); // a pid that is not running
    fakeComparer(dir, { scratchRoot: scratch }); // another child starts in the same temp directory
    expect(existsSync(dirname(opened))).toBe(true);
    expect(existsSync(join(scratch, 'write-compare-2147483646-leftover'))).toBe(false);
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

describe('the data fence and the scratch location (lane owner ruling)', () => {
  const R = (o: Record<string, string>) => ({ ...o });
  const A = R({ id: '1', source_id: 'default', slug: 'a/x', title: 'X' }); const B = R({ id: '2', source_id: 'default', slug: 'a/y', title: 'Y' });
  const L = R({ id: '10', from_page_id: '1', to_page_id: '2', link_type: 'knows' });
  const pre = { sources: [], pages: [A, B], links: [L] };
  const sample = (over: Partial<WriteEvent> = {}): WriteEvent => ({ t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over });

  test('rows outside the write\'s footprint must be unchanged, and no link may appear that the write did not add', () => {
    const link = ['a/x', 'a/y', 'c', 'knows'];
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, B], links: [L] })).toBe(false);
    const added = R({ id: '11', from_page_id: '2', to_page_id: '1', link_type: 'knows' });
    const forward = ['a/y', 'a/x', 'c', 'knows'];
    expect(movedOutsideFootprint('addLink', forward, pre, { sources: [], pages: [A, B], links: [L, added] })).toBe(false); // the write's own link
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, B], links: [L, added] })).toBe(true); // a link nobody here wrote
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, { ...B, title: 'Edited elsewhere' }], links: [L] })).toBe(true); // a copied page changed
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A], links: [L] })).toBe(true); // a copied page is gone
    expect(movedOutsideFootprint('removeLink', ['a/x', 'a/y', 'knows'], pre, { sources: [], pages: [A, B], links: [] })).toBe(false); // the write's own link, removed
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [{ ...A, title: 'New' }, B], links: [L] })).toBe(false); // the page it writes
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [A, { ...B, title: 'Edited elsewhere' }], links: [L] })).toBe(true);
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [A, B], links: [] })).toBe(true); // a link it does not write is gone
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [B], links: [] })).toBe(false); // the page and its links go
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [{ ...B, title: 'Edited elsewhere' }], links: [] })).toBe(true);
    const farther = R({ id: '12', from_page_id: '2', to_page_id: '99', link_type: 'knows' });
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [B], links: [farther] })).toBe(false); // a link to a page that was never copied is not a change to the copy
    const jobs = { ...B, projection_job_revision: 'r1' };
    expect(movedOutsideFootprint('addLink', link, { ...pre, pages: [A, jobs] }, { sources: [], pages: [A, { ...jobs, projection_job_revision: 'r2' }], links: [L] })).toBe(false); // job-queue state is not an edit
  });

  test('a link another process adds between the same two pages, with another type or source, is not the write\'s own (a type or source it leaves out matches any)', () => {
    const typed = ['a/x', 'a/y', 'c', 'knows', 'markdown'];
    const other = R({ id: '13', from_page_id: '1', to_page_id: '2', link_type: 'works_at', link_source: 'markdown' });
    const same = R({ id: '14', from_page_id: '1', to_page_id: '2', link_type: 'knows', link_source: 'markdown' });
    const fromElsewhere = R({ id: '15', from_page_id: '1', to_page_id: '2', link_type: 'knows', link_source: 'frontmatter' });
    const after = (links: Array<Record<string, string>>) => ({ sources: [], pages: [A, B], links: [L, ...links] });
    expect(movedOutsideFootprint('addLink', typed, pre, after([same]))).toBe(false);
    expect(movedOutsideFootprint('addLink', typed, pre, after([other]))).toBe(true);
    expect(movedOutsideFootprint('addLink', typed, pre, after([fromElsewhere]))).toBe(true);
    expect(movedOutsideFootprint('addLink', ['a/x', 'a/y', 'c'], pre, after([other]))).toBe(false); // no type named: the documented gap
  });

  test('a copy that leaves out a column the Rust store does not keep is not that copy (uncomparable), except the one column the seed always reports', async () => {
    const dir = tmp();
    const withPage = sample({ pre: { sources: [], pages: [{ id: '1', source_id: 'default', slug: 'people/pat-example' }], links: [] } });
    const lossy = fakeComparer(dir, { imported: (rows) => ({ imported: rows, unmapped_columns: ['trust_level'] }) });
    await settle(lossy, [withPage]);
    expect(lossy.counts()).toMatchObject({ comparable: 0, uncomparable: 1, uncomparable_by_reason: { preimage_not_loaded: 1 } });
    const expected = fakeComparer(dir, { imported: (rows) => ({ imported: rows, unmapped_columns: ['generation'] }) });
    await settle(expected, [withPage]);
    expect(expected.counts()).toMatchObject({ comparable: 1, uncomparable: 0 });
  });

  test('scratch stores are in the gbrain data home beside shadow/, not in a shared temp directory, and not under the shadow directory', async () => {
    const home = tmp();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const root = scratchRootDefault();
      expect(root).toBe(join(configDir(), 'scratch'));
      expect(root.startsWith(shadowRoot())).toBe(false);
      expect(root.startsWith(tmpdir() + '/') && !root.startsWith(home)).toBe(false);
      expect(dirname(root)).toBe(dirname(shadowRoot()));
    });
  });

  test('every replay runs in a 0700 directory that is gone afterwards, however the replay ends', async () => {
    const dir = tmp(); const scratch = join(tmp(), 'scratch');
    const modes: number[] = [];
    const seen = (path: string): void => { modes.push(statSync(dirname(path)).mode & 0o777); };
    const ends = [fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => seen(path) }),
      fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => seen(path), put: async () => { throw new Error('refused'); } }),
      fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => { seen(path); throw new Error('cannot open'); } })];
    for (const comparer of ends) await settle(comparer, [sample()]);
    expect(modes).toEqual([0o700, 0o700, 0o700]);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(readdirSync(scratch)).toEqual([]);
    expect(ends.map((c) => c.counts().comparable)).toEqual([1, 0, 0]);
    expect(ends.map((c) => c.counts().uncomparable)).toEqual([0, 1, 1]);
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
