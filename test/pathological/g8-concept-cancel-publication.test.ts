/**
 * synthesize_concepts starts no publication once the loop has observed a cancel (job signal or phase
 * deadline), and a managed run never flushes its queued concepts after one (synthesize-concepts.ts: the deadline/signal
 * checkpoints before a group, after the concept lookup and before the publish or queue call, and
 * `if (maintenance && !cancelled) await writer.flush()`). A publication already in flight when the cancel lands
 * runs to its own end. Evidence is commit order, not timestamps: every top-level writing transaction of the engine is
 * logged with a sequence number, its `pg_current_xact_id()` and its outcome, plus the concept pages and
 * concept-provenance links it wrote (rows whose xmin is its xid or one of its savepoints'); the cancel is logged when it
 * is issued and when the loop first reads it, and the phase's return when logging stops. Asserted per case:
 *   (i)   no publication transaction begins after the cancel was observed;
 *   (ii)  every publication transaction ended before the phase returned, every logged transaction ends in COMMIT or
 *         ROLLBACK and `pg_xact_status(xid)` agrees (the managed brain's persistence consumer runs its own bookkeeping
 *         transactions beside the phase, and one begun before the return may end after it);
 *   (iii) the concept pages and provenance links in the database are exactly those committed xids wrote, and a concept
 *         page never stands without its links (or the reverse);
 *   (iv)  committed + rolled_back + queued_discarded + skipped = groups found, groups_skipped = skipped, and the phase's
 *         queued_discarded is the queued_discarded counted here.
 * Windows: the cancel lands at the concept lookup (U/M cases), during the pre-publication provenance-coverage read
 * (W1), or after the last group, during its maybeYield (W2, managed: the final flush must not run).
 * The contract cases (P1, P2) pin what the separate publication steps leave when one fails or is refused.
 * PGLite always, Postgres when the lane provides DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PhaseResult } from '../../src/core/cycle.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { acquirePageLock } from '../../src/core/page-lock.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

/** Two member atoms per concept: tier T3, a deterministic narrative, so no model call sits between the checkpoints. */
const MEMBERS = 2;
const stem = (g: number) => `cancel-${String(g).padStart(3, '0')}`;
const conceptOf = (g: number) => `concepts/${stem(g)}`;
const atomsFor = (groups: number) => Array.from({ length: groups }, (_, g) => Array.from({ length: MEMBERS }, (_, a) => ({
  slug: `atoms/${stem(g)}-${a}`, concept_refs: [conceptOf(g)], body: `Atom ${a} about ${stem(g)}.`, title: `${stem(g)} atom ${a}`,
  visibility: 'world' as const }))).flat();
const BUDGET_MS = 600_000;

interface LoggedTx { begin: number; end?: number; outcome?: 'committed' | 'rolled_back'; xid: string | null; pages: string[]; links: string[] }
interface Ledger { seq: number; txs: LoggedTx[]; issued: number | null; observed: number | null; returned: number | null; lookups: string[] }
const newLedger = (): Ledger => ({ seq: 0, txs: [], issued: null, observed: null, returned: null, lookups: [] });
const tick = (ledger: Ledger) => ++ledger.seq;

/**
 * Concept pages and concept-provenance links whose current row version this transaction wrote: a visible row whose xmin is
 * still in progress is its own, written at top level or in one of its savepoints (Postgres publishes a managed page in a
 * subtransaction, so its xmin is not the top-level xid). The xmin is widened to xid8 in the current epoch.
 */
const OWN_ROW = (xmin: string) => `pg_xact_status(((pg_current_xact_id()::text::bigint / 4294967296) * 4294967296 + ${xmin}::text::bigint)::text::xid8) = 'in progress'`;
const WRITTEN_HERE = `
  SELECT 'page' AS kind, slug FROM pages WHERE slug LIKE 'concepts/%' AND ${OWN_ROW('xmin')}
  UNION ALL
  SELECT 'link', CASE WHEN f.slug LIKE 'concepts/%' THEN f.slug ELSE t.slug END FROM links l
    JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
   WHERE l.link_source = 'concept-provenance' AND ${OWN_ROW('l.xmin')}`;

/**
 * Logs every top-level read-write transaction of `engine` (nested ones are savepoints of a logged one). `beforeCommit`
 * runs inside the transaction after its work, before COMMIT: the pause point of an in-flight publication. The returned
 * stop is called right after the phase returns and logs that moment.
 */
function logTransactions(engine: BrainEngine, ledger: Ledger, beforeCommit?: (tx: LoggedTx) => Promise<void>): () => void {
  const target = engine as unknown as Record<string, unknown>;
  const methods = engine.kind === 'postgres' ? ['transaction', 'transactionDirect'] : ['transaction'];
  for (const name of methods) {
    const original = target[name] as (fn: (tx: BrainEngine) => Promise<unknown>, opts?: { readOnly?: boolean }) => Promise<unknown>;
    target[name] = async function (this: { _pageTransaction?: boolean }, fn: (tx: BrainEngine) => Promise<unknown>, opts?: { readOnly?: boolean }) {
      if (this._pageTransaction || opts?.readOnly) return original.call(this, fn, opts);
      const tx: LoggedTx = { begin: 0, xid: null, pages: [], links: [] };
      try {
        const out = await original.call(this, async (handle: BrainEngine) => {
          tx.begin = tick(ledger);
          ledger.txs.push(tx);
          tx.xid = (await handle.executeRaw<{ x: string }>('SELECT pg_current_xact_id()::text AS x'))[0]!.x;
          const result = await fn(handle);
          for (const row of await handle.executeRaw<{ kind: string; slug: string }>(WRITTEN_HERE)) (row.kind === 'page' ? tx.pages : tx.links).push(row.slug);
          await beforeCommit?.(tx);
          return result;
        }, opts);
        tx.outcome = 'committed';
        return out;
      } catch (error) {
        tx.outcome = 'rolled_back';
        throw error;
      } finally {
        tx.end = tick(ledger);
      }
    };
  }
  return () => { ledger.returned ??= tick(ledger); for (const name of methods) delete target[name]; };
}

/** Waits (bounded) until every logged transaction has ended. */
async function logSettled(ledger: Ledger): Promise<void> {
  const until = performance.now() + 10_000;
  while (ledger.txs.some(tx => tx.end === undefined) && performance.now() < until) await Bun.sleep(10);
}

/** A signal whose first `aborted === true` read is logged: the moment the loop observes the cancel. */
function observedSignal(ledger: Ledger): AbortController {
  const controller = new AbortController();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  Object.defineProperty(controller.signal, 'aborted', { get() {
    const value = aborted.call(this) as boolean;
    if (value && ledger.observed === null) ledger.observed = tick(ledger);
    return value;
  } });
  return controller;
}

/**
 * Runs `act` once, right after the loop's pre-publication lookup of `slug` returns, and logs the loop's concept lookups
 * (calls on the engine itself; a transaction's engine inherits the hook and keeps its own `this`).
 */
function onLookup(engine: BrainEngine, ledger: Ledger, slug: string, act: () => void): () => void {
  const original = engine.getPage;
  let fired = false;
  engine.getPage = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['getPage']>) {
    const page = await original.apply(this, args);
    if (this !== engine) return page;
    if (args[0] === slug && !fired) { fired = true; act(); return page; } // that group is skipped at the post-lookup recheck
    if (args[0].startsWith('concepts/') && ledger.issued === null) ledger.lookups.push(args[0]);
    return page;
  }) as BrainEngine['getPage'];
  return () => { delete (engine as unknown as Record<string, unknown>).getPage; };
}

/**
 * Runs `act` once, right after the `nth` provenance-coverage read of `slug` (conceptProvenanceCovers) returns: read 1 is the
 * loop's pre-publication read, read 2 the one after its edges are banked (concept-writes.ts bankProvenance).
 */
function onCoverageRead(engine: BrainEngine, slug: string, act: () => void | Promise<void>, nth = 1): () => void {
  const original = engine.executeRaw;
  let reads = 0;
  engine.executeRaw = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>) {
    const rows = await original.apply(this, args);
    if (this === engine && String(args[0]).includes('AS linked FROM links') && args[1]?.[1] === slug && ++reads === nth) await act();
    return rows;
  }) as BrainEngine['executeRaw'];
  return () => { delete (engine as unknown as Record<string, unknown>).executeRaw; };
}

/** The phase deadline driven by a clock offset (Date.now is restored afterwards). */
async function withClock<T>(run: (jump: (ms: number) => void) => Promise<T>): Promise<T> {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try { return await run(ms => { offset += ms; }); } finally { Date.now = real; }
}

interface Expected { committed: number; queuedDiscarded: number; skipped: number; inFlight?: string }

async function expectCancelContract(engine: BrainEngine, ledger: Ledger, result: PhaseResult, groups: number, expected: Expected): Promise<void> {
  const details = result.details as Record<string, unknown>;
  expect(ledger.issued).not.toBeNull(); // the cancel fired (positive control)
  expect(ledger.returned).not.toBeNull();
  await logSettled(ledger);
  const cancelSeq = ledger.observed ?? ledger.issued!; // a deadline is observed no earlier than it is issued
  const publications = ledger.txs.filter(tx => tx.outcome === 'rolled_back' || tx.pages.length > 0 || tx.links.length > 0);
  // (i)
  expect(publications.filter(tx => tx.begin > cancelSeq).map(tx => ({ begin: tx.begin, pages: tx.pages, links: tx.links }))).toEqual([]);
  // (ii)
  expect(publications.filter(tx => tx.end! > ledger.returned!).map(tx => ({ begin: tx.begin, end: tx.end, pages: tx.pages, links: tx.links }))).toEqual([]);
  expect(ledger.txs.filter(tx => !tx.outcome || tx.end === undefined)).toEqual([]);
  for (const tx of ledger.txs.filter(t => t.xid !== null)) {
    const [status] = await engine.executeRaw<{ s: string }>('SELECT pg_xact_status($1::text::xid8) AS s', [tx.xid]);
    expect({ xid: tx.xid, status: status?.s }).toEqual({ xid: tx.xid, status: tx.outcome === 'committed' ? 'committed' : 'aborted' });
  }
  // (iii)
  const committed = publications.filter(tx => tx.outcome === 'committed');
  const committedPages = [...new Set(committed.flatMap(tx => tx.pages))].sort();
  const committedLinks = [...new Set(committed.flatMap(tx => tx.links))].sort();
  const pages = (await engine.executeRaw<{ slug: string }>(
    "SELECT slug FROM pages WHERE slug LIKE 'concepts/%' AND deleted_at IS NULL ORDER BY slug")).map(r => r.slug);
  const linked = await engine.executeRaw<{ slug: string; n: number }>(
    `SELECT c.slug, count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
       JOIN pages c ON c.id = CASE WHEN f.slug LIKE 'concepts/%' THEN f.id ELSE t.id END
      WHERE l.link_source = 'concept-provenance' GROUP BY c.slug ORDER BY c.slug`);
  expect(pages).toEqual(committedPages);
  expect(linked.map(r => r.slug)).toEqual(committedLinks);
  expect(linked).toEqual(pages.map(slug => ({ slug, n: 2 * MEMBERS }))); // no page without its links, no links without a page
  const expectedPages = Array.from({ length: expected.committed }, (_, g) => conceptOf(g));
  expect(pages).toEqual(expectedPages);
  if (expected.inFlight) expect(pages).toContain(expected.inFlight);
  // (iv)
  const rolledBack = publications.filter(tx => tx.outcome === 'rolled_back').length;
  const reached = [...new Set(ledger.lookups)].length;
  const counts = { committed: pages.length, rolled_back: rolledBack, queued_discarded: reached - pages.length - rolledBack, skipped: details.groups_skipped };
  expect(counts).toEqual({ committed: expected.committed, rolled_back: 0, queued_discarded: expected.queuedDiscarded, skipped: expected.skipped });
  expect(counts.committed + counts.rolled_back + counts.queued_discarded + (counts.skipped as number)).toBe(details.groups_found as number);
  expect(details.queued_discarded).toBe(counts.queued_discarded);
  expect(details.groups_found).toBe(groups);
  expect(details.partial).toBe(true);
}

/** An unmanaged brain (the live path) whose atom pages exist, so provenance edges land. */
async function unmanaged(databaseUrl: string | undefined, groups: number, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g8-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        for (const atom of atomsFor(groups)) {
          await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
        }
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A managed brain (persistence active, maintenance authority claimed) whose atom pages exist before activation. */
async function managed(databaseUrl: string | undefined, groups: number, run: (engine: BrainEngine, root: string) => Promise<void>): Promise<void> {
  await managedBrain(({ engine, root }) => run(engine, root), { databaseUrl, setup: async ({ engine, root }) => {
    writeFileSync(join(root, '.gitignore'), '\n');
    durableGitRepo(root, ['.gitignore']);
    for (const atom of atomsFor(groups)) {
      await engine.putPage(atom.slug, { type: 'note', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: {} });
    }
  } });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`concept publication after a cancel, unmanaged (${backend})`, () => {
    const GROUPS = 6, K = 2;

    test('U1: a signal after K publications: K committed, no publication begins after it, the rest skipped', async () => {
      await unmanaged(databaseUrl, GROUPS, async engine => {
        const ledger = newLedger();
        const controller = observedSignal(ledger);
        const unlog = logTransactions(engine, ledger);
        const unhook = onLookup(engine, ledger, conceptOf(K), () => { ledger.issued = tick(ledger); controller.abort(); });
        let result: PhaseResult;
        try {
          result = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(GROUPS), signal: controller.signal, phaseBudgetMs: BUDGET_MS });
        } finally { unhook(); unlog(); }
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result!, GROUPS, { committed: K, queuedDiscarded: 0, skipped: GROUPS - K });
      });
    }, 240_000);

    test('U2: the deadline after K publications: same contract as the signal', async () => {
      await unmanaged(databaseUrl, GROUPS, async engine => {
        const ledger = newLedger();
        const unlog = logTransactions(engine, ledger);
        const result = await withClock(async jump => {
          const unhook = onLookup(engine, ledger, conceptOf(K), () => { ledger.issued = tick(ledger); jump(BUDGET_MS + 1); });
          try { return await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(GROUPS), phaseBudgetMs: BUDGET_MS }); } finally { unhook(); }
        }).finally(unlog);
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: K, queuedDiscarded: 0, skipped: GROUPS - K });
      });
    }, 240_000);

    test('U3: a signal while publication K+1 is paused before COMMIT: it commits whole (page and links), nothing begins after', async () => {
      await unmanaged(databaseUrl, GROUPS, async engine => {
        const ledger = newLedger();
        const controller = observedSignal(ledger);
        let paused: LoggedTx | null = null;
        const unlog = logTransactions(engine, ledger, async tx => {
          if (paused || !tx.pages.includes(conceptOf(K))) return;
          paused = tx;
          ledger.issued = tick(ledger);
          controller.abort();
          await Bun.sleep(20);
        });
        const unhook = onLookup(engine, ledger, '', () => {});
        let result: PhaseResult;
        try {
          result = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(GROUPS), signal: controller.signal, phaseBudgetMs: BUDGET_MS });
        } finally { unhook(); unlog(); }
        expect(paused).not.toBeNull();
        expect(paused!.outcome).toBe('committed');
        // The in-flight publication's own later steps (its links, its world promotion) ran after the cancel was issued.
        expect(ledger.txs.some(tx => tx.begin > ledger.issued! && tx.links.includes(conceptOf(K)))).toBe(true);
        await expectCancelContract(engine, ledger, result!, GROUPS, { committed: K + 1, queuedDiscarded: 0, skipped: GROUPS - K - 1, inFlight: conceptOf(K) });
      });
    }, 240_000);

    /** Fires the cancel during group K's pre-publication coverage read; that group is skipped at the recheck after it. */
    const cancelAtCoverage = (engine: BrainEngine, ledger: Ledger, fire: () => void) => {
      const unlook = onLookup(engine, ledger, '', () => {});
      const uncover = onCoverageRead(engine, conceptOf(K), () => {
        ledger.lookups = ledger.lookups.filter(slug => slug !== conceptOf(K));
        ledger.issued = tick(ledger);
        fire();
      });
      return () => { uncover(); unlook(); };
    };

    test('W1s: a signal during the pre-publication coverage read of K: K committed, that group never publishes', async () => {
      await unmanaged(databaseUrl, GROUPS, async engine => {
        const ledger = newLedger();
        const controller = observedSignal(ledger);
        const unlog = logTransactions(engine, ledger);
        const unhook = cancelAtCoverage(engine, ledger, () => controller.abort());
        let result: PhaseResult;
        try {
          result = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(GROUPS), signal: controller.signal, phaseBudgetMs: BUDGET_MS });
        } finally { unhook(); unlog(); }
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result!, GROUPS, { committed: K, queuedDiscarded: 0, skipped: GROUPS - K });
      });
    }, 240_000);

    test('W1d: the deadline during the pre-publication coverage read of K: same contract as the signal', async () => {
      await unmanaged(databaseUrl, GROUPS, async engine => {
        const ledger = newLedger();
        const unlog = logTransactions(engine, ledger);
        const result = await withClock(async jump => {
          const unhook = cancelAtCoverage(engine, ledger, () => jump(BUDGET_MS + 1));
          try { return await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(GROUPS), phaseBudgetMs: BUDGET_MS }); } finally { unhook(); }
        }).finally(unlog);
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: K, queuedDiscarded: 0, skipped: GROUPS - K });
      });
    }, 240_000);
  });

  describe(`concept publication after a cancel, managed (${backend})`, () => {
    /** concept-writes.ts MANAGED_CONCEPT_BATCH: a full queue publishes as one batch. */
    const CAPACITY = 50;

    /** Runs the phase on a managed brain with the cancel fired from `arm`; returns the ledger and the result. */
    const runManaged = async (engine: BrainEngine, root: string, groups: number, arm: (ledger: Ledger, controller: AbortController) => () => void) => {
      const ledger = newLedger();
      const controller = observedSignal(ledger);
      const disarm = arm(ledger, controller);
      try {
        return { ledger, result: await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: atomsFor(groups), signal: controller.signal, phaseBudgetMs: BUDGET_MS }) };
      } finally { disarm(); }
    };
    const signalAtLookup = (engine: BrainEngine, group: number) => (ledger: Ledger, controller: AbortController) => {
      const unlog = logTransactions(engine, ledger);
      const unhook = onLookup(engine, ledger, conceptOf(group), () => { ledger.issued = tick(ledger); controller.abort(); });
      return () => { unhook(); unlog(); };
    };

    test('M1: a signal at K < 50 queued: nothing published, no flush after it, the K queued discarded', async () => {
      const GROUPS = 6, K = 2;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        const { ledger, result } = await runManaged(engine, root, GROUPS, signalAtLookup(engine, K));
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: 0, queuedDiscarded: K, skipped: GROUPS - K });
      });
    }, 240_000);

    test('M2: the deadline at K < 50 queued: same as M1 (the final flush is guarded)', async () => {
      const GROUPS = 6, K = 2;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        const ledger = newLedger();
        const unlog = logTransactions(engine, ledger);
        const result = await withClock(async jump => {
          const unhook = onLookup(engine, ledger, conceptOf(K), () => { ledger.issued = tick(ledger); jump(BUDGET_MS + 1); });
          try {
            return await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: atomsFor(GROUPS), phaseBudgetMs: BUDGET_MS });
          } finally { unhook(); }
        }).finally(unlog);
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: 0, queuedDiscarded: K, skipped: GROUPS - K });
      });
    }, 240_000);

    test('M3: a signal at K = 50 + j after a committed capacity flush: 50 committed, j discarded', async () => {
      const J = 2, GROUPS = CAPACITY + J + 2;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        const { ledger, result } = await runManaged(engine, root, GROUPS, signalAtLookup(engine, CAPACITY + J));
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: CAPACITY, queuedDiscarded: J, skipped: GROUPS - CAPACITY - J });
      });
    }, 240_000);

    test('M4: a signal while the capacity flush is paused in a transaction: all 50 commit, nothing begins after the loop sees it', async () => {
      const GROUPS = CAPACITY + 2;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        let paused: LoggedTx | null = null;
        const { ledger, result } = await runManaged(engine, root, GROUPS, (ledger, controller) => {
          const unlog = logTransactions(engine, ledger, async tx => {
            if (paused || !tx.pages.length) return; // the flush's first page-writing transaction
            paused = tx;
            ledger.issued = tick(ledger);
            controller.abort();
            await Bun.sleep(20);
          });
          const unhook = onLookup(engine, ledger, '', () => {});
          return () => { unhook(); unlog(); };
        });
        expect(paused).not.toBeNull();
        expect(paused!.outcome).toBe('committed');
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: CAPACITY, queuedDiscarded: 0, skipped: GROUPS - CAPACITY });
      });
    }, 240_000);

    /**
     * Runs the phase with the cancel fired from the last group's maybeYield: the last lookup advances the clock past the
     * 30 s yield throttle, so `yieldDuringPhase` runs once, after every group is queued and before the final flush.
     */
    const cancelAfterLastGroup = async (engine: BrainEngine, root: string, groups: number, fire: (controller: AbortController, jump: (ms: number) => void) => void) => {
      const ledger = newLedger();
      const controller = observedSignal(ledger);
      let yields = 0;
      const unlog = logTransactions(engine, ledger);
      const result = await withClock(async jump => {
        const unhook = onLookup(engine, ledger, conceptOf(groups - 1), () => { ledger.lookups.push(conceptOf(groups - 1)); jump(31_000); });
        try {
          return await runPhaseSynthesizeConcepts(engine, { sourceId: 'default', brainDir: root, _atoms: atomsFor(groups), signal: controller.signal, phaseBudgetMs: BUDGET_MS,
            yieldDuringPhase: async () => { yields++; ledger.issued = tick(ledger); fire(controller, jump); } });
        } finally { unhook(); }
      }).finally(unlog);
      expect(yields).toBe(1);
      return { ledger, result };
    };

    test('W2s: a signal during the last group\'s maybeYield: no final flush, every queued concept discarded', async () => {
      const GROUPS = 6;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        const { ledger, result } = await cancelAfterLastGroup(engine, root, GROUPS, controller => controller.abort());
        expect(ledger.observed).not.toBeNull();
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: 0, queuedDiscarded: GROUPS, skipped: 0 });
      });
    }, 240_000);

    test('W2d: the deadline during the last group\'s maybeYield: same as the signal', async () => {
      const GROUPS = 6;
      await managed(databaseUrl, GROUPS, async (engine, root) => {
        const { ledger, result } = await cancelAfterLastGroup(engine, root, GROUPS, (_controller, jump) => jump(BUDGET_MS + 1));
        await expectCancelContract(engine, ledger, result, GROUPS, { committed: 0, queuedDiscarded: GROUPS, skipped: 0 });
      });
    }, 240_000);
  });

  describe(`concept publication steps when one fails or is refused, unmanaged (${backend})`, () => {
    /**
     * The unmanaged publication is three steps with their own transactions (concept-writes.ts publish): the page at
     * private, its provenance edges, then the world promotion. A failed or refused step leaves the earlier ones committed.
     */
    const concept = conceptOf(0);
    /** Concept-provenance edges in both directions (concept -> atom synthesized_from, atom -> concept synthesizes). */
    const provenanceEdges = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
        WHERE l.link_source = 'concept-provenance' AND $1 IN (f.slug, t.slug)`, [concept]))[0]!.n;
    const run = (engine: BrainEngine) => runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(1), phaseBudgetMs: BUDGET_MS });

    test('P1: the provenance write fails: the private page stays, without edges, counted written, and the next run skips it', async () => {
      await unmanaged(databaseUrl, 1, async engine => {
        const ledger = newLedger();
        const original = engine.addLinksBatch;
        let failed = 0;
        engine.addLinksBatch = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['addLinksBatch']>) {
          if (args[1]?.auditSite === 'cycle.synthesize_concepts.provenance') { failed++; throw new Error('injected provenance failure'); }
          return original.apply(this, args);
        }) as BrainEngine['addLinksBatch'];
        const unlog = logTransactions(engine, ledger);
        let result: PhaseResult;
        try { result = await run(engine); } finally { unlog(); delete (engine as unknown as Record<string, unknown>).addLinksBatch; }
        expect(failed).toBe(1);
        const details = result!.details as Record<string, unknown>;
        expect(result!.status).toBe('warn');
        expect(details.concepts_written).toBe(1);
        expect(details.link_warnings).toEqual([{ concept: stem(0), warning: 'provenance links failed: injected provenance failure' }]);
        expect(details.publication_deferred).toEqual([]);
        // The page's transaction committed before the provenance transaction began and rolled back.
        const pageTx = ledger.txs.find(tx => tx.pages.includes(concept));
        const rolledBack = ledger.txs.filter(tx => tx.outcome === 'rolled_back');
        expect(pageTx?.outcome).toBe('committed');
        expect(rolledBack.length).toBe(1);
        expect(rolledBack[0]!.begin).toBeGreaterThan(pageTx!.end!);
        const page = await engine.getPage(concept, { sourceId: 'default' });
        expect(page?.frontmatter?.visibility).toBe('private');
        expect(page?.frontmatter?.synthesis_mode).toBe('deterministic_tier');
        expect(await provenanceEdges(engine)).toBe(0);
        // Members unchanged: the page is skipped as unchanged, so its edges are not retried and it is not promoted.
        const again = (await run(engine)).details as Record<string, unknown>;
        expect(again.skipped_unchanged).toEqual([concept]);
        expect(again.concepts_written).toBe(0);
        expect(await provenanceEdges(engine)).toBe(0);
        expect((await engine.getPage(concept, { sourceId: 'default' }))?.frontmatter?.visibility).toBe('private');
      });
    }, 240_000);

    test('P2: the world promotion is refused after the edges land: page private with its edges, deferred, and the next run skips it', async () => {
      await unmanaged(databaseUrl, 1, async engine => {
        const held: { lock: Awaited<ReturnType<typeof acquirePageLock>> } = { lock: null };
        // A concurrent writer takes the page lock once the edges are banked, before the promotion's publication.
        const unhook = onCoverageRead(engine, concept, async () => { held.lock = await acquirePageLock(concept); }, 2);
        let result: PhaseResult;
        try { result = await run(engine); } finally { unhook(); await held.lock?.release(); }
        expect(held.lock).not.toBeNull();
        const details = result!.details as Record<string, unknown>;
        expect(result!.status).toBe('warn');
        expect(details.concepts_written).toBe(0);
        expect(details.publication_deferred).toEqual([{ concept: stem(0), reason: 'revision_conflict: The concept page is locked by another writer.' }]);
        expect(details.link_warnings).toEqual([]);
        const page = await engine.getPage(concept, { sourceId: 'default' });
        expect(page?.frontmatter?.visibility).toBe('private');
        expect(await provenanceEdges(engine)).toBe(2 * MEMBERS);
        // Members unchanged: the deferred promotion is not retried; the page stays private.
        const again = (await run(engine)).details as Record<string, unknown>;
        expect(again.skipped_unchanged).toEqual([concept]);
        expect((await engine.getPage(concept, { sourceId: 'default' }))?.frontmatter?.visibility).toBe('private');
      });
    }, 240_000);
  });
}
