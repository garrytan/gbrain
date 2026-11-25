/**
 * Write comparisons for swap criterion 5 (src/shadow/write-compare.ts, write-capture.ts, write-compare-child.ts).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the count criterion 5 reads: a sampled page or link write is replayed on a scratch Rust
 * store and counted `comparable` only when the changed rows match. (2) Fails when a match is not counted, a mismatch is not unexplained,
 * a write from another family is counted anywhere but `capability_missing`, an uncomparable or unreadable write is ever `comparable`, or
 * criterion 5 leaves `missing` with no comparison behind it. (3) Nothing else compares writes. (4) The real scratch replay needs the
 * built addon and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error); everything else uses fake engines.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadiness, WRITE_COVERAGE_LIMIT, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { attachShadowParts } from '../src/shadow/attach.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus, renderFollowStatus } from '../src/shadow/follow-status.ts';
import { newMirrorCounters } from '../src/shadow/mirror.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { wrapShadowEngine } from '../src/shadow/wrapper.ts';
import { createWriteSampler } from '../src/shadow/write-capture.ts';
import { createWriteComparer } from '../src/shadow/write-compare-child.ts';
import { readWriteTally, WriteTally, type WriteEvent } from '../src/shadow/write-compare.ts';
import { fillSeedFixture, seedInto } from './helpers/shadow-seed-fixture.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);

const NOW = new Date('2026-12-01T00:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-')); dirs.push(d); return d; };
const page = (title: string) => ({ type: 'person', title, compiled_truth: `${title}.`, timeline: '' }) as never;
async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); }
}
const row5 = (doc: Partial<ShadowStatus>) => evaluateReadiness(doc as ShadowStatus, NOW).criteria.find((c) => c.n === 5)!;

let primary: PGLiteEngine;
beforeAll(async () => { primary = new PGLiteEngine(); await primary.connect({}); await primary.initSchema(); });
afterAll(async () => { await primary.disconnect(); });

/** The primary behind the write sampler at rate 1; `inbox` holds what a serving process would send the child. */
function rig(engine: PGLiteEngine = primary) { // a fresh sampler each time
  const inbox: WriteEvent[] = [];
  const sampler = createWriteSampler({ rate: 1, send: (line) => { inbox.push(JSON.parse(line)); return true; }, active: () => true });
  const sink = { counters: newMirrorCounters(), offer: () => {}, active: () => true };
  const wrapped = wrapShadowEngine(engine, sink, { sampleRate: 0, writes: sampler });
  return { inbox, wrapped };
}
/** A comparer over fake scratch engines: `put` stands for the Rust write and `back` for its read-back. */
function fakeComparer(dir: string, over: { imported?: (rows: number) => Record<string, unknown>; put?: () => Promise<void>; page?: unknown } = {}) {
  const comparer = createWriteComparer({
    dir, tally: new WriteTally(dir, () => 'e1'), alive: () => true, load: { ok: true, addon: {} } as never,
    openEngine: () => ({
      connect: async () => {}, disconnect: async () => {},
      storeFor: async () => ({ importRelation: async (_s: string, _r: string, rows: unknown[]) => ({ imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: [], losses: {}, ...over.imported?.(rows.length) }) }),
      putPage: over.put ?? (async () => {}), getPage: async () => over.page ?? null, getLinks: async () => [],
    }),
  });
  return { comparer };
}
const settle = async (c: { handle(e: WriteEvent): void; idle(): Promise<void> }, events: WriteEvent[]) => { for (const e of events) c.handle(e); await c.idle(); };

(HAVE_ADDON ? describe : describe.skip)('a sampled page or link write replayed on a scratch Rust store', () => {
  let addon: RustAddon;
  beforeAll(async () => { addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }); });

  async function replay(act: (engine: PGLiteEngine) => Promise<void>, expectEvents: number, tamper?: (e: WriteEvent) => void) {
    await resetPgliteState(primary);
    await fillSeedFixture(primary);
    const dir = tmp();
    const { inbox, wrapped } = rig();
    await act(wrapped);
    await until(() => inbox.length >= expectEvents);
    const tally = new WriteTally(dir, () => 'e1');
    const comparer = createWriteComparer({ dir, tally, alive: () => true, load: { ok: true, addon } as never });
    if (tamper) inbox.forEach(tamper);
    await settle(comparer, inbox);
    return { tally: readWriteTally(dir, 'e1')!, inbox, dir };
  }

  test('a write whose changed rows match is counted comparable (putPage, addLink, addLinksBatch, removeLink, deletePage)', async () => {
    const out = await replay(async (e) => {
      await e.putPage('people/dora-example', page('Dora Example'));
      await e.addLink('people/dora-example', 'companies/acme-example', 'works at', 'works_at');
      await e.addLinksBatch([{ from_slug: 'people/alice-example', to_slug: 'people/dora-example', link_type: 'knows', context: 'met' }]);
      await e.removeLink('people/alice-example', 'companies/acme-example', 'works_at');
      await e.deletePage('people/alice-example');
    }, 5);
    expect(out.tally).toMatchObject({ comparable: 5, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
    expect(existsSync(join(out.dir, 'scratch')) ? readdirSync(join(out.dir, 'scratch')) : []).toEqual([]); // every scratch store is deleted
  }, 120_000);

  test('a write whose changed rows differ is counted unexplained_difference, never comparable', async () => {
    const out = await replay(async (e) => { await e.putPage('people/dora-example', page('Dora Example')); }, 1, (ev) => {
      (ev.post as { pages: Array<{ title: string }> }).pages[0]!.title = 'Not What Rust Wrote';
    });
    expect(out.tally).toMatchObject({ comparable: 0, unexplained_difference: 1 });
  }, 60_000);

  test('a difference that comes with another write landing meanwhile is uncomparable, not unexplained', async () => {
    const out = await replay(async (e) => { await e.putPage('people/dora-example', page('Dora Example')); }, 1, (ev) => {
      (ev.post as { pages: Array<{ title: string }> }).pages[0]!.title = 'Changed By Someone Else';
      ev.moved = true;
    });
    expect(out.tally).toMatchObject({ comparable: 0, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { moved: 1 } });
  }, 60_000);

  test('a follow run with compared writes moves criterion 5 off missing (real child, seeded brain)', async () => {
    const home = tmp();
    await resetPgliteState(primary);
    await fillSeedFixture(primary);
    const { record } = await seedInto(primary, addon, home, 'pglite');
    writeSeedRecord(home, record);
    const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
    await withEnv({ GBRAIN_RUST_ENGINE_ADDON: BUILT }, async () => {
      const attached = attachShadowParts(primary, home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')] });
      try {
        await attached.engine.putPage('people/erin-example', page('Erin Example'));
        await attached.engine.addTag('people/erin-example', 'team'); // another family
        await until(() => (readWriteTally(home, buildFollowStatus(home, state as never, NOW).epoch_id)?.comparable ?? 0) >= 1 && (buildFollowStatus(home, state as never, NOW).write_comparisons.capability_missing ?? 0) >= 1, 90_000);
      } finally { attached.supervisor.stop(); attached.reconciler?.stop(); }
    });
    const status = buildFollowStatus(home, { sample_rate: 1 } as never, NOW);
    expect(status.write_comparisons).toMatchObject({ state: 'measured', comparable: 1, unexplained_difference: 0, capability_missing: 1, capability_missing_by_family: { tags: 1 } });
    const row = row5({ write_comparisons: status.write_comparisons as ShadowStatus["write_comparisons"] });
    expect(row.state).toBe('fail'); // below 1,000 comparable writes: said plainly, and no longer missing
    expect(row.detail).toContain('1 of 1000 comparable write comparisons');
    expect(row.detail).toContain(WRITE_COVERAGE_LIMIT);
    expect(renderFollowStatus(status).join('\n')).toContain('capability_missing 1 (by family: tags 1)');
  }, 180_000);
});

describe('write comparison counts', () => {
  test('a write from another family is capability_missing by family, and nothing else', async () => {
    const dir = tmp();
    const { inbox, wrapped } = rig();
    await wrapped.putPage('people/dora-example', page('Dora Example')); // pilot: not part of this test
    await wrapped.addTag('people/dora-example', 'team');
    await wrapped.softDeletePage('people/dora-example'); // a page member the pilot does not cover
    await until(() => inbox.some((e) => e.op === 'softDeletePage'));
    const others = inbox.filter((e) => e.op === 'addTag' || e.op === 'softDeletePage');
    expect(others.map((e) => [e.op, e.outcome, e.family, e.pre])).toEqual([['addTag', 'capability_missing', 'tags', undefined], ['softDeletePage', 'capability_missing', 'pages:softDeletePage', undefined]]);
    await settle(fakeComparer(dir).comparer, others);
    expect(readWriteTally(dir, 'e1')).toMatchObject({ comparable: 0, capability_missing: 2, capability_missing_by_family: { tags: 1, 'pages:softDeletePage': 1 } });
  });

  test('the child never takes a verdict from the serving process', async () => {
    const dir = tmp();
    const { comparer } = fakeComparer(dir);
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

  test('an uncomparable or unreadable write is never comparable', async () => {
    await resetPgliteState(primary);
    await fillSeedFixture(primary);
    const sample = async (act: (e: PGLiteEngine) => Promise<unknown>) => {
      const { inbox, wrapped } = rig();
      await act(wrapped).catch(() => undefined);
      await until(() => inbox.length >= 1);
      return inbox;
    };
    const tallyOf = async (events: WriteEvent[], over?: Parameters<typeof fakeComparer>[1]) => {
      const dir = tmp();
      await settle(fakeComparer(dir, over).comparer, events);
      return readWriteTally(dir, 'e1')!;
    };
    // The preimage could not be loaded into the scratch store (one row skipped).
    expect(await tallyOf(await sample((e) => e.putPage('people/alice-example', page('Alice Example'))), { imported: (rows) => ({ imported: rows - 1, skipped: 1 }) }))
      .toMatchObject({ comparable: 0, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { preimage_not_loaded: 1 } });
    // Rust refused the write.
    expect(await tallyOf(await sample((e) => e.putPage('people/frank-example', page('Frank Example'))), { put: async () => { throw new Error('refused'); } }))
      .toMatchObject({ comparable: 0, uncomparable: 1, uncomparable_by_reason: { rust_write_failed: 1 } });
    // A delete of a page the preimage does not hold compares nothing.
    const absent = await sample((e) => e.deletePage('people/never-example'));
    // The primary write failed (the link names no page), the write ran inside a transaction, and the preimage could not be read (the write still goes through).
    const failed = await sample((e) => e.addLink('people/nobody-example', 'people/ghost-example'));
    const inTx = await sample((e) => e.transaction((tx) => tx.putPage('people/gina-example', page('Gina Example'))));
    const snapshot = spyOn(primary, 'transaction').mockRejectedValueOnce(new Error('no snapshot'));
    const unreadable = await sample((e) => e.putPage('people/hank-example', page('Hank Example')));
    snapshot.mockRestore();
    expect(await primary.getPage('people/hank-example')).not.toBeNull();
    const events = [...failed, ...inTx, ...unreadable];
    expect(await tallyOf(events)).toMatchObject({
      comparable: 0, unexplained_difference: 0, uncomparable: 3, uncomparable_by_reason: { primary_write_failed: 1, in_transaction: 1, preimage_unreadable: 1 },
    });
    expect(await tallyOf(absent)).toMatchObject({ comparable: 0, unexplained_difference: 0, uncomparable: 1 });
  }, 60_000);
});
