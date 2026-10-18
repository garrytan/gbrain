/**
 * B5 appended-corrections gate (evals/pinned-questions/appended-gate.ts),
 * offline: the workload's gold sequence encodes the conflicting correction,
 * the remember-then-forget revert and the visibility change correctly; the
 * restricted-grant leakage probe finds nothing on an owner-private brain and
 * does find the private note once the operator exposes private pages (so a
 * zero is not vacuous); ratio weighting keeps lifecycle cost fixed. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { aggregate, applyEventsForTest, appendedHash, decide, generateAppendedWorkload, leakageProbe, runAppended, summarize } from '../evals/pinned-questions/appended-gate.ts';
import { retrieveEvidence } from '../src/core/questions/refresh.ts';
import { insertPin } from '../src/core/questions/store.ts';
import { questionSlug } from '../src/core/questions/identity.ts';
import { offlineArms } from '../evals/pinned-questions/benefit-gate.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';

describe('appended-corrections benefit gate (offline plumbing)', () => {
  test('gold follows the newest standing value: conflict resolves to the correction, forget reverts, visibility keeps the value', () => {
    const w = generateAppendedWorkload(42, 3);
    expect(appendedHash(w)).toBe(appendedHash(generateAppendedWorkload(42, 3)));
    for (const e of w.entities) {
      const g = w.gold[e.slug]!;
      const ev = w.batches.map(b => b.filter(x => x.entity === e.slug));
      expect(g).toHaveLength(12);
      expect(g[4]).toBe(ev[4]!.find(x => x.kind === 'conflict_b')!.city!);
      expect(ev[4]!.find(x => x.kind === 'conflict_a')!.city).not.toBe(g[4]);
      expect(g[6]).toBe(ev[6]!.find(x => x.kind === 'remember')!.city!);
      expect(g[7]).toBe(g[5]);
      expect(g[6]).not.toBe(g[5]);
      expect(g[10]).toBe(g[9]);
      expect(ev.flat().length).toBeGreaterThanOrEqual(13);
    }
  });

  test('an offline run reports every arm, no leaks, and fixed lifecycle cost across read ratios', async () => {
    const w = generateAppendedWorkload(7, 2);
    const out = await runAppended({ workload: w, readerModel: MODEL, refreshModel: MODEL, withBaselines: true, arms: offlineArms(MODEL, MODEL) });
    expect(out.arms.map(a => a.arm)).toEqual(['pinned', 'query_reader', 'query_reader_full', 'anchored_reader', 'anchored_reader_full', 'think']);
    for (const a of out.arms) expect(a.reads).toHaveLength(24);
    expect(out.leakage.probes).toBe(2 * 2 * 4);
    expect(out.leakage.leaks).toEqual([]);
    const pinned = out.arms[0]!;
    expect(pinned.refresh_attempts).toBeGreaterThan(2);
    const queryPerRead = out.arms[1]!.reads.reduce((s, r) => s + r.usd, 0) / 24;
    const at1 = summarize(pinned, w, 1, queryPerRead);
    const at100 = summarize(pinned, w, 100, queryPerRead);
    expect(at1.lifecycle_usd).toBe(at100.lifecycle_usd);
    expect(at100.read_usd).toBeCloseTo(at1.read_usd * 100, 9);
    expect(at1.freshness.changes).toBeGreaterThan(0);
  }, 180_000);

  test('the preregistered rule: pinned must beat the anchored control in every seed on accuracy or freshness, with zero leaks', () => {
    const w = generateAppendedWorkload(1, 1);
    const reads = (correct: (b: number) => boolean) => Array.from({ length: 12 }, (_, b) => ({ entity: w.entities[0]!.slug, batch: b, gold: w.gold[w.entities[0]!.slug]![b]!, correct: correct(b), stale: false, usd: 0.001 }));
    const run = (arm: string, correct: (b: number) => boolean, refresh_model?: string) => ({ arm, ...(refresh_model ? { refresh_model } : {}), reads: reads(correct), lifecycle_usd: 0, refresh_attempts: 0 });
    const seed = (seedNo: number, pinnedOk: (b: number) => boolean, controlOk: (b: number) => boolean, leaks = 0) => ({
      seed: seedNo, leaks, summary: [summarize(run('pinned', pinnedOk, MODEL), w, 1, null), summarize(run('anchored_reader', controlOk), w, 1, null)] });
    const all = () => true;
    const missFirst = (b: number) => b !== 1 && b !== 4;
    expect(decide([seed(1, all, missFirst), seed(2, all, missFirst)], MODEL).outcome).toBe('pinned_beats_control');
    expect(decide([seed(1, all, missFirst), seed(2, all, all)], MODEL).outcome).toBe('tie_anchored_retrieval_wins');
    expect(decide([seed(1, all, missFirst, 1), seed(2, all, missFirst)], MODEL).outcome).toBe('opt_in_leak');
    const agg = aggregate([[summarize(run('pinned', all, MODEL), w, 1, null)], [summarize(run('pinned', missFirst, MODEL), w, 1, null)]]);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ arm: 'pinned', seeds: 2, accuracy: { min: 10 / 12, max: 1 } });
  });

  describe('on a PGLite brain', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    });
    afterAll(async () => { await engine.disconnect(); });
    beforeEach(async () => { await resetPgliteState(engine); });

    test('the leakage probe catches a private note once private pages are exposed to remote readers', async () => {
      try {
        const w = generateAppendedWorkload(3, 1);
        const ctx = { engine, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/example-1-update-9', content: '---\ntype: note\ntitle: secret\nvisibility: private\n---\nAs of 2026-05-10, example-1 builds widgets in Ghent.\n' } });
        expect((await leakageProbe(engine, w, [])).leaks).toEqual([]);
        await engine.setConfig('search.remote_private_pages', 'visible');
        __resetPrivateVisibilityCacheForTests();
        expect((await leakageProbe(engine, w, [])).leaks.length).toBeGreaterThan(0);
      } finally {
        await engine.setConfig('search.remote_private_pages', 'hidden');
        __resetPrivateVisibilityCacheForTests();
      }
    }, 120_000);

    test('refresh retrieval keeps each entity\'s newest note in evidence once notes accumulate', async () => {
      try {
        const w = generateAppendedWorkload(42, 6);
        const remembered = new Map<string, string>();
        for (const batch of w.batches) await applyEventsForTest(engine, batch, remembered);
        for (const e of w.entities) {
          const question = `Which city does ${e.name} build widgets in now?`;
          const scope = { source: 'default', entity: e.slug };
          const { row } = await insertPin(engine, { sourceId: 'default', slug: questionSlug(question, scope), question, scope, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 'cli' });
          const pages = (await retrieveEvidence(engine, row)).filter(i => i.kind === 'page').map(i => i.page_slug);
          expect(pages.slice(0, 2)).toEqual([e.slug, `notes/${e.name}-update-11`]);
        }
      } finally {
        __resetPrivateVisibilityCacheForTests();
      }
    }, 120_000);
  });
});
