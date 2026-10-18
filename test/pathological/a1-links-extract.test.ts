/**
 * GBRA-130 A-1: one page whose link derivation throws used to stop managed link
 * extraction (`extract --stale`, the extract job, the cycle's stale drain and the
 * sync tail) for the whole source, every run, because the next run restarts at
 * page id 0 and hits the same page first.
 *
 * Authoring gate: (1) protects "one bad page never stops managed link extraction":
 * the healthy siblings derive in the same run, the bad page is reported with a typed
 * code and fix, a content failure is held after 3 runs at the same revision and
 * extractor generation, a run-scoped failure still stops the run and holds nothing.
 * (2) Reverting the per-page isolation in links-maintenance.ts rethrows the first
 * failure and every item case goes red. (3) No existing test injects a failing page
 * into the managed extraction. (4) The failure is injected by wrapping the engine's
 * transaction (no production seam); the #6808 cases build the real orphan-source state.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractManagedStaleLinks, runManagedStaleExtraction } from '../../src/core/persistence/links-maintenance.ts';
import { runPhaseExtractDatabaseOnly } from '../../src/core/cycle/connector-extract.ts';
import { checkLinksExtractionLag } from '../../src/commands/doctor.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { maintenanceAttribution } from '../../src/core/persistence/attribution.ts';
import { effectiveLinkExtractorWatermark } from '../../src/core/link-extraction-watermark.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const TARGET = 'notes/target-example';
const PAGES = Array.from({ length: 8 }, (_, i) => `notes/p-${String(i + 1).padStart(2, '0')}`);
const BAD = 'notes/p-03';
const GHOST = 'ghost-example';
const contentError = () => Object.assign(new Error('value too long for type character varying(64)'), { code: '22001' });
const healthy = PAGES.filter(slug => slug !== BAD);

async function seed(engine: BrainEngine, sourceId = 'default', slugs = PAGES) {
  await engine.setConfig('mentions.auto_link', 'false');
  if (sourceId === 'default') await engine.putPage(TARGET, { type: 'note', title: 'Target', compiled_truth: 'The target.' }, { sourceId });
  for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `See [[${TARGET}]].` }, { sourceId });
}

/** The #6808 state: pages whose source row is gone (the FK is dropped only in this isolated brain). */
async function seedOrphans(engine: BrainEngine, slugs: string[]) {
  await seed(engine);
  await engine.executeRaw('ALTER TABLE pages DROP CONSTRAINT pages_source_id_fkey');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [GHOST]);
  await seed(engine, GHOST, slugs);
  await engine.executeRaw('DELETE FROM sources WHERE id=$1', [GHOST]);
}

/**
 * The outermost transactions' replaceDerivedLinks throws error() for the listed slugs; returns the restore. A nested
 * transaction (the tx engine's own transaction method, which inherits this property) goes straight to the original.
 */
function failDerive(engine: BrainEngine, slugs: Set<string>, error: () => unknown): () => void {
  const original = engine.transaction;
  engine.transaction = (async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) {
    if (this !== engine) return original.call(this, fn, opts as never);
    return original.call(engine, async (tx: BrainEngine) => {
      const real = tx.replaceDerivedLinks;
      tx.replaceDerivedLinks = (async (origin: { slug: string }, ...rest: unknown[]) => {
        if (slugs.has(origin.slug)) throw error();
        return (real as (...a: unknown[]) => Promise<unknown>).call(tx, origin, ...rest);
      }) as BrainEngine['replaceDerivedLinks'];
      try { return await fn(tx); } finally { delete (tx as { replaceDerivedLinks?: unknown }).replaceDerivedLinks; }
    }, opts as never);
  }) as BrainEngine['transaction'];
  return () => { engine.transaction = original; };
}

async function holds(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; state: string; code: string; attempts: number }>(
    `SELECT slug, links_extract_failure->>'state' AS state, links_extract_failure->>'code' AS code, (links_extract_failure->>'attempts')::int AS attempts
       FROM pages WHERE links_extract_failure IS NOT NULL ORDER BY slug`);
}

async function stamped(engine: BrainEngine, slug: string, sourceId = 'default') {
  const [row] = await engine.executeRaw<{ at: unknown }>('SELECT links_extracted_at AS at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row?.at != null;
}

const run = (engine: BrainEngine) => extractManagedStaleLinks(engine, { sourceId: 'default', mentions: false });
const runAll = (engine: BrainEngine) => extractManagedStaleLinks(engine, { mentions: false });

/** An edit of the bad page: a coordinated content write, so the page gets a new knowledge revision. */
async function edit(engine: BrainEngine, body: string) {
  const attribution = await maintenanceAttribution(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'],
    () => tx.executeRaw('UPDATE pages SET compiled_truth=$1, updated_at=now() WHERE source_id=$2 AND slug=$3', [body, 'default', BAD]), attribution));
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-1 managed link extraction isolates one page (${backend})`, () => {
    test('A-1 item: a page whose derive throws is reported, the siblings derive, and it is held after 3 runs', async () => {
      await managedBrain(async ({ engine }) => {
        const restore = failDerive(engine, new Set([BAD]), contentError);
        try {
          const before = await snapshotItems(engine, 'default');
          const first = await expectUnitNotAborted(() => run(engine));
          expect(first.pages).toBe(healthy.length + 1);
          expectItemFailure(first.failures?.[0], { key: BAD, code: 'invalid_data', fix: /extract.*--stale.*--source-id.*default/ });
          expect({ held: first.failures?.[0]?.held, attempts: first.failures?.[0]?.attempts }).toEqual({ held: false, attempts: 1 });
          expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: [BAD], expectProgress: healthy, progressFields: ['links'] });
          for (const slug of healthy) expect({ slug, stamped: await stamped(engine, slug) }).toEqual({ slug, stamped: true });
          expect(await stamped(engine, BAD)).toBe(false);

          await run(engine);
          expect(await holds(engine)).toEqual([{ slug: BAD, state: 'failing', code: 'invalid_data', attempts: 2 }]);
          const third = await run(engine);
          expectItemFailure(third.failures?.[0], { key: BAD, code: 'invalid_data', fix: /--retry-held/ });
          expect(third.failures?.[0]?.held).toBe(true);
          expect(await holds(engine)).toEqual([{ slug: BAD, state: 'held', code: 'invalid_data', attempts: 3 }]);

          const fourth = await run(engine);
          expect({ pages: fourth.pages, failures: fourth.failures ?? [], remaining: fourth.remaining }).toEqual({ pages: 0, failures: [], remaining: 0 });

          const check = await checkLinksExtractionLag(engine, { sourceId: 'default' });
          expect((check.details as { held?: number }).held).toBe(1);
          expect(check.status).toBe('warn');
          expect(check.fix?.argv).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'default', '--retry-held']);
          expect(check.message).toContain(BAD);
        } finally { restore(); }
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);

    test('A-1 transient: a statement timeout is reported and retried every run, never held', async () => {
      await managedBrain(async ({ engine }) => {
        const restore = failDerive(engine, new Set([BAD]), () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        try {
          for (let i = 0; i < 4; i++) {
            const result = await expectUnitNotAborted(() => run(engine));
            expectItemFailure(result.failures?.[0], { key: BAD, code: 'statement_timeout', fix: /extract.*--stale/ });
            expect(result.failures?.[0]?.held).toBe(false);
          }
          expect(await holds(engine)).toEqual([]);
          expect((await run(engine)).remaining).toBe(1);
        } finally { restore(); }
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);

    test('A-1 run: a run-scoped error at one page stops the unit and holds nothing', async () => {
      await managedBrain(async ({ engine }) => {
        for (const { name, error } of runScopedErrors()) {
          const restore = failDerive(engine, new Set([BAD]), error);
          try {
            let thrown: unknown;
            try { await run(engine); } catch (e) { thrown = e; }
            expect({ name, stopped: thrown !== undefined }).toEqual({ name, stopped: true });
            expect({ name, holds: await holds(engine) }).toEqual({ name, holds: [] });
          } finally { restore(); }
        }
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);

    test('A-1 breaker: most pages failing trips item_failures_systemic and holds nothing', async () => {
      await managedBrain(async ({ engine }) => {
        const restore = failDerive(engine, new Set(PAGES.slice(0, 6)), contentError);
        try {
          for (let i = 0; i < 3; i++) {
            let thrown: unknown;
            try { await run(engine); } catch (e) { thrown = e; }
            expect((thrown as { code?: string } | undefined)?.code).toBe('item_failures_systemic');
          }
          expect(await holds(engine)).toEqual([]);
        } finally { restore(); }
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);

    test('A-1 recovery: a held page is retried and lands after --retry-held, an edit or an extractor generation change', async () => {
      await managedBrain(async ({ engine }) => {
        const restore = failDerive(engine, new Set([BAD]), contentError);
        try { for (let i = 0; i < 3; i++) await run(engine); } finally { restore(); }
        expect((await holds(engine)).map(h => h.state)).toEqual(['held']);
        const versionTs = await effectiveLinkExtractorWatermark(engine);
        expect(await engine.countStalePagesForExtraction({ sourceId: 'default', versionTs, held: 'exclude' })).toBe(0);
        const bumped = new Date(Date.now() + 86_400_000).toISOString();
        expect(await engine.countStalePagesForExtraction({ sourceId: 'default', versionTs: bumped, held: 'exclude' })).toBe(PAGES.length + 1);

        const retried = await runManagedStaleExtraction(engine, { sourceId: 'default', retryHeld: true, counts: false });
        expect({ pages: retried.pages, failures: retried.failures ?? [] }).toEqual({ pages: 1, failures: [] });
        expect(await stamped(engine, BAD)).toBe(true);
        expect(await holds(engine)).toEqual([]);

        await edit(engine, `See [[${TARGET}]] again.`);
        const again = failDerive(engine, new Set([BAD]), contentError);
        try { for (let i = 0; i < 3; i++) await run(engine); } finally { again(); }
        expect((await holds(engine)).map(h => h.state)).toEqual(['held']);
        await edit(engine, `See [[${TARGET}]], edited.`);
        const edited = await run(engine);
        expect({ pages: edited.pages, failures: edited.failures ?? [] }).toEqual({ pages: 1, failures: [] });
        expect(await holds(engine)).toEqual([]);
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 180_000);

    test('A-1 cycle: the extract phase warns naming the failing page and its code', async () => {
      await managedBrain(async ({ engine }) => {
        const restore = failDerive(engine, new Set([BAD]), contentError);
        try {
          const phase = await expectUnitNotAborted(() => runPhaseExtractDatabaseOnly(engine, { dryRun: false, sourceId: 'default', timeBudgetMs: 60_000 }));
          expect(phase.status).toBe('warn');
          expect(phase.summary).toContain(BAD);
          expect(phase.summary).toContain('invalid_data');
          expect((phase.details as { stale_drain_failed?: unknown[] }).stale_drain_failed).toEqual([{ slug: BAD, source_id: 'default', code: 'invalid_data', held: false }]);
        } finally { restore(); }
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);

    test('A-1 #6808: pages of a deleted source fail as unknown_source while every other source derives', async () => {
      await managedBrain(async ({ engine }) => {
        const before = await snapshotItems(engine, 'default');
        const result = await expectUnitNotAborted(() => runAll(engine));
        expect(result.pages).toBe(PAGES.length + 1);
        expect((result.failures ?? []).map(f => ({ slug: f.slug, source_id: f.source_id, code: f.code }))).toEqual([
          { slug: 'notes/ghost-a', source_id: GHOST, code: 'unknown_source' }, { slug: 'notes/ghost-b', source_id: GHOST, code: 'unknown_source' }]);
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: PAGES, progressFields: ['links'] });
      }, { databaseUrl, setup: ({ engine }) => seedOrphans(engine, ['notes/ghost-a', 'notes/ghost-b']) });
    }, 120_000);

    test('A-1 breaker per source: a deleted source whose every page fails stops only that source', async () => {
      await managedBrain(async ({ engine }) => {
        const before = await snapshotItems(engine, 'default');
        const result = await expectUnitNotAborted(() => runAll(engine));
        expect(result.systemic?.map(s => ({ source_id: s.source_id, code: s.code, reason: s.reason }))).toEqual([{ source_id: GHOST, code: 'item_failures_systemic', reason: 'unknown_source' }]);
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { expectProgress: PAGES, progressFields: ['links'] });
        expect(await holds(engine)).toEqual([]);
      }, { databaseUrl, setup: ({ engine }) => seedOrphans(engine, Array.from({ length: 6 }, (_, i) => `notes/ghost-${i}`)) });
    }, 120_000);
  });
}
