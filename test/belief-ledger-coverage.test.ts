/**
 * Belief ledger coverage probes (docs/designs/BELIEF_LEDGER.md section 11:
 * 13, 15, 16, 17, 33) and the coverage tooling they rest on: intervals,
 * certified status, drift and reconcile, commit marks, coverageAt. Each probe
 * asserts exact event types, keys and values on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe: a deliberately broken
 * emitter (or marker) that must make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { __setBeliefEmitterFaultForTests, markBeliefCommits, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { currentStateHash, readLedgerSource, withBeliefBatch } from '../src/core/belief/ledger.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { enableBeliefLedger, disableBeliefLedger, latestCoverage } from '../src/core/belief/coverage.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { runBeliefs } from '../src/commands/beliefs.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  DRIFT_SAMPLE_PAGES, UNMARKED_WINDOW_DAYS, beliefEventVisibility, coverageAt, coverageIntervals, fillCommitMarks, orphanLifetimes, reconcileBeliefDrift, scanBeliefDrift, unmarkedPublications,
} from '../src/core/belief/coverage-report.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import type { InventoryEntry } from '../src/core/persistence/engine-graduation.types.ts';
import { GRADUATION_INVENTORY } from '../src/core/persistence/graduation-inventory.ts';
import { copySequences } from '../src/core/persistence/graduation-copy.ts';
import { assertLegacyEngineMigration } from '../src/core/persistence/maintenance.ts';
import { copiedEntries, copyAll, digestMismatches } from './helpers/graduation-copy-harness.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { backfillBeliefHistory } from '../src/core/belief/backfill.ts';
import { endLifetime, mintLifetime } from '../src/core/belief/lifetimes.ts';
import { beliefLedgerEntry } from '../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { replayPurgesInRestore, type PurgeMirrorLine } from '../src/core/belief/purge-mirror.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); });

const page = (o: Parameters<typeof beliefPage>[0] = {}) => beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'],
  takes: ['Acme will win its market', 'Acme will hire fast'], links: ['people/alice-example'], ...o });
const fault = (f: (drafts: BeliefEventDraft[]) => BeliefEventDraft[]) => __setBeliefEmitterFaultForTests(f);
/** The database clock rounded up to the next millisecond, so a JS timestamp is never below a microsecond time read before it. */
const dbNow = async (b: BeliefBrain) => new Date(new Date((await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`))[0]!.t).getTime()).toISOString();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

async function doctor(b: BeliefBrain, opts: Partial<DoctorContext> = {}): Promise<Check> {
  const [check] = await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId, ...opts } as DoctorContext) as Check[];
  expect(check!.name).toBe('belief_ledger_coverage');
  return check!;
}

async function bypassLink(b: BeliefBrain, target: string) {
  await b.engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context, origin_page_id)
    SELECT a.id, p.id, 'mentions', 'markdown', 'bypass', a.id FROM pages a, pages p
    WHERE a.source_id = $1 AND a.slug = 'companies/acme-example' AND p.source_id = $1 AND p.slug = $2`, [b.sourceId, target]);
}

/** The engine with `before` run (on the real engine, outside any transaction) ahead of its `nth` top-level transaction. */
function interceptTransactions(engine: BrainEngine, nth: number, before: () => Promise<void>, opts: { after?: boolean } = {}): BrainEngine {
  let calls = 0;
  return new Proxy(engine, { get(target, prop, receiver) {
    if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => {
      calls++;
      if (calls === nth && !opts.after) await before();
      const result = await target.transaction(fn as never);
      if (calls === nth && opts.after) await before();
      return result;
    };
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}
const lifetimeCount = async (b: BeliefBrain) => Number((await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_page_lifetimes WHERE source_id = $1', [b.sourceId]))[0]!.n);

async function seeded(b: BeliefBrain) {
  await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
  await b.put('companies/acme-example', page());
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger coverage (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean; setup?: (b: BeliefBrain) => Promise<void> } = {}) =>
      beliefBrain(run, { managed: opts.managed ?? true, enable: opts.enable, setup: opts.setup, databaseUrl: engineCase.databaseUrl });

    test('journaled publications leave no drift; the interval is certified on a managed source', async () => {
      await brain(async b => {
        await seeded(b);
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }] }));
        const scan = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(scan.drifted).toEqual([]);
        expect(scan.exact).toBe(true);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval).toMatchObject({ certified: true, links_certified: 'journaled_only', stopped_at: null, baseline: { complete: true }, drift: [] });
        expect(interval!.watermark).not.toBeNull();
      });
    }, 120_000);

    test('probe 15: unmanaged source, a resolution then its undo between two scans: the hash matches, the interval stays uncertified', async () => {
      const run = async (b: BeliefBrain) => {
        await seeded(b);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        await pause();
        const between = await dbNow(b);
        await b.engine.executeRaw(`UPDATE takes SET resolved_at = now(), resolved_outcome = true, resolved_by = 'grader'
          WHERE claim = 'Acme will win its market' AND page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/acme-example')`, [b.sourceId]);
        const mid = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(mid.drifted.map(d => d.slug)).toEqual(['companies/acme-example']);
        await b.engine.executeRaw(`UPDATE takes SET resolved_at = NULL, resolved_outcome = NULL, resolved_by = NULL
          WHERE claim = 'Acme will win its market' AND page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/acme-example')`, [b.sourceId]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        return { interval: interval!, at: await coverageAt(b.engine, b.sourceId, between, 'companies/acme-example') };
      };
      await brain(async b => {
        const { interval, at } = await run(b);
        expect(interval).toMatchObject({ certified: false, links_certified: false, baseline: { complete: true } });
        expect(at).toMatchObject({ ok: true, certified: false, uncertified_reason: 'unmanaged' });
      }, { managed: false });
      // Forced probe: an emitter that stamps the unmanaged activation certified is caught.
      await brain(async b => {
        const { interval, at } = await run(b);
        expect(interval.certified).toBe(true);
        expect(at).toMatchObject({ ok: true, certified: true });
      }, { managed: false, enable: false, setup: async b => {
        fault(drafts => drafts.map(d => d.eventType === 'coverage.complete' ? { ...d, cause: { ...d.cause, certified: true } } : d));
        await b.enable();
        __setBeliefEmitterFaultForTests(null);
      } });
    }, 180_000);

    test('drift on a managed source: reconcile restates the moved keys and the slug interval stays uncertified after a clean hash', async () => {
      await brain(async b => {
        await seeded(b);
        await b.put('people/bob-example', beliefPage({ type: 'person', title: 'Bob Example' }));
        const before = await b.lastId();
        const prior = (await b.events()).filter(e => e.slug === 'companies/acme-example').at(-1)!;
        await b.engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context, origin_page_id)
          SELECT a.id, p.id, 'mentions', 'markdown', 'bypass', a.id FROM pages a, pages p
          WHERE a.source_id = $1 AND a.slug = 'companies/acme-example' AND p.source_id = $1 AND p.slug = 'people/bob-example'`, [b.sourceId]);
        const scan = await scanBeliefDrift(b.engine, b.sourceId, { deep: true });
        expect(scan.drifted.map(d => d.slug)).toEqual(['companies/acme-example']);
        expect(scan.drifted[0]!.recorded_hash).toBe(prior.state_hash);
        const fixed = await reconcileBeliefDrift(b.engine, b.sourceId);
        expect(fixed.reconciled).toEqual(['companies/acme-example']);
        const events = await b.events(before);
        const current = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, prior.source_incarnation, 'companies/acme-example'));
        // The creation snapshot proves no key, so every current key is restated, then the page carries the full set.
        expect(shape(events).sort()).toEqual(['fact:reconcile', 'fact:reconcile', 'link:reconcile', 'link:reconcile', 'page:reconcile', 'take:reconcile', 'take:reconcile']);
        expect(events.every(e => e.origin === 'reconcile' && e.state_hash === current.hash && e.cause.uncertified_from === new Date(prior.recorded_at).toISOString())).toBe(true);
        const bypass = events.find(e => e.subject_kind === 'link' && e.value!.context === 'bypass')!;
        expect(bypass).toMatchObject({ trust_tier: 'unknown', tier_basis: 'unknown', value: { context: 'bypass', link_kind: null } });
        expect(events.find(e => e.subject_kind === 'page')!.value).toMatchObject({ full_set: true, counts: { facts: 2, takes: 2, links: 2, link_transitions: 0 } });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        await b.engine.executeRaw(`DELETE FROM links WHERE context = 'bypass'`);
        const again = await reconcileBeliefDrift(b.engine, b.sourceId);
        const second = await b.events(events.at(-1)!.id);
        // A per-key reconcile event now proves every surviving key: only the gone link and the page are written.
        expect(again.reconciled).toEqual(['companies/acme-example']);
        expect(shape(second).sort()).toEqual(['link:reconcile', 'page:reconcile']);
        expect(second.find(e => e.subject_kind === 'link')).toMatchObject({ subject_key: bypass.subject_key, value: null, cause: { absent: true } });
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval!.certified).toBe(true);
        expect(interval!.drift.map(d => [d.slug, d.from])).toEqual([['companies/acme-example', new Date(prior.recorded_at).toISOString()],
          ['companies/acme-example', new Date(events.at(-1)!.recorded_at).toISOString()]]);
        const inside = new Date(new Date(events[0]!.recorded_at).getTime() - 1).toISOString();
        expect(await coverageAt(b.engine, b.sourceId, inside, 'companies/acme-example')).toMatchObject({ ok: true, certified: false, uncertified_reason: 'drift' });
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b), 'companies/acme-example')).toMatchObject({ ok: true, certified: true });
        // Forced probe: an emitter that drops the page-level reconcile leaves no drift mark, so the interval would read certified.
        fault(drafts => drafts.filter(d => !(d.eventType === 'reconcile' && d.subjectKind === 'page')));
        await b.engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context, origin_page_id)
          SELECT a.id, p.id, 'mentions', 'markdown', 'forced', a.id FROM pages a, pages p
          WHERE a.source_id = $1 AND a.slug = 'companies/acme-example' AND p.source_id = $1 AND p.slug = 'people/bob-example'`, [b.sourceId]);
        const marks = (await coverageIntervals(b.engine, b.sourceId))[0]!.drift.length;
        await reconcileBeliefDrift(b.engine, b.sourceId);
        expect((await coverageIntervals(b.engine, b.sourceId))[0]!.drift.length).toBe(marks);
      });
    }, 180_000);

    test('probe 13: a stalled publication stays unproven until its commit mark, then becomes visible; a later event of the page proves it', async () => {
      await brain(async b => {
        await seeded(b);
        const slug = 'companies/acme-example';
        const beforeTx = await dbNow(b);
        await pause();
        const mark = await b.lastId();
        await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'probe_stall', origin: 'unmanaged' }, () =>
            tx.executeRaw(`UPDATE facts SET confidence = 0.4 WHERE source_id = $1 AND fact = 'Acme has ten staff'`, [b.sourceId]));
          await new Promise(resolve => setTimeout(resolve, 400));
        });
        const [event] = await b.events(mark);
        expect(shape([event!])).toEqual(['fact:fact.revised']);
        expect(event!.value).toMatchObject({ fact: 'Acme has ten staff', confidence: 0.4 });
        const stalled = new Date(new Date(event!.recorded_at).getTime() + 100).toISOString();
        const committed = await dbNow(b);
        expect(await unmarkedPublications(b.engine, b.sourceId)).toEqual([event!.publication_id]);
        expect(await beliefEventVisibility(b.engine, event!.id, beforeTx)).toBe('not_visible');
        expect(await beliefEventVisibility(b.engine, event!.id, stalled)).toBe('unproven');
        expect(await beliefEventVisibility(b.engine, event!.id, committed)).toBe('unproven');
        expect(await fillCommitMarks(b.engine, b.sourceId)).toBe(1);
        const marked = await dbNow(b);
        expect(await beliefEventVisibility(b.engine, event!.id, marked)).toBe('visible');
        expect(await beliefEventVisibility(b.engine, event!.id, committed)).toBe('unproven');
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
        await b.put(slug, page({ prose: 'A later edit.' }));
        const afterLater = await dbNow(b);
        await markBeliefCommits(b.engine, [event!.publication_id]);
        expect(shape(await b.events(event!.id))).toEqual(['page:page.published', 'fact:fact.revised']);
        expect(await beliefEventVisibility(b.engine, event!.id, afterLater)).toBe('visible');
        // Forced probe: a marker that stamps the event's own recorded time (an observer's early transaction start) makes the stalled interval visible.
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
        await b.engine.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, max(recorded_at) FROM belief_events
          WHERE publication_id = $1::uuid GROUP BY publication_id`, [event!.publication_id]);
        expect(await beliefEventVisibility(b.engine, event!.id, stalled)).toBe('visible');
      }, { managed: false });
    }, 120_000);

    test('probe 33: an observer that starts before a publication commits and marks it afterwards writes observed_at at or after recorded_at', async () => {
      await brain(async b => {
        await seeded(b);
        const mark = await b.lastId();
        const observe = async (publish: () => Promise<void>) => b.engine.transaction(async obs => {
          const [{ start }] = await obs.executeRaw<{ start: string }>('SELECT now() AS start');
          await publish();
          const other = engineCase.name === 'postgres' ? b.engine : obs;
          const [event] = await other.executeRaw<{ publication_id: string; recorded_at: string }>(`SELECT publication_id::text AS publication_id, recorded_at
            FROM belief_events WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT 1`, [b.sourceId, mark]);
          await other.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await markBeliefCommits(obs, [event!.publication_id]);
          const [row] = await obs.executeRaw<{ observed_at: string }>('SELECT observed_at FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await obs.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          await obs.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, now() FROM belief_events
            WHERE publication_id = $1::uuid GROUP BY publication_id`, [event!.publication_id]);
          const [broken] = await obs.executeRaw<{ observed_at: string }>('SELECT observed_at FROM belief_commit_marks WHERE publication_id = $1::uuid', [event!.publication_id]);
          return { start: new Date(start).getTime(), recorded: new Date(event!.recorded_at).getTime(), observed: new Date(row!.observed_at).getTime(),
            broken: new Date(broken!.observed_at).getTime() };
        });
        if (engineCase.name === 'postgres') {
          const r = await observe(async () => { await b.put('companies/acme-example', page({ prose: 'Observed edit.' })); });
          expect(r.start).toBeLessThan(r.recorded);
          expect(r.observed).toBeGreaterThanOrEqual(r.recorded);
          // Forced probe: a marker using now() (the observer's start) writes a mark below the event's recorded time.
          expect(r.broken).toBeLessThan(r.recorded);
          return;
        }
        // PGLite runs one transaction at a time, so an observer cannot start before a publication commits: the publication precedes it.
        await b.put('companies/acme-example', page({ prose: 'Observed edit.' }));
        const r = await observe(async () => {});
        expect(r.start).toBeGreaterThanOrEqual(r.recorded);
        expect(r.observed).toBeGreaterThanOrEqual(r.recorded);
        expect(r.broken).toBe(r.start);
      });
    }, 120_000);

    test('probe 16: activation interrupted by a concurrent edit resumes with one consistent cut per page', async () => {
      await brain(async b => {
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', page());
        await b.put('companies/beta-example', page({ title: 'Beta Example' }));
        await b.put('companies/gamma-example', page({ title: 'Gamma Example' }));
        fault(drafts => { if (drafts.some(d => d.eventType === 'baseline' && d.slug === 'companies/gamma-example')) throw new Error('interrupted'); return drafts; });
        await expect(enableBeliefLedger(b.engine, b.sourceId)).rejects.toThrow('interrupted');
        __setBeliefEmitterFaultForTests(null);
        const [running] = await coverageIntervals(b.engine, b.sourceId);
        expect(running).toMatchObject({ watermark: null, baseline: { pages_done: 2, pending: 2, complete: false } });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).checked).toBe(0);
        const mark = await b.lastId();
        await b.put('companies/gamma-example', page({ title: 'Gamma Example', facts: ['Acme raised a seed round', 'Gamma has twelve staff'] }));
        const edited = await b.events(mark);
        expect(shape(edited).sort()).toEqual(['fact:fact.asserted', 'fact:fact.retracted', 'page:page.published']);
        const run = await enableBeliefLedger(b.engine, b.sourceId);
        expect(run).toMatchObject({ resumed: true, pages: 2, complete: true, certified: true });
        const events = await b.events();
        const baselines = events.filter(e => e.event_type === 'baseline' && e.subject_kind === 'page');
        expect(baselines.map(e => e.slug).sort()).toEqual(['companies/acme-example', 'companies/beta-example', 'companies/gamma-example', 'people/alice-example']);
        const gamma = events.filter(e => e.slug === 'companies/gamma-example');
        expect(shape(gamma)).toEqual(['page:page.published', 'fact:fact.asserted', 'fact:fact.retracted', 'page:baseline']);
        const cut = gamma.at(-1)!;
        const now = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, cut.source_incarnation, 'companies/gamma-example'));
        expect(cut.state_hash).toBe(now.hash);
        expect(cut.value).toMatchObject({ snapshot: true, counts: { facts: 2, takes: 2, links: 1 } });
        const edit = new Date(gamma[0]!.recorded_at).toISOString();
        expect(await coverageAt(b.engine, b.sourceId, edit, 'companies/gamma-example')).toMatchObject({ ok: false, code: 'coverage_from', from: new Date(cut.recorded_at).toISOString() });
        expect(await coverageAt(b.engine, b.sourceId, edit, 'companies/acme-example')).toMatchObject({ ok: true, certified: true });
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        expect(interval).toMatchObject({ baseline: { pages_done: 4, pending: null, complete: true }, certified: true });
        expect(interval!.watermark).toBe(new Date(events.at(-1)!.recorded_at).toISOString());
      }, { enable: false });
      // Forced probe: a resume whose emitter drops a page's baseline leaves that page with no cut.
      await brain(async b => {
        await b.put('companies/acme-example', page());
        await b.put('companies/gamma-example', page({ title: 'Gamma Example' }));
        fault(drafts => drafts.filter(d => !(d.eventType === 'baseline' && d.slug === 'companies/gamma-example')));
        await enableBeliefLedger(b.engine, b.sourceId);
        __setBeliefEmitterFaultForTests(null);
        const baselines = (await b.events()).filter(e => e.event_type === 'baseline' && e.subject_kind === 'page');
        expect(baselines.map(e => e.slug)).not.toContain('companies/gamma-example');
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b), 'companies/gamma-example')).toMatchObject({ ok: false, code: 'coverage_from', from: null });
        expect((await b.events()).find(e => e.event_type === 'coverage.complete')!.cause).toMatchObject({ unbaselined_slugs: ['companies/gamma-example'] });
      }, { enable: false });
    }, 180_000);

    test('probe 16: activation after large-page version pruning baselines the page per subject at its current state', async () => {
      await brain(async b => {
        const big = (n: number) => page({ prose: `Edit ${n}. ${'Long prose. '.repeat(100_000)}` });
        await b.engine.setConfig('pages.segmented_storage', 'off');
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        for (let n = 0; n < 7; n++) await b.put('companies/huge-example', big(n));
        const [{ versions }] = await b.engine.executeRaw<{ versions: number }>(`SELECT count(*)::int AS versions FROM page_versions v JOIN pages p ON p.id = v.page_id
          WHERE p.source_id = $1 AND p.slug = 'companies/huge-example'`, [b.sourceId]);
        expect(Number(versions)).toBeLessThan(6);
        await enableBeliefLedger(b.engine, b.sourceId);
        const events = (await b.events()).filter(e => e.slug === 'companies/huge-example');
        expect(shape(events).sort()).toEqual(['fact:baseline', 'fact:baseline', 'link:baseline', 'page:baseline', 'take:baseline', 'take:baseline']);
        const head = events.find(e => e.subject_kind === 'page')!;
        expect(head.value).toMatchObject({ snapshot: false, counts: { facts: 2, takes: 2, links: 1 } });
        const now = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, head.source_incarnation, 'companies/huge-example'));
        expect(events.every(e => e.state_hash === now.hash && e.origin === 'baseline')).toBe(true);
        expect(events.filter(e => e.subject_kind === 'link').every(e => e.trust_tier === 'unknown' && e.tier_basis === 'unknown')).toBe(true);
        // Forced probe: an emitter that writes the large page as a text-free snapshot drops the values no retained version holds.
        await disableBeliefLedger(b.engine, b.sourceId);
        fault(drafts => drafts.filter(d => d.subjectKind === 'page' || d.eventType !== 'baseline'));
        const mark = await b.lastId();
        await enableBeliefLedger(b.engine, b.sourceId);
        expect(shape((await b.events(mark)).filter(e => e.slug === 'companies/huge-example'))).toEqual(['page:baseline']);
      }, { enable: false });
    }, 300_000);

    test('probe 17: a source removed and re-added with the same id inherits no event, interval or watermark', async () => {
      await brain(async b => {
        await seeded(b);
        const old = (await readLedgerSource(b.engine, b.sourceId))!;
        const oldEvents = await b.events();
        expect(await deleteSourceRow(b.engine, b.sourceId)).toBe(true);
        await b.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [b.sourceId, b.root]);
        rmSync(join(b.root, 'companies'), { recursive: true, force: true });
        rmSync(join(b.root, 'people'), { recursive: true, force: true });
        await claimWorktree(b.engine, b.sourceId, b.root);
        const fresh = (await readLedgerSource(b.engine, b.sourceId))!;
        expect(fresh.incarnation).not.toBe(old.incarnation);
        expect(fresh.coverage).toBeNull();
        expect(await coverageIntervals(b.engine, b.sourceId)).toEqual([]);
        expect(await coverageAt(b.engine, b.sourceId, await dbNow(b))).toMatchObject({ ok: false, code: 'coverage_from', from: null });
        const mark = await b.lastId();
        await b.put('companies/acme-example', page());
        expect(await b.events(mark)).toEqual([]);
        await enableBeliefLedger(b.engine, b.sourceId);
        const intervals = await coverageIntervals(b.engine, b.sourceId);
        expect(intervals.map(i => [i.incarnation, i.baseline.pages_done])).toEqual([[fresh.incarnation, 1]]);
        expect(Date.parse(intervals[0]!.watermark!)).toBeGreaterThan(new Date(oldEvents.at(-1)!.recorded_at).getTime());
        const after = await b.events(mark);
        expect(after.every(e => e.source_incarnation === fresh.incarnation)).toBe(true);
        const lifetime = after.find(e => e.subject_kind === 'page')!.page_lifetime;
        expect(oldEvents.some(e => e.page_lifetime === lifetime)).toBe(false);
        expect((await b.events()).filter(e => e.source_incarnation === old.incarnation)).toEqual(oldEvents);
        // Forced probe: an emitter that stamps the old incarnation on the new source's coverage hides the new interval.
        await disableBeliefLedger(b.engine, b.sourceId);
        fault(drafts => drafts.map(d => ({ ...d, incarnation: old.incarnation })));
        await enableBeliefLedger(b.engine, b.sourceId).catch(() => null);
        __setBeliefEmitterFaultForTests(null);
        expect((await coverageIntervals(b.engine, b.sourceId)).map(i => i.incarnation)).toEqual([fresh.incarnation]);
        expect((await coverageIntervals(b.engine, b.sourceId)).at(-1)!.stopped_at).not.toBeNull();
      }, { managed: false });
    }, 120_000);

    test('doctor belief_ledger_coverage: off is information with an ask_user enable; a drift warns, --fix reconciles it, a partial purge replay asks the user', async () => {
      await brain(async b => {
        await seeded(b);
        for (const slug of ['people/bob-example', 'people/carol-example']) await b.put(slug, beliefPage({ type: 'person', title: slug }));
        const off = await doctor(b);
        expect(off).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice',
          fix: { argv: ['gbrain', 'beliefs', 'enable', '--source', b.sourceId], ask_user: true } });
        await b.enable();
        const clean = await doctor(b, { tier: 'deep' });
        expect(clean.status).toBe('ok');
        expect(clean.message).toContain(`${b.sourceId}: recording since`);
        expect(clean.details!.sources).toMatchObject([{ source_id: b.sourceId, certified: true, drift: { count: 0, exact: true } }]);
        await bypassLink(b, 'people/bob-example');
        const drifted = await doctor(b);
        expect(drifted).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'beliefs', 'reconcile', '--source', b.sourceId, '--json'], actor: 'agent' } });
        expect(drifted.message).toContain(`${b.sourceId}: 1 drifted slug(s) (e.g. companies/acme-example)`);
        const before = await b.lastId();
        const fixed = await doctor(b, { doFix: true });
        expect(fixed.status).toBe('ok');
        expect(fixed.message).toContain('1 drift mark(s)');
        expect(shape(await b.events(before)).sort()).toEqual(['fact:reconcile', 'fact:reconcile', 'link:reconcile', 'link:reconcile', 'page:reconcile', 'take:reconcile', 'take:reconcile']);
        // Forced probe: an emitter that drops every reconcile event leaves the drift in place, so --fix still warns.
        fault(drafts => drafts.filter(d => d.eventType !== 'reconcile'));
        await bypassLink(b, 'people/carol-example');
        const unfixed = await doctor(b, { doFix: true });
        expect(unfixed.status).toBe('warn');
        expect(unfixed.message).toContain(`${b.sourceId}: 1 drifted slug(s)`);
        __setBeliefEmitterFaultForTests(null);
        expect((await doctor(b, { doFix: true })).status).toBe('ok');
        const source = (await readLedgerSource(b.engine, b.sourceId))!;
        await pause();
        const archivedAt = await dbNow(b);
        await pause();
        const inGap = await dbNow(b);
        await pause();
        const restore = async (lines: PurgeMirrorLine[] | null) => {
          await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines, archivedAt, restoreId: randomUUID() }));
          await fillCommitMarks(b.engine, b.sourceId);
        };
        await restore([]);
        expect((await doctor(b)).status).toBe('ok');
        expect(await coverageAt(b.engine, b.sourceId, inGap)).toMatchObject({ ok: false, code: 'coverage_gap', reason: 'restore', from: archivedAt });
        const [restored] = await b.engine.executeRaw<{ at: string }>(`SELECT max(recorded_at) AS at FROM belief_events WHERE source_id = $1 AND event_type = 'coverage.restored'`, [b.sourceId]);
        expect(await coverageAt(b.engine, b.sourceId, new Date(Date.parse(new Date(restored!.at).toISOString()) + 1).toISOString())).toMatchObject({ ok: true });
        await restore([{ kind: 'intent', request: randomUUID(), request_id: 'req-purge-1', source_id: b.sourceId, source_incarnation: source.incarnation, scope: 'fact',
          recorded_at: new Date(Date.parse(archivedAt) + 1).toISOString(), purge_epoch: 1, facts: [], takes: [], lifetimes: [] }]);
        const asked = await doctor(b);
        expect(asked).toMatchObject({ status: 'warn', fix: { actor: 'user', ask_user: true } });
        expect(asked.message).toContain(`(${archivedAt}): purge replay unverified for req-purge-1`);
        await restore(null);
        expect((await doctor(b)).message).toContain('purge replay unavailable');
      }, { enable: false });
    }, 180_000);

    test('unmanaged projection points: legacy import, extract_facts, takes reextract and derived links each append one marked unmanaged publication; a dropped point shows as drift', async () => {
      await brain(async b => {
        const marked = async (publicationId: string) => (await b.engine.executeRaw('SELECT 1 FROM belief_commit_marks WHERE publication_id = $1::uuid', [publicationId])).length === 1;
        const projectedDrift = async () => (await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted.map(d => d.slug).filter(slug => !slug.startsWith('extracts/'));
        const step = async (run: () => Promise<unknown>) => {
          const before = await b.lastId();
          await run();
          const events = await b.events(before);
          expect(new Set(events.map(e => e.publication_id)).size).toBe(1);
          expect(await marked(events[0]!.publication_id)).toBe(true);
          return events.map(e => [e.slug, `${e.subject_kind}:${e.event_type}`, e.origin, e.cause.op]);
        };
        const importPage = (slug: string, body: string) => importFromContent(b.engine, slug, body, { sourceId: b.sourceId, noEmbed: true });
        await importPage('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        const acme = beliefPage({ facts: ['Acme raised a seed round'], takes: ['Acme will win its market'], links: ['people/alice-example'] });
        expect(await step(() => importPage('companies/acme-example', acme))).toEqual([['companies/acme-example', 'page:page.published', 'unmanaged', 'import']]);
        expect(await step(() => runExtractFacts(b.engine, { sourceId: b.sourceId, slugs: ['companies/acme-example'] })))
          .toEqual([['companies/acme-example', 'fact:fact.asserted', 'unmanaged', 'extract_facts']]);
        expect(await step(() => extractTakes(b.engine, { source: 'db', sourceId: b.sourceId, slugs: ['companies/acme-example'] })))
          .toEqual([['companies/acme-example', 'take:take.asserted', 'unmanaged', 'takes_reextract']]);
        expect(await step(() => extractStaleFromDB(b.engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: b.sourceId, catchUp: false })))
          .toEqual([['companies/acme-example', 'link:link.asserted', 'unmanaged', 'derived_links']]);
        expect(await projectedDrift()).toEqual([]);
        // Forced probe: a takes reextract whose events are dropped leaves its slug drifted.
        await importPage('companies/beta-example', beliefPage({ title: 'Beta Example', takes: ['Beta will ship late'] }));
        fault(drafts => drafts.filter(d => d.cause.op !== 'takes_reextract'));
        await extractTakes(b.engine, { source: 'db', sourceId: b.sourceId, slugs: ['companies/beta-example'] });
        __setBeliefEmitterFaultForTests(null);
        expect(await projectedDrift()).toEqual(['companies/beta-example']);
      }, { managed: false });
    }, 180_000);

    test('backfill from page_versions: one marked backfill publication per version, historical time in source_time only, idempotent, and a purge mid-run re-prepares', async () => {
      await brain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round'], takes: ['Acme will win its market'] }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'], takes: ['Acme will win its market'] }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme has ten staff'], takes: [{ claim: 'Acme will win its market', weight: '0.4' }] }));
        await expect(backfillBeliefHistory(b.engine, b.sourceId)).rejects.toMatchObject({ code: 'belief_coverage_required' });
        await b.enable();
        const since = (await coverageIntervals(b.engine, b.sourceId))[0]!.started_at;
        const before = await b.lastId();
        let bumped = 0;
        const report = await backfillBeliefHistory(b.engine, b.sourceId, { prepareHook: async (_slug, attempt) => {
          if (attempt === 0) { bumped++; await b.engine.executeRaw('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1', [b.sourceId]); }
        } });
        expect(bumped).toBe(1);
        expect(report).toMatchObject({ since, events: 9, retried: 1, pages: [{ slug: 'companies/acme-example', versions: 3, events: 9, complete: true, reasons: [] }] });
        const events = await b.events(before);
        expect(events.map(e => [`${e.subject_kind}:${e.event_type}`, e.cause.version === null ? 'start' : 'version', e.value?.fact ?? e.value?.weight ?? null])).toEqual([
          ['page:page.published', 'version', null], ['fact:fact.asserted', 'version', 'Acme raised a seed round'], ['take:take.asserted', 'version', 0.5],
          ['page:page.published', 'version', null], ['fact:fact.asserted', 'version', 'Acme has ten staff'],
          ['page:page.published', 'start', null], ['fact:fact.retracted', 'start', null], ['take:take.revised', 'start', 0.4],
          ['page:backfill', 'version', null]]);
        expect(events.every(e => e.origin === 'backfill')).toBe(true);
        expect(events.at(-1)!.value).toEqual({ backfill_complete: true, versions: 2, reasons: [], coverage_start: since });
        expect(events.at(-1)!.cause).toEqual({ op: 'backfill', purge_epoch: 1 });
        const times = await b.engine.executeRaw<{ source_time: string | null; recorded_at: string; marked: boolean }>(`SELECT e.source_time, e.recorded_at,
            EXISTS (SELECT 1 FROM belief_commit_marks m WHERE m.publication_id = e.publication_id) AS marked FROM belief_events e WHERE e.source_id = $1 AND e.id > $2 ORDER BY e.id`, [b.sourceId, before]);
        const ms = (v: unknown) => new Date(v as string).getTime();
        expect(times.every(t => t.marked && t.source_time !== null && ms(t.source_time) <= ms(since) && ms(t.recorded_at) >= ms(since))).toBe(true);
        expect(new Set(events.map(e => e.publication_id)).size).toBe(4);
        expect((await backfillBeliefHistory(b.engine, b.sourceId)).events).toBe(0);
        expect(await b.lastId()).toBe(events.at(-1)!.id);
        // Forced probe: a purge on every attempt exhausts the retries and refuses with belief_stale_preparation.
        await b.put('companies/beta-example', beliefPage({ title: 'Beta Example', facts: ['Beta ships late'] }));
        await b.engine.executeRaw(`UPDATE pages SET created_at = $2::timestamptz - interval '1 hour' WHERE source_id = $1 AND slug = 'companies/beta-example'`, [b.sourceId, since]);
        await expect(backfillBeliefHistory(b.engine, b.sourceId, { slugs: ['companies/beta-example'], prepareHook: async () => {
          await b.engine.executeRaw('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1', [b.sourceId]);
        } })).rejects.toMatchObject({ code: 'belief_stale_preparation' });
      }, { enable: false });
    }, 180_000);

    test('#7: a disable during enable ends the run without coverage.complete, and a restore never turns a stopped ledger back on', async () => {
      await brain(async b => {
        for (let i = 0; i < 5; i++) await b.put(`notes/n-${i}-example`, beliefPage({ type: 'note', title: `N ${i}`, facts: [`Fact number ${i} holds`] }));
        const run = await enableBeliefLedger(interceptTransactions(b.engine, 3, async () => { expect(await disableBeliefLedger(b.engine, b.sourceId)).toBe(true); }), b.sourceId);
        expect(run).toMatchObject({ complete: false, certified: false });
        expect((await latestCoverage(b.engine, b.sourceId))?.type).toBe('coverage.stopped');
        expect((await coverageIntervals(b.engine, b.sourceId)).map(i => [i.watermark, !!i.stopped_at, i.baseline.complete])).toEqual([[null, true, false]]);
        const quiet = await b.lastId();
        await b.put('notes/after-disable-example', beliefPage({ type: 'note', title: 'After', facts: ['Recorded after disable'] }));
        expect(await b.events(quiet)).toEqual([]);
        await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines: [], archivedAt: new Date(Date.now() - 60_000).toISOString(), restoreId: randomUUID() }));
        expect((await readLedgerSource(b.engine, b.sourceId))!.coverage).toBe('coverage.stopped');
        const restored = await b.lastId();
        await b.put('notes/after-restore-example', beliefPage({ type: 'note', title: 'After restore', facts: ['Recorded after restore'] }));
        expect(await b.events(restored)).toEqual([]);
        const again = await enableBeliefLedger(b.engine, b.sourceId);
        expect(again).toMatchObject({ resumed: false, complete: true, pages: 7 });
        expect((await coverageIntervals(b.engine, b.sourceId)).map(i => [!!i.watermark, !!i.stopped_at])).toEqual([[false, true], [true, false]]);
        // A restore of an archive taken mid-baseline: the next enable resumes that run instead of returning at once.
        await disableBeliefLedger(b.engine, b.sourceId);
        fault(drafts => { if (drafts.some(d => d.eventType === 'baseline' && d.slug === 'notes/n-3-example')) throw new Error('interrupted'); return drafts; });
        await expect(enableBeliefLedger(b.engine, b.sourceId)).rejects.toThrow('interrupted');
        __setBeliefEmitterFaultForTests(null);
        await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines: [], archivedAt: new Date(Date.now() - 60_000).toISOString(), restoreId: randomUUID() }));
        const resumed = await enableBeliefLedger(b.engine, b.sourceId);
        expect(resumed).toMatchObject({ resumed: true, complete: true });
        expect(resumed.pages).toBeGreaterThan(0);
        expect((await coverageIntervals(b.engine, b.sourceId)).at(-1)).toMatchObject({ stopped_at: null, baseline: { complete: true, pages_done: 7 } });
      }, { managed: false, enable: false });
    }, 180_000);

    test('#27 and #16: concurrent enables share one run; a page renamed onto a slug the cursor passed is baselined before the watermark', async () => {
      await brain(async b => {
        for (let i = 0; i < 12; i++) await b.put(`notes/m-${String(i).padStart(2, '0')}-example`, beliefPage({ type: 'note', title: `M ${i}`, facts: [`Other fact ${i} holds`] }));
        const runs = await Promise.all([enableBeliefLedger(b.engine, b.sourceId), enableBeliefLedger(b.engine, b.sourceId)]);
        expect(runs[0]!.runId).toBe(runs[1]!.runId);
        expect(runs.every(r => r.complete)).toBe(true);
        const intervals = await coverageIntervals(b.engine, b.sourceId);
        expect(intervals.map(i => [i.run, !!i.watermark, i.baseline.pages_done])).toEqual([[runs[0]!.runId, true, 12]]);
        const baselines = (await b.events()).filter(e => e.event_type === 'baseline' && e.subject_kind === 'page').map(e => e.slug);
        expect(baselines.length).toBe(new Set(baselines).size);
      }, { managed: false, enable: false });
      await brain(async b => {
        for (const slug of ['notes/a-example', 'notes/m-example', 'notes/z-example']) await b.put(slug, beliefPage({ type: 'note', title: slug, facts: [`${slug} claim one`] }));
        const run = await enableBeliefLedger(interceptTransactions(b.engine, 3, async () => {
          await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/z-example', newSlug: 'notes/b-example', to: 'notes/b-example.md' });
        }, { after: true }), b.sourceId);
        expect(run).toMatchObject({ complete: true });
        const baselined = (await b.events()).filter(e => e.event_type === 'baseline' && e.subject_kind === 'page').map(e => e.slug).sort();
        expect(baselined).toEqual(['notes/a-example', 'notes/b-example', 'notes/m-example']);
        const [interval] = await coverageIntervals(b.engine, b.sourceId);
        const baselineB = (await b.events()).find(e => e.event_type === 'baseline' && e.slug === 'notes/b-example')!;
        expect(Date.parse(baselineB.recorded_at)).toBeLessThanOrEqual(Date.parse(interval!.watermark!));
      }, { managed: false, enable: false });
    }, 180_000);

    test('#17: a slug no page key can name is left out of the baseline and listed, and enable completes instead of wedging', async () => {
      await brain(async b => {
        await b.put('notes/ok-example', beliefPage({ type: 'note', title: 'Ok', facts: ['Fine fact'] }));
        await b.engine.executeRaw(`INSERT INTO facts(source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, $2, 'A db-only fact', 'fact', 'world', 'manual')`, [b.sourceId, 'people\\bad']);
        const run = await enableBeliefLedger(b.engine, b.sourceId);
        expect(run).toMatchObject({ complete: true, unkeyable: ['people\\bad'] });
        const complete = (await b.events()).find(e => e.event_type === 'coverage.complete')!;
        expect(complete.cause).toMatchObject({ unkeyable_slugs: ['people\\bad'], pages: 1 });
        expect(await enableBeliefLedger(b.engine, b.sourceId)).toMatchObject({ complete: true, resumed: true, pages: 0 });
      }, { managed: false, enable: false });
    }, 120_000);

    test('#15: a backfill does not read as drift, so neither the cycle nor doctor reconciles it', async () => {
      await brain(async b => {
        await b.put('companies/hist-example', beliefPage({ title: 'Hist Example', facts: ['Hist example sells widgets'] }));
        await b.put('companies/hist-example', beliefPage({ title: 'Hist Example', facts: ['Hist example sells widgets', 'Hist example has two staff'] }));
        await b.enable();
        expect((await backfillBeliefHistory(b.engine, b.sourceId)).events).toBeGreaterThan(0);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const mark = await b.lastId();
        expect((await reconcileBeliefDrift(b.engine, b.sourceId, { op: 'cycle_extract', limit: DRIFT_SAMPLE_PAGES })).events).toBe(0);
        expect(await b.lastId()).toBe(mark);
        expect((await coverageIntervals(b.engine, b.sourceId))[0]!.drift).toEqual([]);
        // A real change after the backfill still drifts and reconciles.
        await b.engine.executeRaw(`UPDATE facts SET confidence = 0.4 WHERE source_id = $1 AND fact = 'Hist example has two staff'`, [b.sourceId]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted.map(d => d.slug)).toEqual(['companies/hist-example']);
      }, { managed: false, enable: false });
    }, 120_000);

    test('#24: a read-only doctor run mints and ends no page lifetime; --fix does', async () => {
      await brain(async b => {
        await seeded(b);
        await b.engine.putPage('notes/untracked-example', { type: 'note', title: 'Untracked', compiled_truth: 'Written outside every projection point.' }, { sourceId: b.sourceId });
        const before = await lifetimeCount(b);
        const report = await doctor(b);
        expect(report.status).toBe('warn');
        expect(report.message).toContain('notes/untracked-example');
        expect(await lifetimeCount(b)).toBe(before);
        // Forced probe: the --fix reconcile does mint the page's lifetime, so the count would have caught a read-only scan minting one.
        expect((await doctor(b, { doFix: true })).status).toBe('ok');
        expect(await lifetimeCount(b)).toBe(before + 1);
      }, { managed: false });
    }, 120_000);

    test('#41: a renamed page keeps its cut: coverageAt on the new slug answers from the baseline under its lifetime', async () => {
      await brain(async b => {
        await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', facts: ['A renamed claim'] }));
        await b.enable();
        await pause();
        const between = await dbNow(b);
        await pause();
        await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/old-example', newSlug: 'notes/new-example', to: 'notes/new-example.md' });
        expect(await coverageAt(b.engine, b.sourceId, between, 'notes/new-example')).toMatchObject({ ok: true, certified: false, uncertified_reason: 'unmanaged' });
        expect(await coverageAt(b.engine, b.sourceId, between, 'notes/never-example')).toMatchObject({ ok: false, code: 'coverage_from' });
      }, { managed: false, enable: false });
    }, 120_000);

    test('#28: the routine unmarked-publication scan reads only the recent window; deep reads the whole source', async () => {
      await brain(async b => {
        await seeded(b);
        const [old] = await b.events();
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [old!.publication_id]);
        await b.engine.executeRaw(`UPDATE belief_events SET recorded_at = recorded_at - make_interval(days => ${UNMARKED_WINDOW_DAYS + 1}) WHERE publication_id = $1::uuid`, [old!.publication_id]);
        expect(await unmarkedPublications(b.engine, b.sourceId)).toEqual([]);
        expect(await unmarkedPublications(b.engine, b.sourceId, 1000, { deep: true })).toEqual([old!.publication_id]);
        expect(await fillCommitMarks(b.engine, b.sourceId, { deep: true })).toBe(1);
      });
    }, 120_000);

    test('#37: gbrain beliefs resolves the source through the ambient chain, and a bare --source is refused', async () => {
      await brain(async b => {
        await withEnv({ GBRAIN_SOURCE: b.sourceId }, () => runBeliefs(b.engine, ['enable']));
        expect((await latestCoverage(b.engine, b.sourceId))?.type).toBe('coverage.complete');
        expect(await latestCoverage(b.engine, 'default')).toBeNull();
        await runBeliefs(b.engine, ['disable', '--source']);
        expect(currentExitCode()).toBe(2);
        setCliExitVerdict(0);
        expect((await latestCoverage(b.engine, b.sourceId))?.type).toBe('coverage.complete');
      }, { managed: false, enable: false });
    }, 120_000);

    test('review #35: a backfill rerun after versions were pruned appends nothing, and a page whose lifetime turned over after preparation is not backfilled onto the ended lifetime', async () => {
      await brain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round'] }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'] }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme has ten staff'] }));
        await b.enable();
        expect((await backfillBeliefHistory(b.engine, b.sourceId)).events).toBe(7);
        const after = await b.lastId();
        await b.engine.executeRaw(`DELETE FROM page_versions WHERE id = (SELECT min(v.id) FROM page_versions v JOIN pages p ON p.id = v.page_id
          WHERE p.source_id = $1 AND p.slug = 'companies/acme-example')`, [b.sourceId]);
        expect((await backfillBeliefHistory(b.engine, b.sourceId)).events).toBe(0);
        expect(await b.lastId()).toBe(after);
        const keyed = await b.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM belief_events WHERE source_id = $1 AND origin = 'backfill'
          AND subject_kind = 'fact' AND event_type = 'fact.asserted' GROUP BY subject_key HAVING count(*) > 1`, [b.sourceId]);
        expect(keyed).toEqual([]);
        await b.put('companies/beta-example', beliefPage({ title: 'Beta Example', facts: ['Beta ships late'] }));
        await b.put('companies/beta-example', beliefPage({ title: 'Beta Example', facts: ['Beta ships early'] }));
        const since = (await coverageIntervals(b.engine, b.sourceId))[0]!.started_at;
        await b.engine.executeRaw(`UPDATE pages SET created_at = $2::timestamptz - interval '1 hour' WHERE source_id = $1 AND slug = 'companies/beta-example'`, [b.sourceId, since]);
        await b.engine.executeRaw(`UPDATE page_versions SET snapshot_at = $2::timestamptz - interval '1 minute' WHERE page_id = (SELECT id FROM pages
          WHERE source_id = $1 AND slug = 'companies/beta-example')`, [b.sourceId, since]);
        const [{ page_lifetime: old }] = await b.engine.executeRaw<{ page_lifetime: string }>(`SELECT l.page_lifetime::text AS page_lifetime FROM belief_page_lifetimes l
          WHERE l.source_id = $1 AND l.slug = 'companies/beta-example' AND l.ended_at IS NULL`, [b.sourceId]);
        const report = await backfillBeliefHistory(b.engine, b.sourceId, { slugs: ['companies/beta-example'], prepareHook: async (_slug, attempt) => {
          if (attempt > 0) return;
          const source = (await readLedgerSource(b.engine, b.sourceId))!;
          const [{ id }] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/beta-example'`, [b.sourceId]);
          await b.engine.transaction(async tx => {
            await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'companies/beta-example' }]);
            await endLifetime(tx, old);
            await mintLifetime(tx, { sourceId: b.sourceId, incarnation: source.incarnation, slug: 'companies/beta-example', pageId: Number(id) });
          });
        } });
        expect(report).toMatchObject({ events: 6, retried: 1, pages: [{ slug: 'companies/beta-example', events: 6 }] });
        expect(await b.engine.executeRaw(`SELECT id FROM belief_events WHERE page_lifetime = $1::uuid AND origin = 'backfill'`, [old])).toEqual([]);
      }, { enable: false });
    }, 180_000);

    test('probe 9: graduation PGLite -> ' + engineCase.name + ' carries an identical ledger: equal event_key sets, digests and replay', async () => {
      await beliefBrain(async b => {
        await seeded(b);
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }] }));
        await b.engine.executeRaw(`UPDATE takes SET resolved_at = now(), resolved_outcome = true WHERE claim = 'Acme will hire fast'`);
        await reconcileBeliefDrift(b.engine, b.sourceId);
        const ledger = GRADUATION_INVENTORY.entries.filter(e => e.relation.startsWith('belief_'));
        expect(ledger.map(e => [e.relation, e.class]).sort()).toEqual(['belief_commit_marks', 'belief_events', 'belief_page_lifetimes', 'belief_redactions',
          'belief_retier_manifest'].map(r => [r, 'carry']));
        const keys = async (engine: BrainEngine) => (await engine.executeRaw<{ k: string }>(`SELECT encode(event_key, 'hex') AS k FROM belief_events ORDER BY id`)).map(r => r.k);
        const replay = async (engine: BrainEngine) => ({ intervals: await coverageIntervals(engine, b.sourceId), drift: (await scanBeliefDrift(engine, b.sourceId, { deep: true })).drifted,
          events: (await engine.executeRaw<Record<string, unknown>>(`SELECT id::int AS id, subject_key, event_type, value_hash, state_hash, recorded_at FROM belief_events ORDER BY id`))
            .map(r => ({ ...r, recorded_at: new Date(r.recorded_at as string).toISOString() })) });
        const graduate = async (mutate: (entries: readonly InventoryEntry[]) => readonly InventoryEntry[]) => {
          const t = await isolatedSharedSkillsEngine(engineCase.databaseUrl);
          const e = { source: b.engine, target: t.engine };
          await copyAll(e, mutate(await copiedEntries(e)), { bypass: 'session_replication_role', runId: randomUUID() });
          await copySequences(e);
          return t;
        };
        const target = await graduate(entries => entries);
        try {
          expect(await keys(target.engine)).toEqual(await keys(b.engine));
          expect(await digestMismatches({ source: b.engine, target: target.engine }, ledger)).toEqual([]);
          expect(await replay(target.engine)).toEqual(await replay(b.engine));
          const [{ next }] = await target.engine.executeRaw<{ next: number }>(`SELECT nextval('belief_events_id_seq')::int AS next`);
          expect(next).toBe(await b.lastId() + 1);
        } finally { await target.close(); }
        // Forced probe: a copier that drops one ledger row is caught by the key-set comparison.
        const broken = await graduate(entries => entries.map(entry => entry.relation === 'belief_events' ? { ...entry, rowFilter: 'id <> 1' } : entry));
        try { expect(await keys(broken.engine)).not.toEqual(await keys(b.engine)); } finally { await broken.close(); }
      }, { managed: false });
    }, 300_000);

    test('probe 9: the legacy engine copier refuses a brain with a ledger, naming it', async () => {
      const t = await isolatedSharedSkillsEngine(engineCase.databaseUrl);
      try {
        const [{ incarnation }] = await t.engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 'default'`);
        await t.engine.executeRaw(`INSERT INTO belief_events (event_key, source_id, source_incarnation, slug, subject_kind, subject_key, event_type, trust_tier, visibility,
          publication_id, ord, state_hash, cause) VALUES (decode(md5('k'), 'hex'), 'default', $1::uuid, '', 'coverage', '["coverage"]', 'coverage.started', 'unknown', 'world',
          gen_random_uuid(), 0, '', '{}'::jsonb)`, [incarnation]);
        expect(await t.engine.executeRaw('SELECT 1 FROM persistence_requests UNION ALL SELECT 1 FROM fact_withdrawals UNION ALL SELECT 1 FROM persistence_worktrees')).toEqual([]);
        const refusal = await assertLegacyEngineMigration(t.engine).then(() => null, (error: OperationError) => error);
        expect(refusal?.code).toBe('writer_coordinator_required');
        expect(refusal?.message).toContain('belief ledger');
        expect(String((refusal?.toJSON() as { why?: string }).why)).toContain('rows in belief_events');
        // Forced probe: the same brain without its ledger row is not refused, so the refusal is the ledger's.
        await t.engine.executeRaw('DELETE FROM belief_events');
        await expect(assertLegacyEngineMigration(t.engine)).resolves.toBeUndefined();
      } finally { await t.close(); }
    }, 120_000);
  });
}
