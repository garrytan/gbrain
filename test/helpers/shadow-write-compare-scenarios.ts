/**
 * The write-comparison scenarios shared by test/shadow-write-compare.test.ts (PGLite) and test/e2e/shadow-write-compare.test.ts
 * (Postgres): the preimage read, the scratch replay with the real addon, the counts that must never be comparable, and the
 * promise that the pilot never changes what a primary write does. Everything here talks to a real primary.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateReadiness, WRITE_CLIENT_LIMIT, WRITE_COVERAGE_LIMIT, WRITE_COVERAGE_NAMED, WRITE_PGLITE_LIMIT, type ShadowStatus } from '../../src/core/engine-swap/readiness.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFile } from '../../src/core/import-file.ts';
import { assertPreparedFactWithdrawals } from '../../src/core/facts/withdrawal.ts';
import { writePageAliases } from '../../src/core/mentions/pass.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { performSync } from '../../src/commands/sync.ts';
import { runImport } from '../../src/commands/import.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { makeGitFixture } from '../helpers/git-fixture.ts';
import { mkdirSync } from 'node:fs';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { attachShadow, attachShadowParts, writeGeneration } from '../../src/shadow/attach.ts';
import { ShadowFollower } from '../../src/shadow/follower.ts';
import { buildFollowStatus, readFollowerFile, renderFollowStatus } from '../../src/shadow/follow-status.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import { writeSeedRecord } from '../../src/shadow/seed.ts';
import { wrapShadowEngine } from '../../src/shadow/wrapper.ts';
import { wrapShadowSibling } from '../../src/shadow/state.ts';
import { WRITE_BAR_CAP, WRITE_BAR_FLOOR } from '../../src/shadow/write-bar.ts';
import { completeWriteRow, insertPublicationEffects, lockPersistenceCounters, lockWriteRequest } from '../../src/core/engine-sql/persistence-journal.ts';
import { declarePersistence } from '../../src/core/engine-sql/persistence-declaration.ts';
import { publicationJournalStatements, sqlPublicationJournalStore } from '../../src/core/engine-sql/publication-journal.ts';
import { removeTimelineRows, updateTimelineDetails } from '../../src/core/engine-sql/timeline.ts';
import { deleteTakeRows } from '../../src/core/engine-sql/takes.ts';
import { deleteStalePageWriteGateReceipts } from '../../src/core/engine-sql/trust-write-gate.ts';
import { writeOpCheckpointRecords } from '../../src/core/engine-sql/op-checkpoint.ts';
import { writeSyncPassRow } from '../../src/core/engine-sql/sync-hold-store.ts';
import { advanceSyncCheckpoint } from '../../src/core/engine-sql/sources.ts';
import { sqlWrites } from '../../src/shadow/sql-writes.ts';
import { sealImportedPage } from '../../src/core/engine-sql/write-guards.ts';
import { renderFragment } from '../../src/core/engine-sql/fragment.ts';
import { pageSearchVectorSql } from '../../src/core/fts-language.ts';
import { bookkeepingStatements, createWriteSampler, JOURNAL_MEMBER_STATEMENTS, noComparedWrites, PUT_PAGE_OPTIONS, readPreimage } from '../../src/shadow/write-capture.ts';
import { completeEffectRow, lockEffectGuard } from '../../src/core/engine-sql/persistence-effect-worker.ts';
import { setEffectTransactionLimits } from '../../src/core/engine-sql/remote-links.ts';
import { lockEffectClaimRow } from '../../src/core/engine-sql/embedding-install.ts';
import { replaceWantedLinkRows } from '../../src/core/engine-sql/wanted-links.ts';
import { createWriteComparer } from '../../src/shadow/write-compare-child.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../../src/core/rust-engine.ts';
import { readWriteTally, WriteTally, type WriteEvent } from '../../src/shadow/write-compare.ts';
import { ensureEpoch, readEpoch } from '../../src/shadow/evidence-epoch.ts';
import { withEnv } from './with-env.ts';
import { withStoredSlug } from '../../src/core/utils.ts';
import { fillSeedFixture, seedInto } from './shadow-seed-fixture.ts';

export interface WriteCompareContext {
  primary: () => BrainEngine;
  /** Puts the primary back to an empty brain before a scenario (a clone per test needs nothing). */
  reset: () => Promise<void>;
  kind: 'pglite' | 'postgres';
  tempDir: () => string;
  /** The built addon and its path; absent where there is none (the replay scenarios then skip). */
  addon?: () => RustAddon;
  addonPath?: string;
}

const NOW = new Date('2026-12-01T00:00:00Z');
export const page = (title: string) => ({ type: 'person', title, compiled_truth: `${title}.`, timeline: '' }) as never;
export async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); }
}
export const row5 = (doc: Partial<ShadowStatus>) => evaluateReadiness(doc as ShadowStatus, NOW).criteria.find((c) => c.n === 5)!;

/** A real tally on `dir` under a fixed epoch, and what it holds (zero counts before its first write). `pid` is the child it stands for. */
export function tallyOn(dir: string, pid: number = process.pid) {
  const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' }, NOW.getTime()).epoch_id;
  const zero = { comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {} as Record<string, number>, uncomparable_by_reason: {} as Record<string, number>, in_flight: [] as number[] };
  return { tally: new WriteTally(dir, () => epoch, () => true, pid), epoch, counts: () => readWriteTally(dir, epoch) ?? zero };
}

/** A comparer over fake scratch engines: `imported` shapes the import result, `put` stands for the Rust write and `connect` for the store open (it gets the store path). `counts()` is what its tally holds; `tally` replaces the real one; `pid` is the child the tally stands for. */
export function fakeComparer(dir: string, over: { imported?: (rows: number) => Record<string, unknown>; put?: () => Promise<void>; page?: unknown; connect?: (path: string) => Promise<void>; scratchRoot?: string; alive?: () => boolean; tally?: WriteTally; pid?: number } = {}) {
  const on = tallyOn(dir, over.pid);
  const comparer = createWriteComparer({
    dir, tally: over.tally ?? on.tally, alive: over.alive ?? (() => true), load: { ok: true, addon: {} } as never, scratchRoot: over.scratchRoot,
    openEngine: (_addon, path) => ({
      connect: async () => { await over.connect?.(path); }, disconnect: async () => {},
      storeFor: async () => ({ importRelation: async (_s: string, _r: string, rows: unknown[]) => ({ imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: [], losses: {}, ...over.imported?.(rows.length) }) }),
      putPage: over.put ?? (async () => {}), getPage: async () => over.page ?? null, getLinks: async () => [],
    }),
  });
  return Object.assign(comparer, { counts: on.counts });
}
export const settle = async (c: { handle(e: WriteEvent): void; idle(): Promise<unknown> }, events: WriteEvent[]) => { for (const e of events) c.handle(e); await c.idle(); };

/** Counts the preimage reads an engine is asked for: they run inside a transaction, so this watches the SQL its transactions run. */
export function watchPreimage(engine: BrainEngine): { count: () => number; restore: () => void } {
  let n = 0;
  const real = engine.transaction.bind(engine) as (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
  const spy = spyOn(engine, 'transaction').mockImplementation(((fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => {
    let counted = false; // one preimage read is a few statements in one transaction
    return real((tx) => fn(new Proxy(tx, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target);
        if (prop !== 'executeRaw' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: unknown, ...rest: unknown[]) => { if (!counted && typeof sql === 'string' && sql.includes('shadow write preimage')) { counted = true; n++; } return value.call(target, sql, ...rest); };
      },
    })), opts);
  }) as never);
  return { count: () => n, restore: () => spy.mockRestore() };
}

/** What the write-counter scenarios share: the real wrapper with the real follower as its sink, a write from another process, and a hook between a commit and its read-back. */
function fenceKit(ctx: WriteCompareContext) {
  const primary = ctx.primary;
  const addonOf = (): RustAddon => ctx.addon!();
    const pg = ctx.kind === 'postgres';
    const putEvents = (inbox: WriteEvent[]) => inbox.filter((e) => e.op === 'putPage');
    const sampled = (inbox: WriteEvent[], op: string) => inbox.filter((e) => e.op === op && e.outcome === undefined);
    /** The real wrapper with the real follower as its sink, the follower's write count as the sampler's `generation` (attach.ts), and the real data fence where the brain has one. The follower reads nothing (no child): only its publish counters matter here. */
    function prod(opts: { generation?: () => number | undefined; send?: (line: string) => boolean; preimageTimeoutMs?: number } = {}) {
      const follower = new ShadowFollower({ reads: { pauseMs: 0, read: async () => { throw new Error('no reads in this rig'); }, close: async () => {} } as never, send: () => true, rpc: async () => { throw new Error('no child in this rig'); } });
      const inbox: WriteEvent[] = [];
      const sampler = createWriteSampler({ rate: 1, generation: opts.generation ?? writeGeneration(follower), send: opts.send ?? ((line) => { inbox.push(JSON.parse(line)); return true; }), active: () => true, preimageTimeoutMs: opts.preimageTimeoutMs });
      const sink = { counters: newMirrorCounters(), offer: () => {}, active: () => true };
      return { follower, inbox, wrapped: wrapShadowEngine(primary(), sink, { sampleRate: 0, follow: { sink: follower }, writes: sampler }) };
    }
    const opCtx = (wrapped: BrainEngine) => ({ engine: wrapped, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true }) as unknown as OperationContext;
    const replay = async (events: WriteEvent[]) => {
      const dir = ctx.tempDir(); const on = tallyOn(dir);
      await settle(createWriteComparer({ dir, tally: on.tally, alive: () => true, load: { ok: true, addon: addonOf() } as never, scratchRoot: ctx.tempDir() }), events);
      return on.counts();
    };
    /** A write from another process: a child bun process on its own connection to this database (Postgres only). */
    async function otherProcessWrite(sql: string, params: string[] = []): Promise<void> {
      if (!pg) { await primary().executeRaw(sql.replace(/\$1/g, `'${params[0]}'`)); return; } // PGLite: a second process cannot open the file (its single-writer lock), so the write is made unwrapped, as no other process could
      const [{ d }] = await primary().executeRaw<{ d: string }>('SELECT current_database() AS d');
      if (!d.startsWith('gbrain_test_')) throw new Error('refusing to write to a database that is not a test clone');
      const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${d}`;
      const child = Bun.spawn([process.execPath, '-e', "import postgres from '#postgres'; const s = postgres(process.env.OTHER_URL, { max: 1, prepare: false }); await s.unsafe(process.env.OTHER_SQL, JSON.parse(process.env.OTHER_PARAMS)); await s.end();"], {
        cwd: join(import.meta.dir, '..', '..'), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', OTHER_URL: url.toString(), OTHER_SQL: sql, OTHER_PARAMS: JSON.stringify(params) }, stdout: 'ignore', stderr: 'pipe',
      });
      if (await child.exited !== 0) throw new Error(`other process failed: ${await new Response(child.stderr).text()}`);
    }
    /** Runs `act` once, between the commit and the read-back of the first sampled write (the first read-back's page read). */
    function between(act: () => Promise<unknown>): { restore: () => void } {
      const realGetPage = primary().getPage as (...a: Parameters<BrainEngine['getPage']>) => ReturnType<BrainEngine['getPage']>; let once = true;
      // The read-back is the one getPage on the primary itself; the pin read (a nested transaction's engine, inside the sampled transaction) must not trigger it.
      const hook = spyOn(primary(), 'getPage').mockImplementation((async function (this: unknown, ...args: Parameters<BrainEngine['getPage']>) { if (once && this === primary()) { once = false; await act(); } return realGetPage.apply(this, args); }) as never);
      return { restore: () => hook.mockRestore() };
    }
    const fresh = async () => { await ctx.reset(); await fillSeedFixture(primary()); await primary().setConfig('search.contextual_retrieval', 'none'); };
  return { pg, putEvents, sampled, prod, opCtx, replay, otherProcessWrite, between, fresh };
}

export function defineWriteCompareScenarios(ctx: WriteCompareContext): void {
  const primary = ctx.primary;
  const addonOf = (): RustAddon => ctx.addon!();
  /** The primary behind the write sampler at rate 1; `inbox` holds what a serving process would send the child. */
  function rig(opts: { send?: (line: string) => boolean; preimageTimeoutMs?: number; lost?: (reason: string) => boolean; random?: () => number; generation?: () => number } = {}) {
    const inbox: WriteEvent[] = [];
    const sampler = createWriteSampler({ rate: 1, random: opts.random, generation: opts.generation, send: opts.send ?? ((line) => { inbox.push(JSON.parse(line)); return true; }), active: () => true, preimageTimeoutMs: opts.preimageTimeoutMs, lost: opts.lost });
    const sink = { counters: newMirrorCounters(), offer: () => {}, active: () => true };
    return { inbox, sampler, wrapped: wrapShadowEngine(primary(), sink, { sampleRate: 0, writes: sampler }) };
  }
  const tallyOf = async (events: WriteEvent[], over?: Parameters<typeof fakeComparer>[1]) => {
    const comparer = fakeComparer(ctx.tempDir(), over);
    await settle(comparer, events);
    return comparer.counts();
  };

  describe('the preimage read', () => {
    test('copies the page, its links and the pages they reach, and only the link between a pair for a link write', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const alice = { source: 'default', slug: 'people/alice-example' };
      const acme = { source: 'default', slug: 'companies/acme-example' };
      const forDelete = await readPreimage(primary(), 'deletePage', [alice]);
      expect(forDelete.pages.map((p) => p.slug).sort()).toEqual(['companies/acme-example', 'people/alice-example']); // the link's other end comes along
      expect(forDelete.links).toHaveLength(1);
      expect(forDelete.pages.every((p) => !('k0' in p) && typeof p.compiled_truth === 'string')).toBe(true);
      const forLink = await readPreimage(primary(), 'addLink', [alice, acme]);
      expect(forLink.links.map((l) => l.link_type)).toEqual(['works_at']);
      expect((await readPreimage(primary(), 'putPage', [{ source: 'default', slug: 'people/new-example' }])).pages).toEqual([]); // a page not there yet has no rows
    }, 60_000);

    test('a read that does not finish in time counts uncomparable (preimage_timeout) and the write still goes through', async () => {
      await ctx.reset();
      const hang = spyOn(primary(), 'transaction').mockImplementationOnce(() => new Promise(() => {}) as never);
      const { inbox, wrapped } = rig({ preimageTimeoutMs: 50 });
      await wrapped.putPage('people/slow-example', page('Slow Example'));
      hang.mockRestore();
      expect(await primary().getPage('people/slow-example')).not.toBeNull();
      expect(inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'preimage_timeout']]);
      expect((await tallyOf(inbox)).comparable).toBe(0);
    }, 60_000);
  });

  (ctx.addon ? describe : describe.skip)('a sampled page or link write replayed on a scratch Rust store', () => {
    const addonOf = (): RustAddon => ctx.addon!();

    async function replay(act: (engine: BrainEngine, sampled: (n: number) => Promise<void>) => Promise<void>, expectEvents: number, tamper?: (e: WriteEvent) => void) {
      await ctx.reset();
      await fillSeedFixture(primary());
      const dir = ctx.tempDir();
      const { inbox, wrapped } = rig();
      await act(wrapped, (n) => until(() => inbox.length >= n)); // a write that lands while an earlier sample is still being read back moves it
      await until(() => inbox.length >= expectEvents);
      const on = tallyOn(dir);
      const scratch = ctx.tempDir();
      const comparer = createWriteComparer({ dir, tally: on.tally, alive: () => true, load: { ok: true, addon: addonOf() } as never, scratchRoot: scratch });
      if (tamper) inbox.forEach(tamper);
      await settle(comparer, inbox);
      return { tally: on.counts(), inbox, dir, scratch };
    }

    test('a write whose changed rows match is counted comparable (putPage, addLink, addLinksBatch, removeLink, deletePage)', async () => {
      const out = await replay(async (e, sampled) => {
        await e.putPage('people/dora-example', page('Dora Example')); await sampled(1);
        await e.addLink('people/dora-example', 'companies/acme-example', 'works at', 'works_at'); await sampled(2);
        await e.addLinksBatch([{ from_slug: 'people/alice-example', to_slug: 'people/dora-example', link_type: 'knows', context: 'met' }]); await sampled(3);
        await e.removeLink('people/alice-example', 'companies/acme-example', 'works_at'); await sampled(4);
        await e.deletePage('people/alice-example');
      }, 5);
      expect(out.tally).toMatchObject({ comparable: 5, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
      expect(readdirSync(out.scratch)).toEqual([]); // every scratch store is deleted
    }, 120_000);

    test('a link write and a page edit inside a transaction are replayed after the commit and counted comparable (master counted the link write in_transaction and the pipelined edit in_transaction_busy)', async () => {
      const out = await replay(async (e, sampled) => {
        await e.transaction(async (tx) => { await tx.addLinksBatch([{ from_slug: 'people/alice-example', to_slug: 'companies/acme-example', link_type: 'mentions', context: 'in a transaction' }]); }); await sampled(1);
        const snapshot = await primary().readPageSnapshot('companies/acme-example');
        await e.transaction(async (tx) => { await Promise.all([tx.createVersion('companies/acme-example', { sourceId: 'default', preimage: snapshot } as never), tx.putPage('companies/acme-example', page('Acme Edited'), { sourceId: 'default', inline: true })]); }); await sampled(3);
      }, 3);
      expect(out.inbox.map((e) => [e.op, e.outcome])).toEqual([['addLinksBatch', undefined], ['createVersion', 'capability_missing'], ['putPage', undefined]]); // the version row is a family the pilot does not compare
      expect(out.tally).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0, capability_missing: 1 });
    }, 120_000);

    test('addLink, removeLink and deletePage inside a transaction are replayed after the commit and counted comparable; rolled back, they leave no sample and no change', async () => {
      const out = await replay(async (e, sampled) => {
        await e.transaction(async (tx) => { await tx.addLink('people/alice-example', 'companies/acme-example', 'in a transaction', 'works_at'); }); await sampled(1);
        await e.transaction(async (tx) => { await tx.removeLink('people/alice-example', 'companies/acme-example', 'works_at'); }); await sampled(2);
        for (const undo of [(tx: BrainEngine) => tx.addLink('people/alice-example', 'companies/acme-example', 'undone', 'invests_in'), (tx: BrainEngine) => tx.removeLink('people/alice-example', 'companies/acme-example'), (tx: BrainEngine) => tx.deletePage('people/alice-example')]) {
          await expect(e.transaction(async (tx) => { await undo(tx); throw new Error('roll back'); })).rejects.toThrow('roll back');
        }
        expect(await primary().getPage('people/alice-example')).not.toBeNull();
        await e.transaction(async (tx) => { await tx.deletePage('people/alice-example'); }); await sampled(3);
      }, 3);
      expect(out.inbox.map((e) => [e.op, e.outcome])).toEqual([['addLink', undefined], ['removeLink', undefined], ['deletePage', undefined]]); // the rolled-back ones sent nothing
      expect(out.tally).toMatchObject({ comparable: 3, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
    }, 120_000);

    test('forty samples handed to the child together all wait their turn and are replayed: none is shed queue_full (master kept 16 and shed the rest)', async () => {
      const out = await replay(async (e, sampled) => {
        for (let n = 1; n <= 40; n++) { await e.putPage(`people/burst-${n}-example`, page(`Burst ${n} Example`)); await sampled(n); }
      }, 40);
      expect(out.tally).toMatchObject({ comparable: 40, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
      expect(out.tally.uncomparable_by_reason.queue_full).toBeUndefined();
    }, 180_000);

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

    test('a sampled comparison through a real child is recorded: status reads measured, and the swap row counts it (a PGLite brain samples no write: nothing is recorded)', async () => {
      const home = ctx.tempDir();
      await ctx.reset();
      await fillSeedFixture(primary());
      const { record } = await seedInto(primary(), addonOf(), home, ctx.kind);
      writeSeedRecord(home, record);
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      let pid = 0;
      await withEnv({ GBRAIN_HOME: ctx.tempDir(), GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath! }, async () => {
        const attached = attachShadowParts(primary(), home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')], recordsWriteComparisons: true });
        try {
          await attached.engine.addTag('people/alice-example', 'team'); // another family, sampled too
          await until(() => (readFollowerFile(home)?.applied_rows ?? 0) > 0 && attached.supervisor.childPid !== null, 90_000); // its write is published before the next sample starts: another write landing meanwhile would move it
          await attached.engine.addLink('people/alice-example', 'companies/acme-example', 'again', 'invests_in'); // a direct pilot write, sampled at 1
          pid = attached.supervisor.childPid ?? 0;
          if (ctx.kind === 'postgres') await until(() => { const w = buildFollowStatus(home, state as never, NOW).write_comparisons; return w.comparable + w.uncomparable > 0 && w.capability_missing > 0; }, 90_000); // the sample is read back off the request path, then replayed by the child
          else await new Promise((r) => setTimeout(r, 500)); // PGLite: a sample would have been sent by now
        } finally { attached.supervisor.stop(); attached.reconciler?.stop(); }
      });
      if (pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 60_000); // the child drained what it was sent and exited
      const status = buildFollowStatus(home, state as never, NOW);
      if (ctx.kind === 'pglite') { // the sampler is not built, so the child saw no sample and recorded nothing
        expect(status.write_comparisons).toMatchObject({ state: 'capability_missing', comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
        expect(readdirSync(home).filter((f) => f.startsWith('write-comparisons'))).toEqual([]);
        return;
      }
      expect(status.write_comparisons).toMatchObject({ state: 'measured', sample_rate: 1, comparable: 1, unexplained_difference: 0, capability_missing: 1, capability_missing_by_family: { tags: 1 } });
      const row = row5({ write_comparisons: status.write_comparisons as ShadowStatus['write_comparisons'] });
      // 1 compared write is short of the brain's own bar. This brain has no qualifying-write history, so the bar is the
      // floor: min(cap, max(floor, window x 0)).
      expect(row.state).toBe('fail');
      expect(row.detail).toContain(`1 of ${WRITE_BAR_FLOOR} compared writes`);
      expect(row.detail).toContain(`bar ${WRITE_BAR_FLOOR} = min(${WRITE_BAR_CAP}, max(${WRITE_BAR_FLOOR}, `);
      expect(row.detail).toContain(WRITE_COVERAGE_LIMIT);
      expect(row.detail).toContain(WRITE_COVERAGE_NAMED); // the owner's wording, verbatim, names every write type left uncompared
      expect(row.detail).toContain('sampled so far: tags 1');
      expect(row.detail).toContain(WRITE_PGLITE_LIMIT);
      expect(renderFollowStatus(status).join('\n')).toContain(`comparable 1, unexplained 0`);
    }, 180_000);

    test('every write the sampler selects ends in the tally, also the one in flight when mirroring stops (it is never lost uncounted)', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite samples no write
      const home = ctx.tempDir();
      await ctx.reset();
      await fillSeedFixture(primary());
      const { record } = await seedInto(primary(), addonOf(), home, ctx.kind);
      writeSeedRecord(home, record);
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      let enabled = true; let selected = 0; let pid = 0;
      // Counts the sampler's own decisions (rate 1: every pilot write it is asked about), independently of what reaches the tally.
      const random = (): number => { if (new Error().stack?.includes('sampledWrite')) selected++; return 0; };
      await withEnv({ GBRAIN_HOME: ctx.tempDir(), GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath! }, async () => {
        // The state file is re-read on every send here (stateCheckMs 0); `enabled` stands for state.json, as `gbrain engine shadow stop` flips it.
        const attached = attachShadowParts(primary(), home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')], recordsWriteComparisons: true, random, supervisor: { stateCheckMs: 0, stillEnabled: () => enabled } });
        try {
          await attached.engine.addLink('people/alice-example', 'companies/acme-example', 'first', 'invests_in');
          await until(() => { const w = buildFollowStatus(home, state as never, NOW).write_comparisons; return w.comparable + w.uncomparable + w.unexplained_difference > 0; }, 90_000);
          pid = attached.supervisor.childPid ?? 0;
          enabled = false; // shadow mode is turned off while the next sampled write is being read back
          await attached.engine.removeLink('people/alice-example', 'companies/acme-example', 'invests_in');
          await until(() => attached.supervisor.disabled !== null, 30_000);
          await new Promise((r) => setTimeout(r, 1_000)); // its read-back and send attempt are done
        } finally { attached.supervisor.stop(); attached.reconciler?.stop(); }
      });
      if (pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 60_000); // the child drained what it was sent and exited
      const w = buildFollowStatus(home, state as never, NOW).write_comparisons;
      expect(selected).toBe(2);
      expect(w.comparable).toBe(1);
      // The second sample was selected while mirroring was on: it must be counted (uncomparable with a named reason), never vanish.
      expect({ total: w.comparable + w.unexplained_difference + w.uncomparable + w.capability_missing, uncomparable: w.uncomparable }).toEqual({ total: selected, uncomparable: 1 });
      expect(Object.keys(w.uncomparable_by_reason ?? {})).toHaveLength(1);
    }, 180_000);
  });

  describe('write comparison counts', () => {
  test('a write from another family is capability_missing by family, and nothing else', async () => {
    const dir = ctx.tempDir();
    const { inbox, wrapped } = rig();
    await wrapped.putPage('people/dora-example', page('Dora Example')); // pilot: not part of this test
    await wrapped.addTag('people/dora-example', 'team');
    await wrapped.softDeletePage('people/dora-example'); // a page member the pilot does not cover
    await until(() => inbox.some((e) => e.op === 'softDeletePage'));
    const others = inbox.filter((e) => e.op === 'addTag' || e.op === 'softDeletePage');
    expect(others.map((e) => [e.op, e.outcome, e.family, e.pre])).toEqual([['addTag', 'capability_missing', 'tags', undefined], ['softDeletePage', 'capability_missing', 'pages:softDeletePage', undefined]]);
    const comparer = fakeComparer(dir);
    await settle(comparer, others);
    expect(comparer.counts()).toMatchObject({ comparable: 0, capability_missing: 2, capability_missing_by_family: { tags: 1, 'pages:softDeletePage': 1 } });
  });


  test('an uncomparable or unreadable write is never comparable', async () => {
    await ctx.reset();
    await fillSeedFixture(primary());
    const sample = async (act: (e: BrainEngine) => Promise<unknown>) => {
      const { inbox, wrapped } = rig();
      await act(wrapped).catch(() => undefined);
      await until(() => inbox.length >= 1);
      return inbox;
    };
    const tallyOf = async (events: WriteEvent[], over?: Parameters<typeof fakeComparer>[1]) => {
      const comparer = fakeComparer(ctx.tempDir(), over);
      await settle(comparer, events);
      return comparer.counts();
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
    const inTx = await sample((e) => e.transaction((tx) => tx.transaction((nested) => nested.addLink('people/alice-example', 'companies/acme-example', 'in a transaction', 'invests_in')))); // a write in a nested transaction (a savepoint) is not compared
    const snapshot = spyOn(primary(), 'transaction').mockRejectedValueOnce(new Error('no snapshot'));
    const unreadable = await sample((e) => e.putPage('people/hank-example', page('Hank Example')));
    snapshot.mockRestore();
    expect(await primary().getPage('people/hank-example')).not.toBeNull();
    const events = [...failed, ...inTx, ...unreadable];
    expect(await tallyOf(events)).toMatchObject({
      comparable: 0, unexplained_difference: 0, uncomparable: 3, uncomparable_by_reason: { primary_write_failed: 1, in_transaction: 1, preimage_unreadable: 1 },
    });
    expect(await tallyOf(absent)).toMatchObject({ comparable: 0, unexplained_difference: 0, uncomparable: 1 });
  }, 60_000);

    test('samples the pipe refused are counted uncomparable on the next one (a full queue is never comparable)', async () => {
      let refuse = 2;
      const lines: string[] = [];
      const { wrapped } = rig({ send: (line) => { if (refuse-- > 0) return false; lines.push(line); return true; } });
      await ctx.reset();
      await wrapped.putPage('people/one-example', page('One Example'));
      await wrapped.putPage('people/two-example', page('Two Example'));
      await wrapped.putPage('people/three-example', page('Three Example'));
      await until(() => lines.length >= 1);
      const events = lines.map((l) => JSON.parse(l) as WriteEvent);
      expect(events[0]!.dropped).toBe(2);
      expect(await tallyOf(events.map((e) => ({ ...e, outcome: 'uncomparable', reason: 'x' })))).toMatchObject({ comparable: 0, uncomparable: 3, uncomparable_by_reason: { send_shed: 2, x: 1 } });
    }, 60_000);
  });

  describe('a sample that cannot reach the child is recorded by the serving process for the child to count (never lost)', () => {
    test('a refused send is reported as send_shed once, and the next line carries no dropped count (it would count twice)', async () => {
      let refuse = 1;
      const lost: string[] = []; const lines: string[] = [];
      const { wrapped } = rig({ send: (line) => { if (refuse-- > 0) return false; lines.push(line); return true; }, lost: (reason) => { lost.push(reason); return true; } });
      await ctx.reset();
      await wrapped.putPage('people/one-example', page('One Example'));
      await wrapped.putPage('people/two-example', page('Two Example'));
      await until(() => lines.length >= 1);
      expect(lost).toEqual(['send_shed']);
      expect(JSON.parse(lines[0]!).dropped).toBeUndefined();
    }, 60_000);

    test('a loss that cannot be recorded (no epoch yet, no writable directory) rides on the next accepted line, never vanishes', async () => {
      let refuse = 1;
      const lines: string[] = [];
      const { wrapped } = rig({ send: (line) => { if (refuse-- > 0) return false; lines.push(line); return true; }, lost: () => false });
      await ctx.reset();
      await wrapped.putPage('people/one-example', page('One Example'));
      await wrapped.putPage('people/two-example', page('Two Example'));
      await until(() => lines.length >= 1);
      expect(JSON.parse(lines[0]!).dropped).toBe(1);
    }, 60_000);

    test('a loss the journal could not take is retried at disconnect, with or without another sample, and keeps its own reason', async () => {
      const calls: Array<[string, boolean]> = [];
      let failFirst = 1; // the refused send's journal append fails
      const lost = (reason: string): boolean => { const ok = failFirst-- <= 0; calls.push([reason, ok]); return ok; };
      const { wrapped, sampler } = rig({ send: () => false, lost });
      await ctx.reset();
      await wrapped.putPage('people/one-example', page('One Example')); // refused; its journal append fails: the count is held in memory
      await until(() => calls.length >= 1);
      await sampler.settle(500); // no further sample comes: settle itself must hand the held count to the journal
      expect(calls).toEqual([['send_shed', false], ['send_shed', true]]);
    }, 60_000);

    test('a read-back abandoned at disconnect whose journal append fails is retried once more by settle, never left only in memory', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite samples no write
      const calls: Array<[string, boolean]> = []; let tries = 0;
      const lost = (reason: string): boolean => { const ok = ++tries > 1; calls.push([reason, ok]); return ok; };
      const { wrapped, sampler } = rig({ send: () => true, lost });
      await ctx.reset();
      const real = primary().transaction.bind(primary()) as (fn: unknown, opts?: unknown) => Promise<unknown>;
      let armed = false; let release = (): void => {};
      const stuck = new Promise<void>((resolve) => { release = resolve; });
      const spy = spyOn(primary(), 'transaction').mockImplementation(((fn: unknown, opts?: unknown) => (armed ? stuck.then(() => real(fn, opts)) : real(fn, opts))) as never);
      try {
        await wrapped.putPage('people/abandon-retry-example', page('Abandon Retry Example'));
        armed = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await sampler.settle(100);
        expect(calls).toEqual([['readback_abandoned', false], ['readback_abandoned', true]]);
      } finally { release(); spy.mockRestore(); }
    }, 60_000);

    (ctx.addon ? test : test.skip)('a refused sample never stalls a primary write: with an empty (crash-left) tally lock the write still returns at once, and the loss is recorded without the lock', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite samples no write
      const home = ctx.tempDir();
      await ctx.reset();
      await fillSeedFixture(primary());
      const { record } = await seedInto(primary(), addonOf(), home, ctx.kind);
      writeSeedRecord(home, record);
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      let enabled = true; let pid = 0;
      await withEnv({ GBRAIN_HOME: ctx.tempDir(), GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath! }, async () => {
        const attached = attachShadowParts(primary(), home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')], recordsWriteComparisons: true, random: () => 0, supervisor: { stateCheckMs: 0, stillEnabled: () => enabled } });
        const lock = join(home, 'write-comparisons.lock');
        try {
          await attached.engine.addLink('people/alice-example', 'companies/acme-example', 'first', 'invests_in');
          await until(() => { const w = buildFollowStatus(home, state as never, NOW).write_comparisons; return w.comparable + w.uncomparable + w.unexplained_difference > 0; }, 90_000);
          pid = attached.supervisor.childPid ?? 0;
          writeFileSync(lock, ''); // a lock a crashed process left: taking it would wait 10 seconds
          enabled = false; // the next sampled write's send is refused (it turns mirroring off)
          const started = Date.now();
          await attached.engine.addTag('people/alice-example', 'stall-probe'); // a write outside the pilot: its sample is sent before the write runs
          expect(Date.now() - started).toBeLessThan(2_000);
          const lostFiles = readdirSync(home).filter((n) => /^write-lost\.\d+\.jsonl$/.test(n));
          expect(lostFiles).toHaveLength(1);
          expect(readFileSync(join(home, lostFiles[0]!), 'utf8')).toContain('"reason":"send_shed"');
        } finally { rmSync(lock, { force: true }); attached.supervisor.stop(); attached.reconciler?.stop(); }
      });
      if (pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 60_000);
      const w = buildFollowStatus(home, state as never, NOW).write_comparisons;
      expect(w.uncomparable_by_reason?.send_shed).toBe(1); // the child that exited folded it into its epoch's tally
    }, 180_000);

    test('a read-back still running at disconnect is counted readback_abandoned once, and sends nothing when it ends late', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite samples no write
      const lost: string[] = []; const lines: string[] = [];
      const { wrapped, sampler } = rig({ send: (line) => { lines.push(line); return true; }, lost: (reason) => { lost.push(reason); return true; } });
      await ctx.reset();
      const real = primary().transaction.bind(primary()) as (fn: unknown, opts?: unknown) => Promise<unknown>;
      let calls = 0; let armed = false; let release = (): void => {};
      const stuck = new Promise<void>((resolve) => { release = resolve; });
      // Once the write itself is done, the data fence after the read-back (a transaction) waits until released.
      const spy = spyOn(primary(), 'transaction').mockImplementation(((fn: unknown, opts?: unknown) => (armed ? (calls++, stuck.then(() => real(fn, opts))) : real(fn, opts))) as never);
      try {
        await wrapped.putPage('people/abandon-example', page('Abandon Example'));
        armed = true;
        await until(() => calls >= 1);
        await sampler.settle(100);
        expect(lost).toEqual(['readback_abandoned']);
        release();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(lines).toHaveLength(0); // counted once, here: never also sent
        expect(lost).toEqual(['readback_abandoned']);
      } finally { release(); spy.mockRestore(); }
    }, 60_000);
  });

  describe('what a sampled write copies and reads back (review findings)', () => {
    const SOURCE = 'team-example';
    const addSource = (): Promise<unknown> => primary().executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SOURCE]);

    test('a putPage into a named source copies that source, even for a page that is not there yet, and reads that source back', async () => {
      await ctx.reset();
      await addSource();
      const { inbox, wrapped } = rig();
      await wrapped.putPage('people/zed-example', page('Zed Example'), { sourceId: SOURCE } as never);
      await until(() => inbox.length >= 1);
      expect(inbox[0]!.pre!.pages).toEqual([]);
      expect(inbox[0]!.pre!.sources.map((r) => r.id)).toEqual([SOURCE]);
      expect(((inbox[0]!.post as { pages: Array<{ source_id: string }> }).pages[0])?.source_id).toBe(SOURCE);
    }, 60_000);

    (ctx.addon ? test : test.skip)('and the scratch replay of it matches, so it counts comparable', async () => {
      await ctx.reset();
      await addSource();
      const { inbox, wrapped } = rig();
      await wrapped.putPage('people/zed-example', page('Zed Example'), { sourceId: SOURCE } as never);
      await until(() => inbox.length >= 1);
      const dir = ctx.tempDir(); const on = tallyOn(dir);
      await settle(createWriteComparer({ dir, tally: on.tally, alive: () => true, load: { ok: true, addon: addonOf() } as never, scratchRoot: ctx.tempDir() }), inbox);
      expect(on.counts()).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 0 });
    }, 60_000);

    test('a link whose origin page is named without a source takes the origin from the default source, not the from-source', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      await addSource();
      await primary().putPage('people/ann-example', page('Ann Example'), { sourceId: SOURCE } as never);
      await primary().putPage('people/bea-example', page('Bea Example'), { sourceId: SOURCE } as never);
      const { inbox, wrapped } = rig();
      await wrapped.addLink('people/ann-example', 'people/bea-example', 'knows', 'knows', 'markdown', 'people/alice-example', 'frontmatter', { fromSourceId: SOURCE, toSourceId: SOURCE } as never);
      await until(() => inbox.length >= 1);
      expect(inbox[0]!.pre!.pages.map((p) => `${p.source_id}/${p.slug}`).sort()).toEqual(['default/people/alice-example', `${SOURCE}/people/ann-example`, `${SOURCE}/people/bea-example`]);
    }, 60_000);

    test('a write that names more pages than a copy can hold is refused before anything is read, and still goes through', async () => {
      await ctx.reset();
      const links = Array.from({ length: 30 }, (_, i) => ({ from_slug: `people/m${i}-example`, to_slug: `people/n${i}-example`, link_type: 'knows' }));
      const watch = watchPreimage(primary());
      const getPage = spyOn(primary(), 'getPage');
      try {
        const { inbox, wrapped } = rig();
        await wrapped.addLinksBatch(links as never);
        await until(() => inbox.length >= 1);
        expect(inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'preimage_too_large']]);
        expect(watch.count()).toBe(0);
        expect(getPage).not.toHaveBeenCalled();
      } finally { watch.restore(); getPage.mockRestore(); }
    }, 60_000);

    test('a read-back that cannot be encoded (a segmented page whose body getters throw) is one more uncomparable sample, never an unhandled rejection', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const unhandled: unknown[] = [];
      const listen = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', listen);
      const segmented = Object.defineProperty({ slug: 'people/alice-example' }, 'compiled_truth', { enumerable: true, get: () => { throw new Error('page_body_segmented'); } });
      const getPage = spyOn(primary(), 'getPage').mockResolvedValue(segmented as never);
      try {
        const { inbox, wrapped } = rig();
        await wrapped.addLink('people/alice-example', 'companies/acme-example', 'also', 'works_at');
        await until(() => inbox.length >= 1);
        await new Promise((r) => setTimeout(r, 100));
        expect(inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'readback_failed']]);
        expect(unhandled).toEqual([]);
      } finally { process.off('unhandledRejection', listen); getPage.mockRestore(); }
    }, 60_000);

    test('a write that another process lands between the copy and the read-back makes the sample uncomparable (moved) on a brain others can write, and PGLite skips the fence', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      await primary().putPage('people/bob-example', page('Bob Example'));
      const real = primary().addLink.bind(primary());
      const link = spyOn(primary(), 'addLink').mockImplementation((async (...a: Parameters<typeof real>) => { await real(...a); await primary().putPage('people/bob-example', page('Bob Edited Elsewhere')); }) as never);
      try {
        const { inbox, wrapped } = rig();
        await wrapped.addLink('people/alice-example', 'people/bob-example', 'knows', 'knows');
        await until(() => inbox.length >= 1);
        expect(Boolean(inbox[0]!.moved)).toBe(ctx.kind === 'postgres'); // PGLite has one writer process (its file lock), so it skips the fence
      } finally { link.mockRestore(); }
    }, 60_000);

    test('a putPage whose read-back revision is not the revision the write returned is uncomparable (moved) on a brain others can write', async () => {
      await ctx.reset();
      const real = primary().putPage.bind(primary());
      const put = spyOn(primary(), 'putPage').mockImplementation((async (...a: Parameters<typeof real>) => ({ ...(await real(...a)), knowledge_revision: 'a-revision-from-somewhere-else' })) as never);
      try {
        const { inbox, wrapped } = rig();
        await wrapped.putPage('people/rev-example', page('Rev Example'));
        await until(() => inbox.length >= 1);
        expect(Boolean(inbox[0]!.moved)).toBe(ctx.kind === 'postgres');
      } finally { put.mockRestore(); }
    }, 60_000);

    test('a read whose deadline passes during its catalog statement stops before the page statement (cancellation is checked between every statement)', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const signal = { aborted: false };
      let pageStatements = 0;
      const real = primary().transaction.bind(primary()) as (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
      const spy = spyOn(primary(), 'transaction').mockImplementation(((fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => real((tx) => fn(new Proxy(tx, {
        get: (target, prop) => {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'executeRaw' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
          return async (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('shadow write preimage')) pageStatements++;
            const out = await value.call(target, sql, ...rest);
            if (typeof sql === 'string' && sql.includes('pg_attribute')) signal.aborted = true; // the deadline passes while the catalog read runs
            return out;
          };
        },
      })), opts)) as never);
      try {
        await expect(readPreimage(primary(), 'putPage', [{ source: 'default', slug: 'people/alice-example' }], signal)).rejects.toThrow('preimage_aborted');
        expect(pageStatements).toBe(0);
      } finally { spy.mockRestore(); }
    }, 60_000);

    test('a page that is soft-deleted, or a source with a withdrawn or purged fact, is not copied: the sample is uncomparable and the write still goes through', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      await primary().softDeletePage('companies/acme-example');
      const gone = rig();
      await gone.wrapped.removeLink('people/alice-example', 'companies/acme-example', 'works_at');
      await until(() => gone.inbox.length >= 1);
      expect(gone.inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'soft_deleted_page']]);
      await primary().restorePage('companies/acme-example');
      await primary().executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', '*', 'h1')");
      try {
        const overlay = rig();
        await overlay.wrapped.addLink('people/alice-example', 'companies/acme-example', 'again', 'invests_in');
        await until(() => overlay.inbox.length >= 1);
        expect(overlay.inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'fact_overlay']]);
        expect(await primary().getLinks('people/alice-example')).toHaveLength(1); // the earlier removal and this addition both went through
      } finally { await primary().executeRaw("DELETE FROM fact_withdrawals WHERE fact_hash = 'h1'"); }
    }, 60_000);

    test('a withdrawn or purged fact covers a putPage target that is not there yet (its source and slug), so the new page is uncomparable on both engines', async () => {
      await ctx.reset();
      const target = { source: 'default', slug: 'people/new-example' };
      const insert = (table: string, subject: string): Promise<unknown> => primary().executeRaw(`INSERT INTO ${table} (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', $1, 'h2')`, [subject]);
      const clear = async (): Promise<void> => { await primary().executeRaw("DELETE FROM fact_withdrawals WHERE fact_hash = 'h2'"); await primary().executeRaw("DELETE FROM fact_purges WHERE fact_hash = 'h2'"); };
      try {
        await expect(readPreimage(primary(), 'putPage', [target])).resolves.toMatchObject({ pages: [] }); // control: no overlay, no page
        for (const [table, subject] of [['fact_withdrawals', '*'], ['fact_withdrawals', target.slug], ['fact_purges', '*'], ['fact_purges', target.slug]] as const) {
          await insert(table, subject);
          await expect(readPreimage(primary(), 'putPage', [target])).rejects.toThrow('fact_overlay');
          await clear();
        }
        await insert('fact_withdrawals', 'people/someone-else-example'); // another page's withdrawal does not cover it
        await expect(readPreimage(primary(), 'putPage', [target])).resolves.toMatchObject({ pages: [] });
        const { inbox, wrapped } = rig();
        await clear(); await insert('fact_withdrawals', '*');
        await wrapped.putPage(target.slug, page('New Example'));
        await until(() => inbox.length >= 1);
        expect(inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'fact_overlay']]);
        expect(await primary().getPage(target.slug)).not.toBeNull(); // the write itself went through
      } finally { await clear(); }
    }, 60_000);

    (ctx.kind === 'pglite' ? test : test.skip)('on a single-connection engine a read that ran out of time ends at its next statement, so the write behind it is not held for the read', async () => {
      await ctx.reset();
      let release = (): void => {};
      const holder = primary().transaction(async () => { await new Promise<void>((r) => { release = r; }); });
      const watch = watchPreimage(primary());
      try {
        const { inbox, wrapped } = rig({ preimageTimeoutMs: 50 });
        const write = wrapped.putPage('people/held-example', page('Held Example'));
        await new Promise((r) => setTimeout(r, 200)); // the read is queued behind the holder and its deadline has passed
        release();
        await holder; await write;
        expect(watch.count()).toBe(0); // the abandoned read never ran a statement
        expect(inbox.map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'preimage_timeout']]);
        expect(await primary().getPage('people/held-example')).not.toBeNull();
      } finally { release(); watch.restore(); }
    }, 60_000);
  });

  describe('the pilot never changes what a primary write does', () => {
    // What each engine generates for itself on every run (ids, clocks, a random revision) is left out of both sides.
    const GENERATED = new Set(['id', 'knowledge_revision', 'created_at', 'updated_at', 'ingested_at', 'salience_touched_at', 'text_projection_revision']);
    const plain = (v: unknown): string => JSON.stringify(v, (k, x) => (GENERATED.has(k) ? undefined : x));
    const STEPS: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
      ['new page', (e) => e.putPage('people/dora-example', page('Dora Example'))],
      ['update', (e) => e.putPage('people/dora-example', page('Dora Example Again'))],
      ['link', (e) => e.addLink('people/dora-example', 'companies/acme-example', 'works at', 'works_at')],
      ['batch', (e) => e.addLinksBatch([{ from_slug: 'people/alice-example', to_slug: 'people/dora-example', link_type: 'knows', context: 'met' }])],
      ['unlink', (e) => e.removeLink('people/alice-example', 'companies/acme-example', 'works_at')],
      ['link to nothing', (e) => e.addLink('people/dora-example', 'people/ghost-example')],
      ['in a transaction', (e) => e.transaction((tx) => tx.putPage('people/gina-example', page('Gina Example')))],
      ['delete', (e) => e.deletePage('people/alice-example')],
      ['delete nothing', (e) => e.deletePage('people/never-example')],
    ];
    async function run(engineOf: () => { wrapped: BrainEngine; settled: () => Promise<void> }) {
      await ctx.reset();
      await fillSeedFixture(primary());
      const { wrapped, settled } = engineOf();
      const outcomes: string[] = [];
      for (const [name, step] of STEPS) {
        try { outcomes.push(`${name}: ${plain(await step(wrapped))}`); } catch (error) { outcomes.push(`${name}: threw ${(error as Error).message}`); }
      }
      await settled();
      const rows = {
        pages: await primary().executeRaw('SELECT source_id, slug, type, title, compiled_truth, content_hash, frontmatter::text AS frontmatter, deleted_at IS NOT NULL AS deleted FROM pages ORDER BY source_id, slug'),
        links: await primary().executeRaw('SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.context, l.link_source FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id ORDER BY 1, 2, 3'),
      };
      return { outcomes, stored: plain(rows) };
    }

    test('every result and every stored row is identical with the pilot on and with it off', async () => {
      const off = await run(() => ({ wrapped: primary(), settled: async () => {} }));
      let inbox: WriteEvent[] = [];
      const on = await run(() => { const r = rig(); inbox = r.inbox; return { wrapped: r.wrapped, settled: () => until(() => inbox.length >= STEPS.length) }; });
      expect(inbox).toHaveLength(STEPS.length); // the pilot really ran: one sample per write, whether or not it could be compared
      expect(inbox.some((e) => e.pre)).toBe(true);
      expect(on.outcomes).toEqual(off.outcomes);
      expect(on.stored).toBe(off.stored);
      expect(off.outcomes.some((o) => o.includes('threw'))).toBe(true); // failures match too
    }, 120_000);

    test('the write sample rate, not the read rate, decides which writes are copied', async () => {
      await ctx.reset();
      const seeded = (): string => { const dir = ctx.tempDir(); writeFileSync(join(dir, 'seed.json'), JSON.stringify({ version: 1, seed_id: 's', digests: true })); return dir; };
      const attach = (write_sample_rate: number | undefined) => attachShadowParts(primary(), seeded(), { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind } as never, { gbrainArgv: ['unused'], random: () => 0.5, recordsWriteComparisons: true });
      const watch = watchPreimage(primary());
      // random() is 0.5: a read share of 1 would take every write, the default write share of 0.05 takes none.
      const byDefault = attach(undefined);
      await byDefault.engine.putPage('people/rate-example', page('Rate Example'));
      byDefault.supervisor.stop(); byDefault.reconciler?.stop();
      expect(watch.count()).toBe(0);
      const raised = attach(0.9);
      await raised.engine.putPage('people/rate-example', page('Rate Example Again'));
      raised.supervisor.stop(); raised.reconciler?.stop();
      expect(watch.count()).toBe(ctx.kind === 'postgres' ? 1 : 0); // a PGLite brain samples no write, whatever the rate
      watch.restore();
    }, 60_000);

    test('with no shadow attached, or one that was never seeded, no preimage read happens at all', async () => {
      await ctx.reset();
      const watch = watchPreimage(primary());
      await primary().putPage('people/bare-example', page('Bare Example'));
      await primary().deletePage('people/bare-example');
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      const attached = attachShadowParts(primary(), ctx.tempDir(), state as never, { gbrainArgv: ['unused'], recordsWriteComparisons: true }); // no seed.json: nothing to compare against
      await attached.engine.putPage('people/unseeded-example', page('Unseeded Example'));
      await attached.engine.deletePage('people/unseeded-example');
      attached.supervisor.stop();
      expect(watch.count()).toBe(0);
      // The same engine and the same writes do read once a seeded shadow samples them: the detector can find a positive.
      const seeded = ctx.tempDir();
      writeFileSync(join(seeded, 'seed.json'), JSON.stringify({ version: 1, seed_id: 's', digests: true }));
      const on = attachShadowParts(primary(), seeded, state as never, { gbrainArgv: ['unused'], recordsWriteComparisons: true });
      await on.engine.putPage('people/seeded-example', page('Seeded Example'));
      on.supervisor.stop(); on.reconciler?.stop();
      expect(watch.count()).toBe(ctx.kind === 'postgres' ? 1 : 0);
      watch.restore();
    }, 60_000);

    test('a caller that does not say the child records comparisons gets no sampling and no pre-read, and the primary write is unchanged', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const watch = watchPreimage(primary());
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      const seeded = (): string => { const dir = ctx.tempDir(); writeFileSync(join(dir, 'seed.json'), JSON.stringify({ version: 1, seed_id: 's', digests: true })); return dir; };
      const quiet = attachShadowParts(primary(), seeded(), state as never, { gbrainArgv: ['unused'] }); // seeded, rate 1, no recorder flag: nothing is sampled
      try {
        await quiet.engine.putPage('people/quiet-example', page('Quiet Example'));
        await quiet.engine.addLink('people/alice-example', 'people/quiet-example', 'knows', 'knows');
        await quiet.engine.removeLink('people/alice-example', 'people/quiet-example', 'knows');
        await quiet.engine.deletePage('people/quiet-example');
      } finally { quiet.supervisor.stop(); quiet.reconciler?.stop(); }
      expect(watch.count()).toBe(0);
      expect(await primary().getPage('people/quiet-example')).toBeNull(); // the writes themselves all went through
      const loud = attachShadowParts(primary(), seeded(), state as never, { gbrainArgv: ['unused'], recordsWriteComparisons: true }); // the same writes with a recorder wired do read
      try { await loud.engine.addLink('people/alice-example', 'companies/acme-example', 'again', 'invests_in'); } finally { loud.supervisor.stop(); loud.reconciler?.stop(); }
      expect(watch.count()).toBe(ctx.kind === 'postgres' ? 1 : 0);
      watch.restore();
    }, 60_000);

    test('a PGLite brain samples no write even with a recorder wired: no pre-read, the write is unchanged, and status and the swap report say PGLite records none', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const watch = watchPreimage(primary());
      const home = ctx.tempDir(); writeFileSync(join(home, 'seed.json'), JSON.stringify({ version: 1, seed_id: 's', digests: true }));
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      const attached = attachShadowParts(primary(), home, state as never, { gbrainArgv: ['unused'], recordsWriteComparisons: true });
      try {
        await attached.engine.addLink('people/alice-example', 'companies/acme-example', 'again', 'invests_in');
        await attached.engine.addTag('people/alice-example', 'team');
        await new Promise((r) => setTimeout(r, 300)); // a sampled write would have read before it ran and sent its sample after
      } finally { attached.supervisor.stop(); attached.reconciler?.stop(); watch.restore(); }
      expect(await primary().getLinks('people/alice-example')).toHaveLength(2); // the writes went through
      if (ctx.kind === 'postgres') return; // Postgres samples (the recorded scenario above)
      expect(watch.count()).toBe(0);
      expect(readdirSync(home).filter((f) => f.startsWith('write-comparisons'))).toEqual([]);
      const status = buildFollowStatus(home, state as never, NOW);
      expect(status.write_comparisons.state).toBe('capability_missing');
      expect(row5({ write_comparisons: status.write_comparisons as ShadowStatus['write_comparisons'] }).detail).toContain(WRITE_PGLITE_LIMIT);
      expect(renderFollowStatus(status).join('\n')).toContain(`${WRITE_COVERAGE_LIMIT}; ${WRITE_PGLITE_LIMIT}; ${WRITE_CLIENT_LIMIT}`);
      expect(row5({ write_comparisons: status.write_comparisons as ShadowStatus['write_comparisons'] }).detail).toContain(WRITE_CLIENT_LIMIT);
    }, 60_000);

    test('the engine factory\'s entry point (attachShadow) says the child records comparisons, so a seeded shadow samples writes and reads before them', async () => {
      await ctx.reset();
      await fillSeedFixture(primary());
      const watch = watchPreimage(primary());
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, write_sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      const home = ctx.tempDir(); writeFileSync(join(home, 'seed.json'), JSON.stringify({ version: 1, seed_id: 's', digests: true }));
      try {
        await withEnv({ GBRAIN_HOME: ctx.tempDir() }, async () => { // its child stops when the primary disconnects at the end of the file
          await attachShadow(primary(), home, state as never).addLink('people/alice-example', 'companies/acme-example', 'once more', 'invests_in');
        });
        if (ctx.kind === 'postgres') expect(watch.count()).toBeGreaterThanOrEqual(1); // the data fence may read once more on Postgres, off the request path
        else expect(watch.count()).toBe(0);
      } finally { watch.restore(); }
    }, 60_000);
  });

  describe('a putPage inside a transaction (put_page, sync import) is compared after the commit', () => {
    const putEvents = (inbox: WriteEvent[]) => inbox.filter((e) => e.op === 'putPage');
    const verdicts = (inbox: WriteEvent[]) => putEvents(inbox).map((e) => [e.outcome ?? 'sample', e.reason]);
    const sampleOf = async (inbox: WriteEvent[], n = 1) => { await until(() => putEvents(inbox).length >= n); return putEvents(inbox); };
    const fresh = async () => { await ctx.reset(); await fillSeedFixture(primary()); return rig(); };

    test('an earlier write in the transaction to a page, link, chunk, tag or raw row is uncomparable (in_transaction_prior_write)', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const priors: Array<(tx: BrainEngine) => Promise<unknown>> = [
        (tx) => tx.addTag('people/alice-example', 'team'),
        (tx) => tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'invests_in'),
        (tx) => tx.deleteChunks('companies/acme-example'),
        (tx) => tx.executeRaw("UPDATE pages SET title = title WHERE slug = 'companies/acme-example'"),
        (tx) => tx.softDeletePage('people/never-example'),
      ];
      for (const prior of priors) {
        const { inbox, wrapped } = rig();
        await wrapped.transaction(async (tx) => { await prior(tx); await tx.putPage('people/new-example', page('New Example')); });
        await sampleOf(inbox);
        expect(verdicts(inbox)).toEqual([['uncomparable', 'in_transaction_prior_write']]);
      }
    }, 60_000);

    test('two writes to one page, sampled or not, and a link write touching the page, are uncomparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      let { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => { await tx.putPage('people/dora-example', page('Dora One')); await tx.putPage('people/dora-example', page('Dora Two')); });
      await sampleOf(inbox, 2);
      expect(verdicts(inbox)).toEqual([['uncomparable', 'in_transaction_same_page'], ['uncomparable', 'in_transaction_same_page']]);
      let n = 0; // the second write to the page is not sampled; the first still cannot be compared
      ({ inbox, wrapped } = rig({ random: () => (n++ === 0 ? 0 : 1) }));
      await wrapped.transaction(async (tx) => { await tx.putPage('people/dora-example', page('Dora Three')); await tx.putPage('people/dora-example', page('Dora Four')); });
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['uncomparable', 'in_transaction_same_page']]);
      ({ inbox, wrapped } = rig());
      await wrapped.transaction(async (tx) => { await tx.putPage('people/ella-example', page('Ella Example')); await tx.addLink('people/ella-example', 'companies/acme-example', 'x', 'invests_in'); });
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['uncomparable', 'in_transaction_later_write']]);
    }, 60_000);

    test('a rolled-back transaction drops its samples: nothing is counted and nothing is replayed', async () => {
      const { inbox, wrapped } = await fresh();
      await expect(wrapped.transaction(async (tx) => { await tx.putPage('people/eve-example', page('Eve Example')); throw new Error('roll back'); })).rejects.toThrow('roll back');
      await new Promise((r) => setTimeout(r, 300));
      expect(putEvents(inbox)).toEqual([]);
      expect(await primary().getPage('people/eve-example')).toBeNull();
      await wrapped.transaction(async (tx) => { await tx.putPage('people/eve-example', page('Eve Example')); });
      expect((await sampleOf(inbox)).length).toBe(1); // the committed one is sampled, with its rows
    }, 60_000);

    test('nothing is sent before the commit, and a sample is sent with the rows read before the write', async () => {
      const { inbox, wrapped } = await fresh();
      await wrapped.transaction(async (tx) => {
        await tx.putPage('companies/acme-example', page('Acme Renamed'));
        await new Promise((r) => setTimeout(r, 200));
        expect(putEvents(inbox)).toEqual([]);
      });
      const [event] = await sampleOf(inbox);
      expect(event!.pre!.pages.map((p) => p.title)).toEqual(expect.arrayContaining(['Acme Example'])); // the row before the write, not after
      expect(event!.moved).toBe(false);
    }, 60_000);

    test('a writer between the commit and the read-back leaves the sample uncomparable (moved), never comparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      let gen = 0; // PGLite has no data fence (one process writes): the serving process\'s write count says it; Postgres is caught by the fence alone
      const { inbox, wrapped } = rig(ctx.kind === 'pglite' ? { generation: () => gen } : {});
      const realGetPage = primary().getPage as (...a: Parameters<BrainEngine['getPage']>) => ReturnType<BrainEngine['getPage']>; let once = true;
      // Fires at the read-back (the getPage on the primary itself), not at the sampler's pin read, which runs on the transaction's own engine while the transaction still holds the page row: a writer started there would wait for that lock.
      const hook = spyOn(primary(), 'getPage').mockImplementation((async function (this: unknown, ...args: Parameters<BrainEngine['getPage']>) {
        if (once && this === primary()) { once = false; gen += 2; await primary().putPage('companies/acme-example', page('Acme Edited Elsewhere')); }
        return realGetPage.apply(this, args);
      }) as never);
      try {
        await wrapped.transaction(async (tx) => { await tx.putPage('companies/acme-example', page('Acme Renamed')); });
        const events = await sampleOf(inbox);
        expect(events[0]!.moved).toBe(true);
        expect(await tallyOf(events)).toMatchObject({ comparable: 0, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { moved: 1 } });
      } finally { hook.mockRestore(); }
    }, 60_000);

    test('an option the Rust store does not take is uncomparable (unknown_option), in a transaction or not; the ones it takes are not; the list is the store\'s own', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const unknown = [{ reuseSegments: {} }, { prepare: () => undefined }, { sourceId: 'default', somethingNew: 1 }];
      for (const opts of unknown) {
        for (const inTransaction of [false, true]) {
          const { inbox, wrapped } = rig();
          if (inTransaction) await wrapped.transaction(async (tx) => { await tx.putPage('people/opt-example', page('Opt Example'), opts as never); });
          else await wrapped.putPage('people/opt-example', page('Opt Example'), opts as never);
          await sampleOf(inbox);
          expect(verdicts(inbox)).toEqual([['uncomparable', 'unknown_option']]);
        }
      }
      const { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => { await tx.putPage('people/opt-example', page('Opt Example'), { sourceId: 'default', inline: true }); });
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['sample', undefined]]); // a full sample: its rows go to the replay
      const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'core', 'rust-engine', 'store-members', 'pages.ts'), 'utf8');
      const taken = /takeOptions\('putPage', opts, \[([^\]]*)\], \[([^\]]*)\]\)/.exec(source)!.slice(1).flatMap((list) => [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
      expect([...PUT_PAGE_OPTIONS].sort()).toEqual(taken.sort());
    }, 60_000);

    test('a preimage read that fails on the database leaves the transaction usable: the write and a later one commit, and the sample is uncomparable', async () => {
      const { inbox, wrapped } = await fresh();
      const original = primary().executeRaw as (...a: unknown[]) => Promise<unknown>; // the transaction's engine inherits this member, so it is called with the caller's own `this`
      const spy = spyOn(primary(), 'executeRaw').mockImplementation(function (this: unknown, sql: unknown, ...rest: unknown[]) {
        return (original as Function).call(this, typeof sql === 'string' && sql.includes('shadow write preimage') ? 'SELECT 1 FROM shadow_no_such_table' : sql, ...rest); // a failure on the database, with the transaction open
      } as never);
      try {
        await wrapped.transaction(async (tx) => { await tx.putPage('people/gus-example', page('Gus Example')); await tx.addTag('people/gus-example', 'kept'); });
      } finally { spy.mockRestore(); }
      expect((await primary().getPage('people/gus-example'))?.title).toBe('Gus Example');
      expect(await primary().getTags('people/gus-example')).toEqual(['kept']);
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['uncomparable', 'preimage_unreadable']]);
    }, 60_000);

    test('a member that returns a plain value is not held while the preimage is read (it returns its function, never a promise)', async () => {
      const { inbox, wrapped } = await fresh();
      let seen: unknown = 'unset';
      await wrapped.transaction(async (tx) => {
        const put = tx.putPage('people/hugh-example', page('Hugh Example')); // the preimage read is open from here
        seen = tx.registerBeforeDisconnect(async () => undefined);
        await put;
      });
      expect(typeof seen).toBe('function'); // the unregister function itself
      (seen as () => void)();
      expect((await sampleOf(inbox)).length).toBe(1);
    }, 60_000);

    test('a write that is not alone on the transaction waits for the calls ahead of it before its savepoint: concurrent inline page writes and a pipelined version row all survive the commit, and each write is compared', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().putPage('people/kim-example', page('Kim Example'));
      const { inbox, wrapped } = rig();
      const snapshot = await primary().readPageSnapshot('people/kim-example');
      await wrapped.transaction(async (tx) => {
        await Promise.all([ // sent together, as a pipelined import sends its writes
          tx.putPage('people/lee-example', page('Lee Example'), { sourceId: 'default', inline: true }),
          tx.putPage('people/max-example', page('Max Example'), { sourceId: 'default', inline: true }),
          tx.createVersion('people/kim-example', { sourceId: 'default', preimage: snapshot } as never),
          tx.putPage('people/kim-example', page('Kim Renamed'), { sourceId: 'default', inline: true }),
        ]);
      });
      for (const slug of ['people/lee-example', 'people/max-example']) expect(await primary().getPage(slug)).not.toBeNull();
      expect((await primary().getPage('people/kim-example'))?.title).toBe('Kim Renamed');
      expect(await primary().getVersions('people/kim-example')).toHaveLength(1); // the version row is not rolled back with a savepoint
      await sampleOf(inbox, 3);
      expect(verdicts(inbox)).toEqual([['sample', undefined], ['sample', undefined], ['sample', undefined]]); // master: the two that were not alone were in_transaction_busy
    }, 60_000);

    test('a member that is queued behind the preimage read waits its turn and is compared too, and nothing it sends is lost', async () => {
      const { inbox, wrapped } = await fresh();
      await wrapped.transaction(async (tx) => {
        const first = tx.putPage('people/ned-example', page('Ned Example'), { sourceId: 'default', inline: true });
        const second = tx.putPage('people/oli-example', page('Oli Example'), { sourceId: 'default', inline: true }); // held by the gate: not started
        await Promise.all([first, second]);
      });
      expect(await primary().getPage('people/ned-example')).not.toBeNull();
      expect(await primary().getPage('people/oli-example')).not.toBeNull();
      await sampleOf(inbox, 2);
      expect(verdicts(inbox)).toEqual([['sample', undefined], ['sample', undefined]]); // master: the second was in_transaction_busy
    }, 60_000);

    test('writes of a rolled-back nested transaction are forgotten: a stamp it made is neither a later write nor replayed, and the outer sample stays', async () => {
      const { inbox, wrapped } = await fresh();
      await wrapped.transaction(async (tx) => {
        await tx.putPage('people/pia-example', page('Pia Example'));
        await tx.transaction(async (nested) => { await nested.updatePageContextualRetrievalState('people/pia-example', 'default', 'title', null); await nested.addLink('people/pia-example', 'companies/acme-example', 'x', 'invests_in'); throw new Error('roll back'); }).catch(() => undefined);
      });
      const [event] = await sampleOf(inbox);
      expect(event!.outcome).toBeUndefined(); // a full sample: the undone link write and stamp are not judged
      expect(event!.then).toBeUndefined(); // and the stamp is not replayed
    }, 60_000);

    test('a table lock is benign alone, and cannot hide a write that rides behind it in the same batch (a page update after LOCK is a later write)', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const after = async (statement: (tx: BrainEngine) => Promise<unknown>) => {
        const { inbox, wrapped } = rig();
        await wrapped.transaction(async (tx) => { await tx.putPage('people/rex-example', page('Rex Example')); await statement(tx); });
        await sampleOf(inbox);
        return verdicts(inbox)[0];
      };
      expect(await after((tx) => tx.executeRaw('LOCK TABLE content_chunks IN SHARE UPDATE EXCLUSIVE MODE NOWAIT'))).toEqual(['sample', undefined]);
      if (ctx.kind !== 'postgres') return; // PGLite refuses a batch of several statements
      expect(await after((tx) => tx.executeRaw("LOCK TABLE pages IN ROW EXCLUSIVE MODE; UPDATE pages SET contextual_retrieval_mode='title' WHERE slug='people/rex-example'"))).toEqual(['uncomparable', 'in_transaction_later_write']);
      expect(await after((tx) => tx.executeRaw("LOCK TABLE sources IN ROW EXCLUSIVE MODE; UPDATE facts SET fact = fact WHERE id = -1"))).toEqual(['uncomparable', 'in_transaction_later_write']);
      expect(await after((tx) => tx.executeRaw("LOCK TABLE sources IN ROW EXCLUSIVE MODE; UPDATE sources SET name = name WHERE id = 'default'"))).toEqual(['sample', undefined]); // every statement is checked, and this one writes bookkeeping only
    }, 60_000);

    test('a raw write is benign when every table it writes is bookkeeping, and not otherwise: a table outside the set, a statement that mixes one in, and a drifted page statement are uncomparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const after = async (statement: (tx: BrainEngine) => Promise<unknown>) => {
        const { inbox, wrapped } = rig();
        await wrapped.transaction(async (tx) => { await tx.putPage('people/quin-example', page('Quin Example')); await statement(tx); });
        await sampleOf(inbox);
        return verdicts(inbox)[0];
      };
      const bookkeeping = "UPDATE sources SET name = name WHERE id = 'default'";
      expect(await after((tx) => tx.executeRaw(bookkeeping))).toEqual(['sample', undefined]);
      expect(await after((tx) => tx.executeRaw("UPDATE facts SET fact = fact WHERE id = -1"))).toEqual(['uncomparable', 'in_transaction_later_write']);
      expect(await after((tx) => tx.executeRaw(`WITH done AS (${bookkeeping} RETURNING 1) UPDATE facts SET fact = fact WHERE id = -1`))).toEqual(['uncomparable', 'in_transaction_later_write']);
      // The page statement a sync makes after the write: its exact text only.
      const unbound = "UPDATE pages SET database_only_reason=NULL WHERE source_id=$1 AND slug=$2 AND database_only_reason='unbound_source'";
      expect(await after((tx) => tx.executeRaw(unbound, ['default', 'people/quin-example']))).toEqual(['sample', undefined]);
      expect(await after((tx) => tx.executeRaw(unbound.replace('unbound_source', 'origin_twin'), ['default', 'people/quin-example']))).toEqual(['uncomparable', 'in_transaction_later_write']);
      expect(await after((tx) => tx.executeRaw(unbound.replace('NULL', "'x'"), ['default', 'people/quin-example']))).toEqual(['uncomparable', 'in_transaction_later_write']);
      // The same page statement before the page write is an earlier write to the page, and a bookkeeping write before it is not.
      let { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => { await tx.executeRaw(unbound, ['default', 'people/quin-example']); await tx.putPage('people/quin-example', page('Quin Again')); });
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['uncomparable', 'in_transaction_prior_write']]);
      ({ inbox, wrapped } = rig());
      await wrapped.transaction(async (tx) => { await tx.executeRaw(bookkeeping); await tx.putPage('people/quin-example', page('Quin Third')); });
      await sampleOf(inbox);
      expect(verdicts(inbox)).toEqual([['sample', undefined]]);
    }, 60_000);

    test('the swap report names what criterion 5 leaves uncompared, and the warm single-write path is no longer one of them', () => {
      const detail = row5({}).detail ?? '';
      expect(detail).toContain(WRITE_COVERAGE_NAMED);
      expect(WRITE_COVERAGE_NAMED).toContain('chunks, tags, aliases, timeline entries, takes, facts, fact withdrawals, open loops, sources, owner-only marks and the decide store');
      expect(detail).not.toContain('warm single-write path');
    });

    // The warm single-write lane: a reserved connection's own transaction (Postgres only; PGLite's reserved connection has none).
    const lane = async <T>(wrapped: BrainEngine, run: (tx: BrainEngine) => Promise<T>, opts?: Record<string, unknown>): Promise<T> =>
      (wrapped as any).withReservedConnection((conn: any) => conn.transaction(run, opts));

    test('a page write in the warm lane transaction is sampled after the commit, a rolled-back one is dropped, and the warm transaction itself is unchanged', async () => {
      if (ctx.kind !== 'postgres') return;
      const { inbox, wrapped } = await fresh();
      await lane(wrapped, async (tx) => { await tx.putPage('people/una-example', page('Una Example'), { sourceId: 'default', inline: true }); expect(putEvents(inbox)).toEqual([]); });
      expect((await primary().getPage('people/una-example'))?.title).toBe('Una Example');
      expect((await sampleOf(inbox)).length).toBe(1);
      expect(putEvents(inbox)[0]!.outcome).toBeUndefined(); // a full sample: the rows read before the write travel with it
      await expect(lane(wrapped, async (tx) => { await tx.putPage('people/vic-example', page('Vic Example')); throw new Error('roll back'); })).rejects.toThrow('roll back');
      await new Promise((r) => setTimeout(r, 300));
      expect(putEvents(inbox)).toHaveLength(1); // nothing more: the rolled-back write is never compared
      expect(await primary().getPage('people/vic-example')).toBeNull();
    }, 60_000);

    test('a warm-lane write waits for the calls ahead of it before its savepoint: parallel inline writes and a version row all survive the commit, and each write is compared', async () => {
      if (ctx.kind !== 'postgres') return;
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().putPage('people/wes-example', page('Wes Example'));
      const { inbox, wrapped } = rig();
      const snapshot = await primary().readPageSnapshot('people/wes-example');
      await lane(wrapped, async (tx) => {
        await Promise.all([
          tx.putPage('people/xia-example', page('Xia Example'), { sourceId: 'default', inline: true }),
          tx.putPage('people/yan-example', page('Yan Example'), { sourceId: 'default', inline: true }),
          tx.createVersion('people/wes-example', { sourceId: 'default', preimage: snapshot } as never),
          tx.putPage('people/wes-example', page('Wes Renamed'), { sourceId: 'default', inline: true }),
        ]);
      });
      for (const slug of ['people/xia-example', 'people/yan-example']) expect(await primary().getPage(slug)).not.toBeNull();
      expect((await primary().getPage('people/wes-example'))?.title).toBe('Wes Renamed');
      expect(await primary().getVersions('people/wes-example')).toHaveLength(1);
      await sampleOf(inbox, 3);
      expect(verdicts(inbox)).toEqual([['sample', undefined], ['sample', undefined], ['sample', undefined]]);
    }, 60_000);

    test('the warm lane keeps its first statement first: with pipelineFirst the declaration is sent before BEGIN is answered, and every preimage statement follows it', async () => {
      if (ctx.kind !== 'postgres') return;
      const { inbox, wrapped } = await fresh();
      const declaration = "SELECT set_config('gbrain.persistence_protocol','2',true)";
      const seen: string[] = [];
      const original = primary().executeRaw as (...a: unknown[]) => Promise<unknown>;
      const spy = spyOn(primary(), 'executeRaw').mockImplementation(function (this: unknown, sql: unknown, ...rest: unknown[]) { if (typeof sql === 'string') seen.push(sql); return original.call(this, sql, ...rest); } as never);
      try {
        await lane(wrapped, async (tx) => { await tx.executeRaw(declaration); await tx.putPage('people/zed-example', page('Zed Example'), { sourceId: 'default', inline: true }); },
          { pipelineFirst: (statement: string) => statement === declaration });
      } finally { spy.mockRestore(); }
      await sampleOf(inbox);
      const first = seen.findIndex((q) => q === declaration);
      const preimage = seen.map((q, i) => (q.includes('shadow write preimage') ? i : -1)).filter((i) => i >= 0);
      expect(first).toBe(0);
      expect(preimage.length).toBeGreaterThan(0);
      expect(preimage.every((i) => i > first)).toBe(true);
      expect((await primary().getPage('people/zed-example'))?.title).toBe('Zed Example');
    }, 60_000);

    test('the journal members the sampler treats as bookkeeping send only the statements it judged: each typed member, on both dialects, sends exactly its mapped statements and nothing else', async () => {
      const record = async (dialect: 'postgres' | 'pglite', run: (exec: never) => Promise<unknown>) => {
        const sent: string[] = [];
        await run({ dialect, executeRaw: async (sql: string) => { sent.push(sql); return []; }, run: async (fragment: never) => { sent.push(renderFragment(fragment).text); return { rows: [] }; } } as never);
        return sent;
      };
      const [ensure, lockSql] = JOURNAL_MEMBER_STATEMENTS.get('lockPersistenceCounters')!;
      const [complete, probe] = JOURNAL_MEMBER_STATEMENTS.get('completeWriteRow')!;
      const completion = (probePurges: boolean) => ({ id: '00000000-0000-4000-8000-000000000000', state: 'committed', outcome: {}, errorCode: null, errorMessage: null, consumerVersion: 'test', consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: ['brain'], intentBytes: 0, retainedBytes: 0, terminalReservation: 0, probePurges });
      for (const dialect of ['postgres', 'pglite'] as const) {
        expect(await record(dialect, (exec) => lockPersistenceCounters(exec, ['brain', 'x']))).toEqual([ensure!, lockSql!]);
        expect(await record(dialect, (exec) => completeWriteRow(exec, completion(false) as never))).toEqual([complete!]);
        expect(await record(dialect, (exec) => completeWriteRow(exec, completion(true) as never))).toEqual([probe!]);
      }
      const effects = JOURNAL_MEMBER_STATEMENTS.get('insertPublicationEffects')!;
      for (const dialect of ['postgres', 'pglite'] as const) {
        expect(await record(dialect, (exec) => insertPublicationEffects(exec, { requestId: '00000000-0000-4000-8000-000000000000', revision: null, sourceId: 'default', sourceIncarnation: '00000000-0000-4000-8000-000000000001', worktreeId: null, effects: [{ kind: 'links', data: {} }] } as never))).toEqual([effects[0]!]);
      }
      const declarations = JOURNAL_MEMBER_STATEMENTS.get('declarePersistence')!;
      const [lockRequest] = JOURNAL_MEMBER_STATEMENTS.get('lockWriteRequest')!;
      for (const dialect of ['postgres', 'pglite'] as const) {
        const declared = [
          ...await record(dialect, (exec) => declarePersistence(exec)),
          ...await record(dialect, (exec) => declarePersistence(exec, { lockTimeout: '1s', statementTimeout: '5s' })),
          ...await record(dialect, (exec) => declarePersistence(exec, { lockTimeout: '1s', statementTimeout: '5s', idleInTransaction: '1s' })),
        ];
        expect(declared).toEqual([...declarations]);
        expect(await record(dialect, (exec) => lockWriteRequest(exec, '00000000-0000-4000-8000-000000000000'))).toEqual([lockRequest!]);
        // A page publication's own writes after its page write: each sends exactly its mapped statements.
        const only = (name: string) => [...JOURNAL_MEMBER_STATEMENTS.get(name)!];
        expect(await record(dialect, (exec) => removeTimelineRows(exec, 1, []))).toEqual(only('removeTimelineRows'));
        expect(await record(dialect, (exec) => updateTimelineDetails(exec, 1, []))).toEqual(only('updateTimelineDetails'));
        expect(await record(dialect, (exec) => deleteTakeRows(exec, 1, []))).toEqual(only('deleteTakeRows'));
        expect(await record(dialect, (exec) => deleteStalePageWriteGateReceipts(exec, 'default', 'x', null))).toEqual(only('deleteStalePageWriteGateReceipts'));
        expect(await record(dialect, (exec) => writeOpCheckpointRecords(exec, 'op', [{ fingerprint: 'f', record: {} }]))).toEqual(only('writeOpCheckpointRecords'));
        const passRows = [
          ...await record(dialect, (exec) => writeSyncPassRow(exec, 'default', 'i', {}, {})),
          ...await record(dialect, (exec) => writeSyncPassRow(exec, 'default', 'i', {}, { clock: true })),
          ...await record(dialect, (exec) => writeSyncPassRow(exec, 'default', 'i', {}, { onlyOpen: true })),
          ...await record(dialect, (exec) => writeSyncPassRow(exec, 'default', 'i', {}, { onlyOpen: true, clock: true })),
        ];
        expect(passRows).toEqual(only('writeSyncPassRow'));
        expect(await record(dialect, (exec) => advanceSyncCheckpoint(exec, { sourceId: 'default', incarnation: 'i', commit: 'c', from: null, acceptAtCommit: false, slugMode: 'm', keepPinnedSlugMode: false } as never))).toEqual(only('advanceSyncCheckpoint'));
        // The links effect's wanted rows after its addLinksBatch: the delete alone when no target is missing, then the insert when one is.
        const wanted = { producer: 'body', ref_kind: 'slug', target_source_id: 'default', target_ref: 'people/missing-example', link_type: 'mentions', context: 'x' };
        expect(await record(dialect, (exec) => replaceWantedLinkRows(exec, { pageId: 1, sourceId: 'default' }, { rows: [], producers: ['body'] } as never))).toEqual([only('replaceWantedLinkRows')[0]!]);
        expect(await record(dialect, (exec) => replaceWantedLinkRows(exec, { pageId: 1, sourceId: 'default' }, { rows: [wanted], producers: ['body'] } as never))).toEqual(only('replaceWantedLinkRows'));
      }
      for (const [name, sqls] of JOURNAL_MEMBER_STATEMENTS) expect([name, noComparedWrites(sqls)]).toEqual([name, true]);
      // The links effect's transaction: its completion writes persistence_effects only; the others lock rows or set transaction-local settings and write nothing.
      const [completeEffect] = JOURNAL_MEMBER_STATEMENTS.get('completeEffectRow')!;
      const [limits] = JOURNAL_MEMBER_STATEMENTS.get('setEffectTransactionLimits')!;
      const [protocol, durable, durableIdle] = JOURNAL_MEMBER_STATEMENTS.get('declarePersistence')!;
      const [guardBrain, guardWorktree] = JOURNAL_MEMBER_STATEMENTS.get('lockEffectGuard')!;
      const [claimRow] = JOURNAL_MEMBER_STATEMENTS.get('lockEffectClaimRow')!;
      for (const dialect of ['postgres', 'pglite'] as const) {
        expect(await record(dialect, (exec) => completeEffectRow(exec, { id: 1, token: '00000000-0000-4000-8000-000000000000', outcomeJson: '{}' } as never))).toEqual([completeEffect!]);
        expect(await record(dialect, (exec) => setEffectTransactionLimits(exec))).toEqual([limits!]);
        expect(await record(dialect, (exec) => declarePersistence(exec))).toEqual([protocol!]);
        expect(await record(dialect, (exec) => declarePersistence(exec, { lockTimeout: '2s', statementTimeout: '3s' }))).toEqual([durable!]);
        expect(await record(dialect, (exec) => declarePersistence(exec, { lockTimeout: '2s', statementTimeout: '3s', idleInTransaction: '4s' }))).toEqual([durableIdle!]);
        expect(await record(dialect, (exec) => lockEffectGuard(exec, null))).toEqual([guardBrain!]);
        expect(await record(dialect, (exec) => lockEffectGuard(exec, '00000000-0000-4000-8000-000000000000'))).toEqual([guardBrain!, guardWorktree!]);
        expect(await record(dialect, (exec) => lockEffectClaimRow(exec, 1))).toEqual([claimRow!]);
      }
      for (const name of ['setEffectTransactionLimits', 'declarePersistence', 'lockEffectGuard', 'lockEffectClaimRow']) expect(JOURNAL_MEMBER_STATEMENTS.get(name)!.flatMap((sql) => sqlWrites(sql))).toEqual([]); // they write nothing
      expect(sqlWrites(completeEffect!).map((w) => (w as { relation?: string }).relation)).toEqual(['persistence_effects']);
      expect(JOURNAL_MEMBER_STATEMENTS.get('replaceWantedLinkRows')!.flatMap((sql) => sqlWrites(sql)).map((w) => (w as { relation?: string }).relation)).toEqual(['wanted_links', 'wanted_links']); // the effect's wanted rows only
      expect([...JOURNAL_MEMBER_STATEMENTS.keys()].sort()).toEqual(['advanceSyncCheckpoint', 'completeEffectRow', 'completeWriteRow', 'declarePersistence', 'deleteStalePageWriteGateReceipts', 'deleteTakeRows', 'insertPublicationEffects', 'lockEffectClaimRow', 'lockEffectGuard', 'lockPersistenceCounters', 'lockWriteRequest', 'publicationJournalStore', 'removeTimelineRows', 'replaceWantedLinkRows', 'setEffectTransactionLimits', 'updateTimelineDetails', 'writeOpCheckpointRecords', 'writeSyncPassRow']); // upsertWriteGateReceipt is not bookkeeping: it stays an ordinary write
    }, 30_000);

    test('the publication journal store is judged by every statement it can send: each method is driven, each statement is read-only or bookkeeping, and a statement that writes a compared table makes it an ordinary write', () => {
      const sqls = publicationJournalStatements();
      expect(sqls).not.toBeNull();
      expect(JOURNAL_MEMBER_STATEMENTS.get('publicationJournalStore')).toEqual(sqls!);
      const store = sqlPublicationJournalStore({ executeRaw: async () => [] } as never);
      expect(sqls!.length).toBeGreaterThanOrEqual(Object.keys(store).length); // one statement per method at least (recordRecovery and the staging pair have more)
      for (const sql of sqls!) expect(noComparedWrites([sql])).toBe(true);
      expect(sqls!.some((sql) => /UPDATE persistence_requests/.test(sql))).toBe(true); // the counter can find a write
      expect(noComparedWrites([...sqls!, 'UPDATE pages SET title = title'])).toBe(false);
      expect(noComparedWrites([...sqls!, "INSERT INTO links (from_page_id) VALUES (1)"])).toBe(false);
      expect(noComparedWrites([])).toBe(false);
      for (const sql of JOURNAL_MEMBER_STATEMENTS.get('declarePersistence')!) expect(noComparedWrites([sql])).toBe(true);
      expect(noComparedWrites(JOURNAL_MEMBER_STATEMENTS.get('lockWriteRequest')!)).toBe(true);
    });

    test('insertPublicationEffects is bookkeeping only while its statement writes persistence_effects and nothing else: a statement that writes another table is an ordinary write', () => {
      const [effects] = JOURNAL_MEMBER_STATEMENTS.get('insertPublicationEffects')!;
      expect(sqlWrites(effects!).map((w) => `${w.kind}:${(w as { relation?: string }).relation}`)).toEqual(['relation:persistence_effects']);
      expect(bookkeepingStatements([effects!])).toBe(true);
      expect(bookkeepingStatements([`WITH moved AS (INSERT INTO pages (slug) VALUES ('x') RETURNING 1) ${effects!}`])).toBe(false);
      expect(bookkeepingStatements([effects!, 'UPDATE pages SET title = title'])).toBe(false);
    });

    test('the closing seal the sampler treats as a seal is exactly the page update the sealImportedPage member sends: any other text is an ordinary write again', async () => {
      let sent = '';
      await sealImportedPage({ run: async (fragment: never) => { sent = renderFragment(fragment).text; return { rows: [] }; } } as never, 'notes/a',
        { sourceId: 'default', revision: '00000000-0000-4000-8000-000000000000', timelineText: '', chunkerVersion: 1 });
      const norm = (text: string) => text.replace(/\s+/g, ' ').replace(/\$\d+/g, '$').trim();
      expect(norm(sent)).toBe(norm(`UPDATE pages SET chunker_version=$1,
        text_projection_revision=CASE WHEN knowledge_revision=$2::uuid THEN knowledge_revision ELSE text_projection_revision END,
        search_vector=CASE WHEN knowledge_revision=$2::uuid THEN ${pageSearchVectorSql('title', 'v.seal_input')} ELSE search_vector END
        FROM (SELECT $3::text AS seal_input) v
        WHERE pages.source_id=$4 AND pages.slug=$5 RETURNING pages.id`));
    });

    test('calls made while the preimage is read keep their order behind the sampled write (a tag added right after a new page lands on it)', async () => {
      const { inbox, wrapped } = await fresh();
      await wrapped.transaction(async (tx) => { const put = tx.putPage('people/fay-example', page('Fay Example')); const tag = tx.addTag('people/fay-example', 'first'); await Promise.all([put, tag]); });
      expect(await primary().getTags('people/fay-example')).toEqual(['first']);
      expect((await sampleOf(inbox)).length).toBe(1);
    }, 60_000);
  });

  (ctx.addon ? describe : describe.skip)('sync-import page writes and updates in a transaction, replayed on a scratch Rust store', () => {
    const putEvents = (inbox: WriteEvent[]) => inbox.filter((e) => e.op === 'putPage');
    const real = async (events: WriteEvent[]) => {
      const dir = ctx.tempDir(); const on = tallyOn(dir);
      await settle(createWriteComparer({ dir, tally: on.tally, alive: () => true, load: { ok: true, addon: addonOf() } as never, scratchRoot: ctx.tempDir() }), events);
      return on.counts();
    };

    test('a version row for the page before its write is allowed, and the write is comparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => { await tx.createVersion('companies/acme-example'); await tx.putPage('companies/acme-example', page('Acme Renamed')); });
      await until(() => putEvents(inbox).length === 1);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('several pages written in one transaction are sent together after the commit, one sample each, and each is comparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().putPage('people/ivy-example', page('Ivy Example')); await primary().putPage('people/jon-example', page('Jon Example'));
      const { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => {
        await tx.createVersion('people/ivy-example'); await tx.putPage('people/ivy-example', page('Ivy Renamed'));
        await tx.createVersion('people/jon-example'); await tx.putPage('people/jon-example', page('Jon Renamed'));
        expect(putEvents(inbox)).toEqual([]);
      });
      await until(() => putEvents(inbox).length === 2);
      expect(putEvents(inbox).map((e) => (e.args as string[])[0]).sort()).toEqual(['people/ivy-example', 'people/jon-example']);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('a page write in the warm lane transaction is replayed and comparable (a create and an update of the same page, default contextual-retrieval mode)', async () => {
      if (ctx.kind !== 'postgres') return;
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      const run = (title: string) => (wrapped as any).withReservedConnection((conn: any) => conn.transaction(async (tx: BrainEngine) => {
        await tx.putPage('people/abe-example', page(title), { sourceId: 'default', inline: true, contextualRetrieval: { mode: 'title', corpusGeneration: 'generation-example' } });
      }));
      await run('Abe Example'); await run('Abe Renamed');
      await until(() => putEvents(inbox).length === 2);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('a rolled-back nested stamp is not replayed: the sample is comparable', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => {
        await tx.putPage('people/ron-example', page('Ron Example'));
        await tx.transaction(async (nested) => { await nested.updatePageContextualRetrievalState('people/ron-example', 'default', 'title', null); throw new Error('roll back'); }).catch(() => undefined);
      });
      await until(() => putEvents(inbox).length === 1);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('a typed counter lock before the page write and the request completion after it are bookkeeping, as their raw statements are; a typed link delete before it is not', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      const completion = { id: '00000000-0000-4000-8000-000000000000', state: 'committed', outcome: {}, errorCode: null, errorMessage: null, consumerVersion: 'test', consumerHostId: null,
        errorDetail: null, resultBytes: 0, counterKeys: ['brain'], intentBytes: 0, retainedBytes: 0, terminalReservation: 0, probePurges: false } as const;
      await wrapped.transaction(async (tx) => {
        await tx.lockPersistenceCounters(['brain']);
        await tx.putPage('people/kim-example', page('Kim Example'));
        await tx.completeWriteRow(completion as never);
      });
      await until(() => putEvents(inbox).length === 1);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 0 });
      const second = rig();
      await second.wrapped.transaction(async (tx) => {
        await tx.lockPersistenceCounters(['brain']);
        await tx.deleteOwnedLinks(1, 'markdown', [1]);
        await tx.putPage('people/lea-example', page('Lea Example'));
      });
      await until(() => putEvents(second.inbox).length === 1);
      expect(await real(putEvents(second.inbox))).toMatchObject({ comparable: 0, uncomparable: 1, uncomparable_by_reason: { in_transaction_prior_write: 1 } });
    }, 120_000);

    test('a real put_page through the operation layer, with contextual retrieval off, is compared: its create and its edit are both comparable, never a difference', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().setConfig('search.contextual_retrieval', 'none');
      const { inbox, wrapped } = rig();
      const ctxOf = { engine: wrapped, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true } as unknown as OperationContext;
      try {
        await operationsByName.put_page.handler(ctxOf, { slug: 'notes/op-example', content: '---\ntitle: Op Example\n---\nFirst body.\n' });
        const current = await primary().readPageSnapshot('notes/op-example');
        await operationsByName.put_page.handler(ctxOf, { slug: 'notes/op-example', content: '---\ntitle: Op Example\n---\nSecond body.\n', expected_revision: current?.revision } as never);
        await until(() => putEvents(inbox).length >= 2);
      } finally { await disposePersistenceConsumer(wrapped); } // the handler's consumer is keyed by this wrapper: left open, it takes later tests' write requests and effects
      const tally = await real(putEvents(inbox));
      // An update sends its version row (with the page it read) in the same wave as the page write on Postgres: the page write waits for that row before its preimage read.
      expect(tally).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0 }); // master on Postgres: the edit was in_transaction_busy
    }, 120_000);

    test('a real managed sync of a new file and then a changed one: every page write ends in the tally, comparable or with a named reason, never a difference', async () => {
      await ctx.reset();
      await primary().setConfig('search.contextual_retrieval', 'none');
      const home = ctx.tempDir(); const id = `sync-${Date.now()}`; const root = join(home, id); mkdirSync(root);
      const { inbox, wrapped } = rig();
      const opts = { noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true, sourceId: id, repoPath: root };
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined }, async () => {
        try {
          await disposePersistenceConsumer(primary());
          await primary().executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          const git = await makeGitFixture(root); mkdirSync(join(root, 'records'));
          const file = join(root, 'records/example.md');
          const write = (body: string) => writeFileSync(file, `---\ntitle: Example record\n---\n${body}\n`);
          write('A synthetic record about durable processing.'); git.commitAll('first');
          await primary().executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
          await claimWorktree(primary(), id, root);
          await primary().executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          expect(await performSync(wrapped, opts as never)).toMatchObject({ status: 'first_sync' });
          write('A synthetic record about durable processing, changed.'); git.commitAll('second');
          expect(await performSync(wrapped, opts as never)).toMatchObject({ status: 'synced' });
        } finally { await disposePersistenceConsumer(wrapped); await disposePersistenceConsumer(primary()); await primary().executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
      });
      await until(() => putEvents(inbox).length >= 2);
      const tally = await real(putEvents(inbox));
      console.log('managed sync:', JSON.stringify([tally.comparable, tally.unexplained_difference, tally.uncomparable, tally.uncomparable_by_reason]));
      expect(tally.unexplained_difference).toBe(0);
      expect(tally.comparable + tally.uncomparable).toBe(2); // each page write is counted once
      for (const reason of Object.keys(tally.uncomparable_by_reason)) expect(['in_transaction_busy', 'preimage_not_loaded']).toContain(reason);
    }, 180_000);

    test('three arms store the same contextual-retrieval stamp: the primary (PGLite or Postgres) and the Rust engine through its store member', async () => {
      await ctx.reset();
      const stamp = { mode: 'title', corpusGeneration: 'generation-example' };
      const dir = join(ctx.tempDir(), 'store');
      const rust: any = openRustEngine({ addon: addonOf() as unknown as RustEngineAddonHandle, databasePath: dir });
      try {
        await rust.connect({ database_path: dir });
        for (const engine of [primary(), rust]) await engine.putPage('notes/stamp-example', page('Stamp Example'), { sourceId: 'default', contextualRetrieval: stamp });
        const [row] = await primary().executeRaw<{ contextual_retrieval_mode: string; corpus_generation: string }>("SELECT contextual_retrieval_mode, corpus_generation FROM pages WHERE slug = 'notes/stamp-example'");
        const theirs = await rust.getPage('notes/stamp-example');
        expect({ mode: row!.contextual_retrieval_mode, generation: row!.corpus_generation }).toEqual({ mode: 'title', generation: 'generation-example' });
        expect(theirs.contextual_retrieval_mode).toBe(row!.contextual_retrieval_mode);
        // The Rust engine reads the stamp back as the page's mode; no engine member returns its corpus generation, so that column is checked on the primary only.
        // A `none` stamp writes nothing on every arm, as the primary's own putPage leaves both columns alone for it.
        for (const engine of [primary(), rust]) await engine.putPage('notes/stamp-none', page('Stamp None'), { sourceId: 'default', contextualRetrieval: { mode: 'none', corpusGeneration: null } });
        const [none] = await primary().executeRaw<{ contextual_retrieval_mode: string | null }>("SELECT contextual_retrieval_mode FROM pages WHERE slug = 'notes/stamp-none'");
        expect((await rust.getPage('notes/stamp-none')).contextual_retrieval_mode ?? null).toBe(none!.contextual_retrieval_mode ?? null);
      } finally { await rust.disconnect().catch(() => undefined); }
    }, 120_000);

    test('a real sync import in the default contextual-retrieval mode (title) is compared: the stamp it sends is carried to the replay, and both the new and the changed page are comparable', async () => {
      await ctx.reset();
      const root = ctx.tempDir(); const file = join(root, 'default-mode.md');
      const { inbox, wrapped } = rig();
      const sync = async (body: string) => { writeFileSync(file, `---\ntype: note\ntitle: Default Mode\n---\n\n${body}\n`); await importFile(wrapped as never, file, 'notes/default-mode.md', { noEmbed: true }); };
      await sync('First body of the page.'); await sync('A changed body of the page.');
      await until(() => putEvents(inbox).length === 2);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0 });
      const sent = putEvents(inbox).map((e) => (e.args as unknown[])[2] as { contextualRetrieval?: { mode?: string } });
      expect(sent.map((o) => o.contextualRetrieval?.mode)).toEqual(['title', 'title']); // the default brain sends the option, and it is carried
    }, 120_000);

    test('a real sync import of a new page and then a changed one ends up in the tally: comparable when contextual retrieval is off and when it stamps the write', async () => {
      await ctx.reset();
      const root = ctx.tempDir(); const file = join(root, 'sync-example.md');
      const sync = async (body: string) => { writeFileSync(file, `---\ntype: note\ntitle: Sync Example\n---\n\n${body}\n`); await importFile(wrapped as never, file, 'notes/sync-example.md', { noEmbed: true }); };
      await primary().setConfig('search.contextual_retrieval', 'none');
      let { inbox, wrapped } = rig();
      await sync('First body of the page.'); await sync('A changed body of the page.');
      await until(() => putEvents(inbox).length === 2);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 2, unexplained_difference: 0, uncomparable: 0 });
      await primary().setConfig('search.contextual_retrieval', 'title');
      ({ inbox, wrapped } = rig());
      await sync('A third body of the page.');
      await until(() => putEvents(inbox).length === 1);
      expect(await real(putEvents(inbox))).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);
  });

  describe('a page edit and a link write inside a transaction are compared after the commit (put_page edits, the links effect)', () => {
    const ofOp = (inbox: WriteEvent[], op: string) => inbox.filter((e) => e.op === op);
    const verdictsOf = (inbox: WriteEvent[], op: string) => ofOp(inbox, op).map((e) => [e.outcome ?? 'sample', e.reason]);
    const sampleOf = async (inbox: WriteEvent[], op: string, n = 1) => { await until(() => ofOp(inbox, op).length >= n); return ofOp(inbox, op); };
    const opCtx = (wrapped: BrainEngine) => ({ engine: wrapped, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true }) as unknown as OperationContext;
    const note = (v: string) => `---\ntitle: Note\ntype: note\n---\nNote ${v} mentions [[people/alice-example]].\n`;

    test('an edit whose version row is pipelined beside it (how put_page and sync update an existing page) waits for that row, is compared, and the row survives the commit', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      const snapshot = await primary().readPageSnapshot('companies/acme-example');
      await wrapped.transaction(async (tx) => {
        await Promise.all([tx.createVersion('companies/acme-example', { sourceId: 'default', preimage: snapshot } as never), tx.putPage('companies/acme-example', page('Acme Renamed'), { sourceId: 'default', inline: true })]);
      });
      const [event] = await sampleOf(inbox, 'putPage');
      expect([event!.outcome ?? 'sample', event!.reason]).toEqual(['sample', undefined]); // master: uncomparable, in_transaction_busy
      expect(event!.pre!.pages.map((p) => p.title)).toEqual(expect.arrayContaining(['Acme Example'])); // the row before the edit
      expect((await primary().getPage('companies/acme-example'))?.title).toBe('Acme Renamed');
      expect(await primary().getVersions('companies/acme-example')).toHaveLength(1); // the version row was not inside the preimage savepoint
    }, 60_000);

    test('a put_page edit of an existing page is a full sample, as its create is', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      try {
        await operationsByName.put_page.handler(opCtx(wrapped), { slug: 'notes/edit-me', content: note('one') });
        await sampleOf(inbox, 'putPage');
        const revision = ((await primary().getPage('notes/edit-me')) as { knowledge_revision?: string } | null)?.knowledge_revision;
        await operationsByName.put_page.handler(opCtx(wrapped), { slug: 'notes/edit-me', content: note('two'), expected_revision: revision });
        await sampleOf(inbox, 'putPage', 2);
      } finally { await disposePersistenceConsumer(wrapped); } // the handler's consumer is keyed by this wrapper: it must not take the next test's requests
      expect(verdictsOf(inbox, 'putPage')).toEqual([['sample', undefined], ['sample', undefined]]); // master on Postgres: the edit was in_transaction_busy
    }, 60_000);

    test('the links effect\'s addLinksBatch after a put_page (its own transaction, with its lock and journal statements) is a full sample', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      let event: WriteEvent | undefined;
      try {
        await operationsByName.put_page.handler(opCtx(wrapped), { slug: 'notes/mentions', content: note('one') });
        [event] = await sampleOf(inbox, 'addLinksBatch');
      } finally { await disposePersistenceConsumer(wrapped); }
      expect([event!.outcome ?? 'sample', event!.reason]).toEqual(['sample', undefined]); // master: uncomparable, in_transaction
      expect((event!.args![0] as Array<{ to_slug: string }>).map((l) => l.to_slug)).toEqual(['people/alice-example']);
    }, 60_000);

    test('a link write is uncomparable when anything else its transaction writes could change what it reads back: a link or page write before it, a page write after it, an unknown raw write', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const batch = [{ from_slug: 'people/alice-example', to_slug: 'companies/acme-example', link_type: 'mentions', context: 'x' }];
      const cases: Array<[(tx: BrainEngine) => Promise<unknown>, string]> = [
        [async (tx) => { await tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'invests_in'); await tx.addLinksBatch(batch); }, 'in_transaction_prior_write'],
        [async (tx) => { await tx.putPage('people/other-example', page('Other Example')); await tx.addLinksBatch(batch); }, 'in_transaction_prior_write'],
        [async (tx) => { await tx.addLinksBatch(batch); await tx.putPage('companies/acme-example', page('Acme Later')); }, 'in_transaction_later_write'],
        [async (tx) => { await tx.addLinksBatch(batch); await tx.executeRaw("UPDATE links SET context = context WHERE id = -1"); }, 'in_transaction_later_write'],
        [async (tx) => { await tx.addTag('people/alice-example', 'team'); await tx.addLinksBatch(batch); }, 'in_transaction_prior_write'],
      ];
      for (const [body, reason] of cases) {
        const { inbox, wrapped } = rig({ random: () => 0 });
        await wrapped.transaction(body);
        await sampleOf(inbox, 'addLinksBatch');
        expect(verdictsOf(inbox, 'addLinksBatch')).toEqual([['uncomparable', reason]]);
        await ctx.reset(); await fillSeedFixture(primary());
      }
      const { inbox, wrapped } = rig(); // bookkeeping alone around it (the effect journal's statements, a version row) leaves it comparable
      await wrapped.transaction(async (tx) => { await tx.executeRaw("UPDATE persistence_effects SET updated_at = updated_at WHERE id = -1"); await tx.addLinksBatch(batch); await tx.executeRaw("DELETE FROM wanted_links WHERE origin_page_id = -1"); });
      await sampleOf(inbox, 'addLinksBatch');
      expect(verdictsOf(inbox, 'addLinksBatch')).toEqual([['sample', undefined]]);
    }, 120_000);

    test('a callback that throws at once, after starting a sampled link write that waits behind a slow call, rolls it back: nothing is sent after the ROLLBACK', async () => {
      for (const viaLane of ctx.kind === 'postgres' ? [true, false] : [false]) {
        await ctx.reset(); await fillSeedFixture(primary());
        const { inbox, wrapped } = rig();
        let pending: Promise<unknown> | undefined;
        const body = ((tx: BrainEngine) => {
          void tx.executeRaw('SELECT pg_sleep(0.2)').catch(() => undefined);
          pending = tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'thrown_away'); // sampled: waits for the call ahead of it
          throw new Error('abort');
        }) as never;
        const run = viaLane ? (wrapped as any).withReservedConnection((conn: any) => conn.transaction(body)) : wrapped.transaction(body);
        await expect(run).rejects.toThrow('abort');
        await pending?.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 300));
        expect((await primary().getLinks('people/alice-example')).filter((l: { link_type?: string }) => l.link_type === 'thrown_away')).toHaveLength(0); // without the fix (lane): sent after the ROLLBACK, in autocommit
        expect(inbox.filter((e) => e.op === 'addLink')).toEqual([]);
      }
    }, 60_000);

    test('a call held behind a sampled write runs in its own caller\'s context: a write scoped to a page\'s stored legacy spelling updates that page, never a twin', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().putPage('people/legacy-seed', page('Legacy'));
      await primary().executeRaw("UPDATE pages SET slug='People/Legacy' WHERE slug='people/legacy-seed'");
      const { wrapped } = rig();
      await wrapped.transaction(async (tx) => {
        await Promise.all([
          tx.putPage('people/gate-example', page('Gate Example'), { sourceId: 'default', inline: true }), // sampled: holds the gate
          withStoredSlug('People/Legacy', () => tx.putPage('People/Legacy', page('Legacy Updated'), { sourceId: 'default', inline: true })), // held behind it
        ]);
      });
      const rows = await primary().executeRaw<{ slug: string; title: string }>("SELECT slug, title FROM pages WHERE lower(slug) = 'people/legacy' ORDER BY slug");
      expect(rows.map((r) => [r.slug, r.title])).toEqual([['People/Legacy', 'Legacy Updated']]); // a lost context created a lowercase twin and left the stored page as it was
    }, 60_000);

    test('a nested transaction the callback already awaited is no longer running: the next sampled write is compared, not busy', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => {
        await tx.transaction(async (nested) => { await nested.getPage('people/alice-example'); }); // a nested transaction that writes nothing the comparison reads
        await tx.putPage('people/after-nested', page('After Nested'), { sourceId: 'default', inline: true });
      });
      await until(() => inbox.some((e) => e.op === 'putPage'));
      expect(inbox.filter((e) => e.op === 'putPage').map((e) => [e.outcome ?? 'sample', e.reason])).toEqual([['sample', undefined]]); // a finished call left in the running set made it in_transaction_busy
    }, 60_000);

    test('a transaction end waits at most its bound for a call the callback did not await: then it goes ahead as without the shadow, and the unfinished sample is uncomparable (drain_timeout)', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      let release!: () => void; const stuck = new Promise<void>((r) => { release = r; });
      const real = primary().addLink as (...a: unknown[]) => Promise<unknown>;
      const hook = spyOn(primary(), 'addLink').mockImplementation(async function (this: unknown, ...a: unknown[]) { await stuck; return real.apply(this, a); } as never); // a write still on its way past the bound
      const t0 = Date.now(); let pending: Promise<unknown> | undefined;
      try {
        await wrapped.transaction(async (tx) => { pending = tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'too_slow').catch(() => undefined); });
        expect(Date.now() - t0).toBeLessThan(4_000); // the bound (2 s), not the stuck call, decided
      } finally { release(); hook.mockRestore(); await pending; }
      await until(() => inbox.some((e) => e.op === 'addLink'));
      expect(inbox.filter((e) => e.op === 'addLink').map((e) => [e.outcome, e.reason])).toEqual([['uncomparable', 'drain_timeout']]);
    }, 60_000);

    test('with the follower wired as production wires it, a nested transaction beside a followed write does not stall: its end never waits for the enclosing transaction\'s calls', async () => {
      const kit = fenceKit(ctx);
      await ctx.reset(); await fillSeedFixture(primary());
      await primary().putPage('people/nested-gone', page('Nested Gone'));
      const { wrapped } = kit.prod();
      const t0 = Date.now();
      await wrapped.transaction(async (tx) => {
        await Promise.all([
          tx.transaction(async (nested) => { await nested.getPage('people/alice-example'); }),
          tx.deletePage('people/nested-gone'), // its follow pre-read queues behind the nested transaction
        ]);
      });
      expect(Date.now() - t0).toBeLessThan(1_500); // a nested drain that waited for the enclosing transaction's calls stalled the full 2 s bound
      expect(await primary().getPage('people/nested-gone')).toBeNull();
    }, 60_000);

    test('with the follower wired as production wires it, a sampled write the callback did not await is sent before COMMIT and commits', async () => {
      const kit = fenceKit(ctx);
      for (const viaLane of ctx.kind === 'postgres' ? [false, true] : [false]) {
        await ctx.reset(); await fillSeedFixture(primary());
        const { inbox, wrapped } = kit.prod();
        const failures: unknown[] = [];
        let pending: Promise<unknown> | undefined;
        const body = async (tx: BrainEngine) => {
          void tx.executeRaw('SELECT pg_sleep(0.2)').catch((e) => failures.push(e));
          pending = tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'unawaited_followed').catch((e) => { failures.push(e); });
        };
        await (viaLane ? (wrapped as any).withReservedConnection((conn: any) => conn.transaction(body)) : wrapped.transaction(body));
        await pending;
        expect(failures.map((e) => String((e as Error)?.message ?? e))).toEqual([]); // without the fix: CONNECTION_CLOSED, the COMMIT went before the followed write
        expect((await primary().getLinks('people/alice-example')).filter((l: { link_type?: string }) => l.link_type === 'unawaited_followed')).toHaveLength(1);
        await until(() => inbox.some((e) => e.op === 'addLink'));
      }
    }, 60_000);

    test('a write the callback started and did not await, held while a sampled write waits, is sent before COMMIT: it commits as it would without the shadow', async () => {
      for (const viaLane of ctx.kind === 'postgres' ? [false, true] : [false]) {
        await ctx.reset(); await fillSeedFixture(primary());
        const { inbox, wrapped } = rig();
        const failures: unknown[] = [];
        const body = async (tx: BrainEngine) => {
          void tx.executeRaw('SELECT pg_sleep(0.2)').catch((e) => failures.push(e)); // still running when the callback returns
          void tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'unawaited').catch((e) => failures.push(e)); // sampled: waits for the call ahead of it
        };
        await (viaLane ? (wrapped as any).withReservedConnection((conn: any) => conn.transaction(body)) : wrapped.transaction(body));
        await until(() => inbox.some((e) => e.op === 'addLink'));
        expect(failures).toEqual([]); // without the drain: CONNECTION_CLOSED, the write was sent after COMMIT
        expect((await primary().getLinks('people/alice-example')).filter((l: { link_type?: string }) => l.link_type === 'unawaited')).toHaveLength(1);
        expect(inbox.filter((e) => e.op === 'addLink').map((e) => e.outcome ?? 'sample')).toEqual(['sample']);
      }
    }, 60_000);

    test('a write held behind the preimage read is never sent after its transaction ends: when a call ahead of a sampled write fails and the transaction rolls back, nothing of it commits', async () => {
      for (const viaLane of ctx.kind === 'postgres' ? [false, true] : [false]) {
        await ctx.reset(); await fillSeedFixture(primary());
        const { inbox, wrapped } = rig();
        const links = async () => (await primary().getLinks('people/alice-example')).filter((l: { link_type?: string }) => l.link_type === 'rolled_back').length;
        const body = async (tx: BrainEngine) => { await Promise.all([tx.executeRaw('SELECT 1/0'), tx.addLink('people/alice-example', 'companies/acme-example', 'x', 'rolled_back'), tx.putPage('people/rolled-example', page('Rolled Back')), tx.addTag('people/alice-example', 'rolled')]); };
        const run = viaLane ? (wrapped as any).withReservedConnection((conn: any) => conn.transaction(body)) : wrapped.transaction(body);
        await expect(run).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 300)); // a write sent late would land now
        expect(await links()).toBe(0); // without the drain (lane): the link write was sent after ROLLBACK and committed on its own
        expect(await primary().getPage('people/rolled-example')).toBeNull();
        expect(await primary().getTags('people/alice-example')).not.toContain('rolled');
        expect(inbox.filter((e) => e.op === 'putPage' || e.op === 'addLink')).toEqual([]); // a rolled-back transaction sends no sample
      }
    }, 60_000);

    test('a link write in the warm lane (which the follower does not see) is moved by one write of this process between its commit and read-back; with none it is not', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite's reserved connection has no transaction of its own
      const batch = [{ from_slug: 'people/alice-example', to_slug: 'companies/acme-example', link_type: 'mentions', context: 'lane' }];
      for (const other of [false, true]) {
        await ctx.reset(); await fillSeedFixture(primary());
        let gen = 0;
        const { inbox, wrapped } = rig({ generation: () => gen });
        const realGetPage = primary().getPage as (...a: unknown[]) => Promise<unknown>; let once = true;
        const hook = spyOn(primary(), 'getPage').mockImplementation((async function (this: unknown, ...a: unknown[]) { if (once && this === primary() && other) { once = false; gen += 1; } return realGetPage.apply(this, a); }) as never);
        try { await (wrapped as any).withReservedConnection((conn: any) => conn.transaction(async (tx: BrainEngine) => { await tx.addLinksBatch(batch); })); await sampleOf(inbox, 'addLinksBatch'); } finally { hook.mockRestore(); }
        expect(Boolean(ofOp(inbox, 'addLinksBatch')[0]!.moved)).toBe(other); // master: one other write was read as the sample's own, so not moved
      }
    }, 60_000);

    (ctx.kind === 'pglite' ? test : test.skip)('a call that runs a callback (a bounded read) is never waited for: the sampled write is busy at once, and a call the callback makes is not held', async () => {
      // PGLite only: Postgres keywordBoundedRead opens its own scoped transaction, which cannot share the outer transaction's connection with a concurrent call; the rule tested (a running call that took a function is never waited for) is the wrapper's, the same on both engines.
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      const t0 = Date.now();
      await wrapped.transaction(async (tx) => {
        await Promise.all([
          tx.keywordBoundedRead(async () => { await new Promise((r) => setTimeout(r, 20)); await tx.addTag('people/alice-example', 'bounded'); return null; }),
          tx.putPage('people/cb-example', page('Callback Example')),
        ]);
      });
      expect(Date.now() - t0).toBeLessThan(1_500); // master waited out the 2 s bound
      expect(await primary().getTags('people/alice-example')).toContain('bounded');
      await sampleOf(inbox, 'putPage');
      expect(verdictsOf(inbox, 'putPage')).toEqual([['uncomparable', 'in_transaction_busy']]);
    }, 60_000);

    test('many writes queued behind sampled writes are each woken once, in call order, and all commit', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped, sampler } = rig();
      let queued = 0;
      const realScope = sampler.scope.bind(sampler);
      sampler.scope = (e, o) => { const sc = realScope(e, o); const push = sc.waiters.push.bind(sc.waiters); sc.waiters.push = (...w: Array<() => void>) => { queued += w.length; return push(...w); }; return sc; };
      const N = 40;
      await wrapped.transaction(async (tx) => { await Promise.all(Array.from({ length: N }, (_, i) => tx.putPage(`people/q${i}-example`, page(`Q${i} Example`), { sourceId: 'default', inline: true }))); });
      // pregate-literal: SHADOW_ADAPTER_VERSION=13 the number 13 on the next line is test data (a loop step), not the adapter version
      for (let i = 0; i < N; i += 13) expect(await primary().getPage(`people/q${i}-example`)).not.toBeNull();
      await sampleOf(inbox, 'putPage', N);
      expect(queued).toBeLessThanOrEqual(N); // master: every release woke every waiter again (quadratic)
      expect(verdictsOf(inbox, 'putPage').every(([v]) => v === 'sample')).toBe(true);
    }, 120_000);

    test('a sampled write never waits for a nested transaction that is still running, nor past its bound for a slow call: it is uncomparable (in_transaction_busy) and every write commits', async () => {
      await ctx.reset(); await fillSeedFixture(primary());
      let { inbox, wrapped } = rig();
      await wrapped.transaction(async (tx) => {
        await Promise.all([tx.transaction(async (nested) => { await new Promise((r) => setTimeout(r, 50)); await nested.addTag('people/alice-example', 'nested'); }), tx.putPage('people/nia-example', page('Nia Example'))]);
      });
      expect(await primary().getTags('people/alice-example')).toContain('nested');
      expect(await primary().getPage('people/nia-example')).not.toBeNull();
      await sampleOf(inbox, 'putPage');
      expect(verdictsOf(inbox, 'putPage')).toEqual([['uncomparable', 'in_transaction_busy']]);
      ({ inbox, wrapped } = rig({ preimageTimeoutMs: 50 }));
      const real = primary().createVersion as (...a: unknown[]) => Promise<unknown>;
      const slow = spyOn(primary(), 'createVersion').mockImplementation(async function (this: unknown, ...a: unknown[]) { await new Promise((r) => setTimeout(r, 300)); return real.apply(this, a); } as never);
      try {
        const snapshot = await primary().readPageSnapshot('companies/acme-example');
        await wrapped.transaction(async (tx) => { await Promise.all([tx.createVersion('companies/acme-example', { sourceId: 'default', preimage: snapshot } as never), tx.putPage('companies/acme-example', page('Acme Slow'))]); });
      } finally { slow.mockRestore(); }
      expect((await primary().getPage('companies/acme-example'))?.title).toBe('Acme Slow');
      expect(await primary().getVersions('companies/acme-example')).toHaveLength(1);
      await sampleOf(inbox, 'putPage');
      expect(verdictsOf(inbox, 'putPage')).toEqual([['uncomparable', 'in_transaction_busy']]);
    }, 60_000);
  });

  describe('the write counter and the data fence, wired as production wires them', () => {
    const { pg, putEvents, sampled, prod, opCtx, replay, between, fresh } = fenceKit(ctx);

    test('a remove_link through the operation layer is compared: its own second write (the link transition delete) is not another writer', async () => {
      await fresh();
      for (let i = 0; i < 3; i++) await primary().putPage(`people/p${i}`, { type: 'person', title: `P${i}`, compiled_truth: `P${i}.`, timeline: '' });
      const { follower, inbox, wrapped } = prod(); const c = opCtx(wrapped);
      for (let i = 0; i < 3; i++) await operationsByName.add_link.handler(c, { from: 'people/alice-example', to: `people/p${i}`, link_type: 'related_to' });
      for (let i = 0; i < 3; i++) await operationsByName.remove_link.handler(c, { from: 'people/alice-example', to: `people/p${i}`, link_type: 'related_to' });
      await until(() => sampled(inbox, 'removeLink').length >= 3 && sampled(inbox, 'addLink').length >= 3); await follower.settle();
      expect(sampled(inbox, 'removeLink').map((e) => Boolean(e.moved))).toEqual([false, false, false]);
      expect(sampled(inbox, 'addLink').map((e) => Boolean(e.moved))).toEqual([false, false, false]);
      if (ctx.addon) expect(await replay([...sampled(inbox, 'removeLink'), ...sampled(inbox, 'addLink')])).toMatchObject({ comparable: 6, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('a put_page through the operation layer is compared: the process\'s own journal, effect and link batches after the commit are not another writer (a brain with a data fence; where there is none, the counter decides and only the samples are checked)', async () => {
      await fresh();
      const { follower, inbox, wrapped } = prod(); const c = opCtx(wrapped);
      for (let i = 0; i < 4; i++) await operationsByName.put_page.handler(c, { slug: `notes/put-${i}`, content: `---\ntitle: Note ${i}\ntype: note\n---\nNote ${i} mentions [[people/alice-example]] and [Acme](companies/acme-example).\n\n## Timeline\n\n- 2026-01-0${i + 1}: something happened\n` });
      if (!pg) { await follower.settle(); return; } // no data fence on PGLite: the counter decides there (a PGLite brain samples no write in production), and these puts end in comparable or named-uncomparable samples the other scenarios count
      await until(() => sampled(inbox, 'putPage').length >= 4); await follower.settle();
      expect(sampled(inbox, 'putPage').map((e) => Boolean(e.moved))).toEqual([false, false, false, false]);
      if (ctx.addon) expect(await replay(sampled(inbox, 'putPage'))).toMatchObject({ comparable: 4, unexplained_difference: 0 });
    }, 120_000);

    test('a concurrent wrapped addLink that updates the same edge before the first read-back marks the first sample moved: the fence exempts the write\'s own edge, so the counter still decides for a link write', async () => {
      await fresh(); await primary().putPage('people/bob-example', page('Bob Example'));
      const { inbox, wrapped } = prod();
      const hook = between(() => wrapped.addLink('people/alice-example', 'people/bob-example', 'second context', 'works_at'));
      try {
        await wrapped.addLink('people/alice-example', 'people/bob-example', 'first context', 'works_at');
        await until(() => sampled(inbox, 'addLink').length >= 2);
      } finally { hook.restore(); }
      const first = sampled(inbox, 'addLink').find((e) => (e.args as unknown[])[2] === 'first context')!;
      expect(Boolean(first.moved)).toBe(true);
    }, 120_000);

    test('a page imported with tags is compared: the tags it adds later in the same transaction rewrite the revision, and that is not another writer (no counter in this rig, so only the revision check can say moved)', async () => {
      await fresh();
      const { inbox, wrapped } = rig();
      const root = ctx.tempDir();
      for (let i = 0; i < 3; i++) {
        const file = join(root, `tagged-${i}.md`);
        writeFileSync(file, `---\ntype: note\ntitle: Tagged ${i}\ntags: [alpha, beta]\n---\n\nTagged body ${i} links to [Acme](companies/acme-example).\n`);
        await importFile(wrapped as never, file, `notes/tagged-${i}.md`, { noEmbed: true });
      }
      await until(() => putEvents(inbox).length >= 3);
      expect(putEvents(inbox).map((e) => [e.outcome ?? 'sample', e.reason ?? null, Boolean(e.moved)])).toEqual([['sample', null, false], ['sample', null, false], ['sample', null, false]]);
      const [tags] = await primary().executeRaw<{ n: string }>("SELECT count(*)::text AS n FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.slug LIKE 'notes/tagged-%'");
      expect(Number(tags!.n)).toBe(6); // the tags are really there
      if (ctx.addon) expect(await replay(putEvents(inbox))).toMatchObject({ comparable: 3, unexplained_difference: 0, uncomparable: 0 });
    }, 120_000);

    test('the counter is kept wherever the fence did not run and complete for the sample (not decided by the engine name): without the capability it decides; with a fence that cannot finish the sample is moved; with a completed fence it does not decide', async () => {
      await fresh();
      const jump = (): { gen: () => number; bump: () => void } => { let n = 0; return { gen: () => n, bump: () => { n += 2; } }; };
      const run = async (engine: BrainEngine, g: ReturnType<typeof jump>, sabotage?: () => { restore: () => void }) => {
        const inbox: WriteEvent[] = [];
        const sampler = createWriteSampler({ rate: 1, generation: g.gen, send: (line) => { inbox.push(JSON.parse(line)); return true; }, active: () => true });
        const wrapped = wrapShadowEngine(engine, { counters: newMirrorCounters(), offer: () => {}, active: () => true }, { sampleRate: 0, writes: sampler });
        const hook = between(async () => { g.bump(); });
        const fail = sabotage?.();
        try { await wrapped.transaction(async (tx) => { await tx.putPage('companies/acme-example', page(`Acme ${Math.random()}`)); }); await until(() => putEvents(inbox).length >= 1); } finally { hook.restore(); fail?.restore(); }
        return Boolean(putEvents(inbox)[0]!.moved);
      };
      const runStandalone = async (engine: BrainEngine, g: ReturnType<typeof jump>) => {
        const inbox: WriteEvent[] = [];
        const sampler = createWriteSampler({ rate: 1, generation: g.gen, send: (line) => { inbox.push(JSON.parse(line)); return true; }, active: () => true });
        const wrapped = wrapShadowEngine(engine, { counters: newMirrorCounters(), offer: () => {}, active: () => true }, { sampleRate: 0, writes: sampler });
        const hook = between(async () => { g.bump(); });
        try { await wrapped.putPage('companies/acme-example', page(`Acme Alone ${Math.random()}`)); await until(() => putEvents(inbox).length >= 1); } finally { hook.restore(); }
        return Boolean(putEvents(inbox)[0]!.moved);
      };
      // No data-fence capability (what PGLite is, and what any engine without `postgres_admin` is): the counter decides.
      const own = Object.getOwnPropertyDescriptor(primary(), 'capabilities');
      const without = (): void => { Object.defineProperty(primary(), 'capabilities', { configurable: true, value: new Set([...primary().capabilities].filter((c) => c !== 'postgres_admin')) }); };
      const restore = (): void => { if (own) Object.defineProperty(primary(), 'capabilities', own); else delete (primary() as { capabilities?: unknown }).capabilities; };
      if (pg) without();
      try { expect(await run(primary(), jump())).toBe(true); } finally { if (pg) restore(); }
      if (pg) {
        // A completed fence decides: the counter jumped and the rows did not move, so it is not moved.
        expect(await run(primary(), jump())).toBe(false);
        // A completed fence is not enough where nothing pins the target row: a putPage outside a transaction (and every link write) keeps the counter.
        expect(await runStandalone(primary(), jump())).toBe(true);
        // A fence that cannot finish (its read fails) never passes: moved even though the counter never moved.
        const real = primary().transaction.bind(primary()) as (fn: unknown, o?: { readOnly?: boolean }) => Promise<unknown>;
        const sabotage = () => { const spy = spyOn(primary(), 'transaction').mockImplementation(((fn: unknown, o?: { readOnly?: boolean }) => (o?.readOnly ? Promise.reject(new Error('fence read failed')) : real(fn, o))) as never); return { restore: () => spy.mockRestore() }; };
        const quiet = jump(); quiet.bump = () => {};
        expect(await run(primary(), quiet, sabotage)).toBe(true);
      }
    }, 120_000);

    test('a call still running when the callback returns is waited for before the pin, so the pin is taken; a pinned page with tags written after it is not moved', async () => {
      await fresh();
      const { inbox, wrapped } = prod();
      await wrapped.transaction(async (tx) => { await tx.putPage('companies/acme-example', page('Acme No Later Write')); });
      await until(() => putEvents(inbox).length >= 1);
      expect(Boolean(putEvents(inbox)[0]!.moved)).toBe(false);
      await wrapped.transaction(async (tx) => { const written = await tx.putPage('companies/acme-example', page('Acme With Tags')); await tx.addPageTagsById(written.id, ['alpha']); });
      await until(() => putEvents(inbox).length >= 2);
      expect(Boolean(putEvents(inbox)[1]!.moved)).toBe(false); // the tags rewrote the revision: the pin read just before the commit is the one the page commits with
      await wrapped.transaction(async (tx) => {
        const written = await tx.putPage('people/alice-example', page('Alice Busy'));
        await tx.addPageTagsById(written.id, ['alpha']);
        void tx.deleteChunks('people/alice-example'); // still running when the callback returns: the transaction's end waits for it, so the pin is taken after it
      });
      await until(() => putEvents(inbox).length >= 3);
      expect(putEvents(inbox)[2]!.outcome).toBeUndefined(); // a full sample (before the drain: in_transaction_busy on Postgres)
      expect(Boolean(putEvents(inbox)[2]!.moved)).toBe(false);
    }, 120_000);

    // The import pipeline (import-file.ts `applyPrepared`; every sync import runs it too), whose calls Postgres starts at once (`pipelined`): the withdrawal check,
    // the version row (an existing page with a preimage), the edit (with the contextual-retrieval stamp after it in the 'none' mode), the chunk delete (all
    // chunks, all but the kept ones, or none for a segmented page) and the alias writes. The version row is in the pipeline when the caller passes the page's preimage
    // (a managed write: persistence/coordinator.ts); an unmanaged import writes it first, on its own. Every subset the import sends, in its order, plus pairs and a second edit.
    const IMPORT_ORDERS: string[][] = [
      ['createVersion', 'putPage'], ['putPage', 'deleteChunks'], ['withdrawals', 'putPage'], ['putPage', 'aliases'],
      ...['', 'createVersion'].flatMap((v) => ['putPage', 'putPage+stamp'].flatMap((p) => ['', 'deleteChunks', 'deleteChunksExcept'].map((d) => ['withdrawals', v, p, d, 'aliases'].filter(Boolean)))),
      ['putPage', 'deleteChunks', 'putPage:alice'], ['createVersion', 'putPage', 'putPage:alice', 'deleteChunks', 'aliases'],
    ];
    test.each(IMPORT_ORDERS.map((calls) => [calls.join(', '), calls] as const))('pipelined in one transaction with the follower wired (%s): each edit waits only for the calls before it and is compared', async (_name, calls) => {
      await fresh();
      // A sampled write that waits more than 50 ms for the calls ahead of it is uncomparable (in_transaction_busy): one that waited for itself, or for a call queued behind it, would.
      const { inbox, wrapped } = prod({ preimageTimeoutMs: 50 });
      const slug = 'companies/acme-example';
      const snapshot = await primary().readPageSnapshot(slug);
      const edit = (to: string, title: string, stamp: boolean) => async (tx: BrainEngine) => { await tx.putPage(to, page(title), { sourceId: 'default', inline: true }); if (stamp) await tx.updatePageContextualRetrievalState(to, 'default', 'none', null); };
      const thunk = (call: string): ((tx: BrainEngine) => Promise<unknown>) => {
        switch (call) {
          case 'withdrawals': return (tx) => assertPreparedFactWithdrawals(tx, 'default', 'Acme Pipelined.', '', slug);
          case 'createVersion': return (tx) => tx.createVersion(slug, { sourceId: 'default', preimage: snapshot } as never);
          case 'putPage': return edit(slug, 'Acme Pipelined', false);
          case 'putPage+stamp': return edit(slug, 'Acme Pipelined', true);
          case 'putPage:alice': return edit('people/alice-example', 'Alice Pipelined', false);
          case 'deleteChunks': return (tx) => tx.deleteChunks(slug, { sourceId: 'default' });
          case 'deleteChunksExcept': return (tx) => tx.deleteChunksExcept(slug, [], { sourceId: 'default' });
          case 'aliases': return (tx) => writePageAliases(tx, slug, 'default', { ...(page('Acme Pipelined') as object as { title: string; type: string; compiled_truth: string; timeline: string }), frontmatter: {} }, null, null);
          default: throw new Error(`unknown call ${call}`);
        }
      };
      const started = Date.now();
      await wrapped.transaction(async (tx) => { await Promise.all(calls.map((c) => thunk(c)(tx))); });
      const took = Date.now() - started;
      const edits = calls.filter((c) => c.startsWith('putPage')).length;
      await until(() => putEvents(inbox).length >= edits);
      // The first edit has no write ahead of it in the transaction, so it is compared. A second edit after it is compared or, by the existing rule, uncomparable for
      // that earlier write (in_transaction_prior_write); never in_transaction_busy, which is what a wait for itself or for a call behind it gives.
      const events = putEvents(inbox);
      expect(events.length).toBe(edits);
      expect(events.filter((e) => !e.outcome).map((e) => (e.args as unknown[])[0])).toContain(slug);
      expect(events.filter((e) => e.outcome).map((e) => e.reason).filter((r) => r !== 'in_transaction_prior_write')).toEqual([]);
      expect((await primary().getPage(slug))?.title).toBe('Acme Pipelined'); // the edit committed with the calls beside it
      expect(took).toBeLessThan(1_000); // the follower's pre-read waits up to 2 s for calls ahead of it: a pre-read and a call waiting for each other would use all of it
    }, 120_000);

    test('a real import of a changed page with the follower wired (withdrawal check, edit, chunk delete and aliases pipelined on Postgres; the version row goes first, on its own) is compared and does not wait', async () => {
      await fresh();
      const { inbox, wrapped } = prod({ preimageTimeoutMs: 50 });
      const root = ctx.tempDir(); const file = join(root, 'pipelined.md');
      const sync = async (body: string) => { writeFileSync(file, `---\ntype: note\ntitle: Pipelined\n---\n\n${body}\n`); const at = Date.now(); await importFile(wrapped as never, file, 'notes/pipelined.md', { noEmbed: true }); return Date.now() - at; };
      await sync('First body of the page.');
      const took = await sync('A changed body of the page.');
      await until(() => putEvents(inbox).length >= 2);
      expect(putEvents(inbox).map((e) => e.outcome ?? 'compared')).toEqual(['compared', 'compared']);
      expect(took).toBeLessThan(1_500);
    }, 120_000);
  });

  describe('a CLI that sends many samples and exits at once loses none uncounted (received + counted lost == sent)', () => {
    /** Runs the "CLI" (test/helpers/shadow-pipe-exit-parent.ts): `n` samples of `lineBytes` to the real shadow child loop, which starts `readerSleep` seconds late, then exit; returns what the child's tally holds once it ends. */
    async function exitAtOnce(n: number, readerSleep: number, drainMs: number | undefined, lineBytes = 2_000) {
      const home = ctx.tempDir(); const done = join(home, 'child-done');
      const url = ctx.kind === 'postgres' ? (primary() as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl : undefined;
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'shadow-pipe-exit-parent.ts')], {
        env: { ...process.env, GBRAIN_HOME: ctx.tempDir(), KIND: ctx.kind, DIR: home, N: String(n), LINE_BYTES: String(lineBytes), READER_SLEEP: String(readerSleep), DONE: done, ...(url ? { DATABASE_URL: url } : {}), ...(drainMs ? { DRAIN_MS: String(drainMs) } : {}) },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited, err).toBe(0);
      const said = JSON.parse(out.trim().split('\n').at(-1)!) as { sent: number; refused: number };
      await until(() => existsSync(done), (readerSleep + 30) * 1000); // the child outlives its parent: it reads what the pipe holds, then counts what it was never sent
      const t = readWriteTally(home, readEpoch(home)!.epoch_id)!;
      // `cut`: the pipe holds a prefix of the stream, so at most its LAST line can be cut short (seen on macOS, whose pipe takes part of a write); the child reads that line, cannot parse it and settles it
      // `line_unreadable` (src/shadow/child.ts), so it is neither received whole nor lost in the pipe, and it is still counted.
      return { ...said, received: t.uncomparable_by_reason.no_sample ?? 0, lost: t.uncomparable_by_reason.pipe_unflushed ?? 0, cut: t.uncomparable_by_reason.line_unreadable ?? 0, reasons: t.uncomparable_by_reason, total: t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing, files: readdirSync(home) };
    }

    test('a reader that catches up while the CLI waits: every sample is received and counted, none is lost', async () => {
      const r = await exitAtOnce(300, 1, 10_000);
      expect(r.refused).toBe(0);
      expect({ received: r.received, lost: r.lost, total: r.total }).toEqual({ received: r.sent, lost: 0, total: r.sent }); // master: about a quarter arrive and nothing counts the rest
      expect(r.files.filter((f) => f.startsWith('write-owed.') || f.startsWith('write-sent.'))).toEqual([]); // the child settled every owed sample and removed the owed record (was: the sent count, write-sent.*)
    }, 120_000);

    for (const lineBytes of [200, 2_000, 20_000]) {
      test(`a reader slower than the drain bound (${lineBytes}-byte samples): what the pipe never delivered is counted lost (pipe_unflushed), exactly`, async () => {
        const r = await exitAtOnce(Math.ceil(600_000 / lineBytes), 4, 400, lineBytes); // about 600 KB, more than the pipe holds
        expect(r.refused).toBe(0);
        expect(r.lost).toBeGreaterThan(0);
        expect(r.received).toBeLessThan(r.sent);
        expect(r.cut, JSON.stringify(r.reasons)).toBeLessThanOrEqual(1); // only the last line in the pipe can be cut short
        expect(r.received + r.cut + r.lost, JSON.stringify(r.reasons)).toBe(r.sent); // every sample is received whole, read cut short, or counted lost in the pipe: exactly
        expect(r.total, JSON.stringify(r.reasons)).toBe(r.sent);
      }, 120_000);
    }
  });
  describe('a bulk import\'s worker engines are shadowed like the primary (sync and import at their default concurrency)', () => {
    /** A Postgres sync of more than 100 files, or an import with --workers, opens its own worker engines (sync/imports.ts, commands/import.ts); a PGLite brain imports on the primary, serially. */
    const FILES = 104;
    const note = (i: number) => `---\ntitle: W${i}\ntype: note\n---\nW${i} is note ${i}.\n`;
    /** Page writes that reached the sampler, and those of them that are full samples (read back, with no outcome of their own). */
    const counts = (inbox: WriteEvent[]) => { const puts = inbox.filter((e) => e.op === 'putPage'); return { sampled: puts.length, full: puts.filter((e) => !e.outcome).length }; };
    async function bulk(run: (wrapped: BrainEngine, root: string, sourceId: string, git: ReturnType<typeof makeGitFixture> extends Promise<infer G> ? G : never, inbox: WriteEvent[]) => Promise<unknown>, pages = FILES) {
      await ctx.reset(); await primary().setConfig('search.contextual_retrieval', 'none');
      const home = ctx.tempDir(); const sourceId = `bulk${Date.now() % 100000}`; const root = join(home, sourceId); mkdirSync(root);
      const { inbox, wrapped } = rig();
      const url = ctx.kind === 'postgres' ? (primary() as unknown as { connectedDatabaseUrl?: string }).connectedDatabaseUrl : undefined;
      if (ctx.kind === 'postgres' && !url) throw new Error('the Postgres primary does not say which database it opened');
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_DATABASE_URL: url }, async () => {
        const git = await makeGitFixture(root); mkdirSync(join(root, 'notes'));
        for (let i = 0; i < FILES; i++) writeFileSync(join(root, `notes/w${i}.md`), note(i));
        git.commitAll('first');
        await primary().executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        try { await run(wrapped, root, sourceId, git, inbox); } finally { await disposePersistenceConsumer(wrapped); await disposePersistenceConsumer(primary()); }
      });
      const [{ n }] = await primary().executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM pages WHERE source_id=$1', [sourceId]);
      expect(Number(n)).toBe(pages); // the import itself is unchanged
      await until(() => counts(inbox).full >= FILES, 60_000).catch(() => undefined);
      return counts(inbox);
    }

    test('a full sync at its default concurrency samples every page write, also the ones its worker engines make, and reads each back', async () => {
      const got = await bulk((wrapped, root, sourceId) => performSync(wrapped, { full: true, noPull: true, noEmbed: true, noSchemaPack: true, sourceId, repoPath: root } as never));
      expect(got).toEqual({ sampled: FILES, full: FILES }); // master: 0 on Postgres (four unwrapped workers wrote every page), FILES on PGLite (serial)
    }, 300_000);

    test('an incremental sync of more than 100 new files (the sync worker loop, not the import one) samples and reads back every page its workers write', async () => {
      const got = await bulk(async (wrapped, root, sourceId, git, inbox) => {
        const opts = { noPull: true, noEmbed: true, noSchemaPack: true, sourceId, repoPath: root };
        await performSync(wrapped, { ...opts, concurrency: 1 } as never); // the first sync, serial on the primary
        for (let i = FILES; i < 2 * FILES; i++) writeFileSync(join(root, `notes/w${i}.md`), note(i));
        git.commitAll('second');
        inbox.length = 0;
        await performSync(wrapped, opts as never); // 104 new files: past the incremental threshold, so workers import them
      }, 2 * FILES);
      expect(got).toEqual({ sampled: FILES, full: FILES }); // master: 0 on Postgres
    }, 300_000);

    test('gbrain import with --workers samples every page write its worker engines make, and reads each back', async () => {
      const got = await bulk((wrapped, root, sourceId) => runImport(wrapped, [root, '--workers', '4', '--no-embed'], { sourceId } as never));
      expect(got).toEqual({ sampled: FILES, full: FILES }); // master: 0 on Postgres, FILES on PGLite (a PGLite import never opens workers)
    }, 300_000);

    test('a worker\'s disconnect waits for its own sampled read-back, and another worker\'s disconnect leaves it running', async () => {
      if (ctx.kind !== 'postgres') return; // PGLite opens no worker engines
      await ctx.reset(); await fillSeedFixture(primary());
      const { inbox, wrapped } = rig();
      const url = (primary() as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const open = async () => { const e = new PostgresEngine(); await e.connect({ database_url: url, poolSize: 2 } as never); return e; };
      const a = await open(); const b = await open();
      const wa = wrapShadowSibling(wrapped, a); const wb = wrapShadowSibling(wrapped, b);
      let release!: () => void; const held = new Promise<void>((r) => { release = r; });
      const real = a.getPage.bind(a);
      const hook = spyOn(a, 'getPage').mockImplementation((async (...args: Parameters<typeof a.getPage>) => { await held; return real(...args); }) as never); // the read-back's page read waits
      try {
        await wa.putPage('people/barrier-example', page('Barrier Example'));
        await wb.disconnect(); // another worker goes: it must not abandon this one's read-back
        await new Promise((r) => setTimeout(r, 100));
        expect(inbox.filter((e) => e.op === 'putPage')).toEqual([]); // still reading back
        const gone = wa.disconnect();
        setTimeout(release, 300); // finishes within the 2 s the disconnect waits
        await gone;
      } finally { hook.mockRestore(); release(); }
      const [event] = inbox.filter((e) => e.op === 'putPage');
      expect(event?.outcome).toBeUndefined(); // a full sample, sent before the worker's pool closed (not readback_abandoned or readback_failed)
    }, 60_000);
  });
}

/** The fence's negatives, Postgres only (the data fence exists only there; PGLite samples no write in production and has no fence to test): called from test/e2e/shadow-write-compare.test.ts, so the PGLite receipt lane never lists a skipped test. */
export function defineFenceNegatives(ctx: WriteCompareContext): void {
  const primary = ctx.primary;
  const { sampled, prod, opCtx, otherProcessWrite, between, fresh } = fenceKit(ctx);
  const putEvents = (inbox: WriteEvent[]) => inbox.filter((e) => e.op === 'putPage');

  describe('what still marks a sample moved (the data fence alone, on Postgres)', () => {
    const slugOf = (e: WriteEvent) => (e.args as unknown[] | undefined)?.[0];
    const ofPage = (inbox: WriteEvent[], slug: string) => putEvents(inbox).filter((e) => slugOf(e) === slug);
    /** The positive control of every negative below, in the same wiring: a real put_page with nothing writing beside it is not moved (it is, on master: its own bookkeeping batches move the counter). */
    async function cleanPutPage(wrapped: BrainEngine, inbox: WriteEvent[]): Promise<void> {
      await operationsByName.put_page.handler(opCtx(wrapped), { slug: 'notes/control', content: '---\ntitle: Control\ntype: note\n---\nControl mentions [[people/alice-example]].\n' });
      await until(() => ofPage(inbox, 'notes/control').length >= 1);
      expect(Boolean(ofPage(inbox, 'notes/control')[0]!.moved)).toBe(false);
      // The page's links effect adds its mention link after the commit, and that link write is sampled and read back too: wait for its sample, so its
      // read-back (a getPage on the primary) is over before a test arms `between` for the next write's read-back, and cannot take that hook.
      await until(() => inbox.some((e) => e.op === 'addLinksBatch'));
      await disposePersistenceConsumer(wrapped); // its remaining effects (the embedding lease rows) must not run during the next scenario's read-back window
    }
    /** Alice and Bob exist and are linked. A link write between them copies both pages and the links between the two; a put of Alice copies only Alice. */
    const linked = async () => { await fresh(); await primary().putPage('people/bob-example', page('Bob Example')); await primary().addLink('people/alice-example', 'people/bob-example', 'knows', 'knows'); };
    const linkAlice = (wrapped: BrainEngine) => wrapped.addLink('people/alice-example', 'people/bob-example', 'works_at', 'works_at');
    const putAlice = (wrapped: BrainEngine, more?: (tx: BrainEngine, written: { id: number }) => Promise<unknown>) => wrapped.transaction(async (tx) => { const written = await tx.putPage('people/alice-example', page('Alice Renamed')); await more?.(tx, written as { id: number }); });
    const linkSamples = (inbox: WriteEvent[]) => sampled(inbox, 'addLink').filter((e) => (e.args as unknown[] | undefined)?.[3] === 'works_at');

    test('(i) a write by another call in this process to a copied row (the other page of a link write) marks the sample moved', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      await cleanPutPage(wrapped, inbox);
      const hook = between(() => wrapped.putPage('people/bob-example', page('Bob Edited By Another Call')));
      try { await linkAlice(wrapped); await until(() => linkSamples(inbox).length >= 1); } finally { hook.restore(); }
      expect(Boolean(linkSamples(inbox)[0]!.moved)).toBe(true);
    }, 120_000);

    test('(ii) a different transaction changing the page between its commit and the read-back fails the revision check, with and without tags written after the page', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      await cleanPutPage(wrapped, inbox);
      for (const tagged of [false, true]) {
        const seen = ofPage(inbox, 'people/alice-example').length;
        const hook = between(() => primary().transaction(async (tx) => { await tx.executeRaw("UPDATE pages SET title = title || ' (edited elsewhere)', knowledge_revision = gen_random_uuid() WHERE slug = 'people/alice-example'"); }));
        try { await putAlice(wrapped, tagged ? (tx, written) => tx.addPageTagsById(written.id, ['alpha']) : undefined); await until(() => ofPage(inbox, 'people/alice-example').length > seen); } finally { hook.restore(); }
        expect(Boolean(ofPage(inbox, 'people/alice-example')[seen]!.moved)).toBe(true);
      }
    }, 120_000);

    test('(iii) a concurrent write to a target page\'s links outside the footprint (another link between the two pages) marks it moved', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      await cleanPutPage(wrapped, inbox);
      const hook = between(() => primary().addLink('people/alice-example', 'people/bob-example', 'mentions', 'mentions'));
      try { await linkAlice(wrapped); await until(() => linkSamples(inbox).length >= 1); } finally { hook.restore(); }
      expect(Boolean(linkSamples(inbox)[0]!.moved)).toBe(true);
    }, 120_000);

    test('(iv) a write from another process to a copied row during the window marks the sample moved: the fence catches it, the counter cannot', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      await cleanPutPage(wrapped, inbox);
      const hook = between(() => otherProcessWrite("UPDATE pages SET title = 'Bob Edited By Another Process' WHERE slug = $1", ['people/bob-example']));
      try { await linkAlice(wrapped); await until(() => linkSamples(inbox).length >= 1); } finally { hook.restore(); }
      expect(Boolean(linkSamples(inbox)[0]!.moved)).toBe(true);
      const [title] = await primary().executeRaw<{ title: string }>("SELECT title FROM pages WHERE slug = 'people/bob-example'");
      expect(title!.title).toBe('Bob Edited By Another Process'); // the other process really wrote it
      const quiet = prod();
      await quiet.wrapped.addLink('people/alice-example', 'people/bob-example', 'founded', 'founded');
      await until(() => sampled(quiet.inbox, 'addLink').length >= 1);
      expect(Boolean(sampled(quiet.inbox, 'addLink')[0]!.moved)).toBe(false); // the same wiring with no writer beside it is clean
    }, 120_000);

    test('a contextual-retrieval stamp written to the target page after the commit and before the read-back marks the sample moved: it changes a compared column but not the revision', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      await cleanPutPage(wrapped, inbox);
      const hook = between(() => primary().updatePageContextualRetrievalState('people/alice-example', 'default', 'title', 'generation-after-commit'));
      try { await putAlice(wrapped); await until(() => ofPage(inbox, 'people/alice-example').length >= 1); } finally { hook.restore(); }
      expect(Boolean(ofPage(inbox, 'people/alice-example')[0]!.moved)).toBe(true);
    }, 120_000);

    test('the pin read never waits behind another writer queued on the page row: the save commits within the bound and its sample is sent, moved or not', async () => {
      await linked();
      const { inbox, wrapped } = prod();
      let other: Promise<unknown> | undefined; const started = Date.now();
      await putAlice(wrapped, async () => {
        other = primary().executeRaw("UPDATE pages SET title = title || ' (queued)' WHERE slug = 'people/alice-example'"); // waits for the transaction's own row lock until it commits
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(Date.now() - started).toBeLessThan(2_000); // the pin (statement timeout 2 s) did not queue behind it, nor did the commit
      await other;
      await until(() => ofPage(inbox, 'people/alice-example').length >= 1);
      expect(['sample', 'uncomparable']).toContain(ofPage(inbox, 'people/alice-example')[0]!.outcome ?? 'sample');
    }, 60_000);

    test('the page row stays locked by the transaction\'s own putPage until it commits: another transaction\'s update of it waits, so the revision read just before the commit is the transaction\'s own', async () => {
      await fresh();
      let waited = false; let other: Promise<unknown> | undefined;
      await primary().transaction(async (tx) => {
        await tx.putPage('people/alice-example', page('Alice Locked'));
        other = primary().executeRaw("UPDATE pages SET title = title || ' x' WHERE slug = 'people/alice-example'").then(() => { waited = true; });
        await new Promise((r) => setTimeout(r, 400));
        expect(waited).toBe(false);
      });
      await other; expect(waited).toBe(true);
    }, 60_000);
  });
}
