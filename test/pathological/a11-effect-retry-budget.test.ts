/**
 * GBRA-130 A-11: a `links` or `facts-backstop` effect that failed the same way
 * every time (an oversized segmented block, a 57014 on a page with thousands of
 * mention targets, a queue refusal) was retried every 30 s forever: only Git and
 * withdrawal-mirror effects counted toward PARK_AFTER_FAILURES. The queued effect
 * wedged `writer deactivate` and shared-skills activation, and retry-effects did
 * not cover these kinds.
 *
 * Authoring gate: (1) protects "a derived effect that keeps failing reaches a
 * terminal state with its code": after five counted failures a links effect
 * completes as skipped (the edge is derived; `gbrain extract --stale` recovers it)
 * and a facts-backstop effect fails with the code, deactivate no longer lists them,
 * retry-effects re-authorizes the failed one, a run-scoped failure is never counted,
 * and a pass where most effects fail counts nothing. (2) Reverting the count in
 * effects.ts recordFailure leaves the effect queued and every item case goes red.
 * (3) No existing test fails a links or facts-backstop effect repeatedly.
 * (4) The failure is injected by wrapping the engine's transaction (no production seam).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { listBlockingEffects } from '../../src/core/persistence/blocking-effects.ts';
import { deactivatePersistence } from '../../src/core/persistence/deactivation.ts';
import { retryRequestEffects } from '../../src/core/persistence/effect-retry.ts';
import { PARK_AFTER_FAILURES } from '../../src/core/persistence/effect-model.ts';
import { failLocks, passes } from './effects-fixture.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const TARGET = 'notes/target-example';
const PAGES = Array.from({ length: 6 }, (_, i) => `notes/p-${i + 1}`);
const BAD = 'notes/p-3';
const healthy = PAGES.filter(slug => slug !== BAD);
const segmented = () => new OperationError('page_body_segmented', 'A block of this page exceeds the segmented block limit.');
const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n` } });

/** Every page mentions the target; each page's request gets a links effect, BAD's also a facts-backstop effect (the shapes a remote put_page queues). */
async function seed(engine: BrainEngine, ctx: OperationContext, slugs = PAGES, facts = [BAD]) {
  await put(ctx, TARGET, 'The target.');
  for (const slug of slugs) await put(ctx, slug, `See [[${TARGET}]].`);
  await disposePersistenceConsumer(engine);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
      SELECT e.request_id,k.kind,e.revision,e.data,e.source_id,e.source_incarnation,e.worktree_id FROM persistence_effects e
      JOIN persistence_requests r ON r.id=e.request_id CROSS JOIN (VALUES ('links'),('facts-backstop')) AS k(kind)
      WHERE e.kind='embedding' AND r.slug=ANY($1::text[]) AND (k.kind='links' OR r.slug=ANY($2::text[]))`, [slugs, facts]);
  });
}

type Row = { slug: string; request_id: string; kind: string; state: string; error_code: string | null; outcome: Record<string, unknown> | null; failures: number | null };
async function derived(engine: BrainEngine): Promise<Row[]> {
  return engine.executeRaw<Row>(`SELECT r.slug,r.request_id::text AS request_id,e.kind,e.state,e.error_code,e.outcome,(e.data->>'target_failures')::int AS failures
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind IN ('links','facts-backstop') ORDER BY r.slug,e.kind`);
}
const of = (rows: Row[], slug: string, kind: string) => rows.find(row => row.slug === slug && row.kind === kind)!;

async function effectBlockers(engine: BrainEngine) {
  return (await deactivatePersistence(engine, { dryRun: true })).blockers.filter(blocker => blocker.kind === 'effect');
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-11 links and facts-backstop effects have a retry budget (${backend})`, () => {
    test('A-11 item: a links and a facts-backstop effect failing every attempt reach terminal states with the code; the siblings link', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seed(engine, ctx);
        const before = await snapshotItems(engine, 'default');
        const restore = failLocks(engine, new Set([BAD]), segmented);
        try {
          await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES - 1));
          const counting = await derived(engine);
          expect({ state: of(counting, BAD, 'links').state, failures: of(counting, BAD, 'links').failures }).toEqual({ state: 'queued', failures: PARK_AFTER_FAILURES - 1 });
          await expectUnitNotAborted(() => passes(engine, ctx.config, 1));
        } finally { restore(); }
        const rows = await derived(engine);
        const links = of(rows, BAD, 'links');
        expect({ state: links.state, outcome: links.outcome }).toEqual({ state: 'committed', outcome: { links: 'skipped', reason: 'page_body_segmented' } });
        const facts = of(rows, BAD, 'facts-backstop');
        expectItemFailure({ key: facts.slug, code: facts.error_code ?? undefined }, { key: BAD, code: 'page_body_segmented' });
        expect(facts.state).toBe('failed');
        for (const slug of healthy) expect({ slug, ...pick(of(rows, slug, 'links')) }).toEqual({ slug, state: 'committed', links: 'committed' });
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: [BAD], expectProgress: healthy, progressFields: ['links'] });
        expect(await listBlockingEffects(engine)).toEqual([]);
        expect(await effectBlockers(engine)).toEqual([]);

        // Recovery: the cause clears and retry-effects authorizes one more attempt for the failed facts-backstop effect.
        const preview = await retryRequestEffects(engine, 'default', facts.request_id, true, ctx.config);
        expect((preview.effects as Array<{ kind: string; action: string }>).filter(e => e.kind === 'facts-backstop')).toEqual([expect.objectContaining({ action: 'would_retry' })]);
        expect(of(await derived(engine), BAD, 'facts-backstop').state).toBe('failed');
        await retryRequestEffects(engine, 'default', facts.request_id, false, ctx.config);
        await passes(engine, ctx.config, 1);
        expect(of(await derived(engine), BAD, 'facts-backstop')).toMatchObject({ state: 'committed', error_code: null });
      }, { databaseUrl });
    }, 180_000);

    test('A-11 item: a statement timeout on every attempt is bounded too', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seed(engine, ctx, PAGES.slice(0, 2), []);
        const restore = failLocks(engine, new Set([PAGES[0]]), timeout);
        try { await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES + 1)); } finally { restore(); }
        const rows = await derived(engine);
        expect(pick(of(rows, PAGES[0], 'links'))).toEqual({ state: 'committed', links: 'skipped', reason: 'statement_timeout' });
        expect(pick(of(rows, PAGES[1], 'links'))).toEqual({ state: 'committed', links: 'committed' });
        expect(await effectBlockers(engine)).toEqual([]);
      }, { databaseUrl });
    }, 180_000);

    for (const injected of runScopedErrors()) {
      test(`A-11 run: a run-scoped failure (${injected.name}) is never counted and the effect stays queued`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          await seed(engine, ctx, PAGES.slice(0, 1));
          const restore = failLocks(engine, new Set([PAGES[0]]), injected.error);
          try { await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES + 2)); } finally { restore(); }
          for (const row of await derived(engine)) expect({ kind: row.kind, state: row.state, failures: row.failures }).toEqual({ kind: row.kind, state: 'queued', failures: null });
        }, { databaseUrl });
      }, 180_000);
    }

    test('A-11 breaker: a pass where every links effect fails counts none of them', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seed(engine, ctx, PAGES, []);
        const restore = failLocks(engine, new Set(PAGES), segmented);
        try { await expectUnitNotAborted(() => passes(engine, ctx.config, PARK_AFTER_FAILURES + 1)); } finally { restore(); }
        for (const row of await derived(engine)) {
          expect({ slug: row.slug, state: row.state, error_code: row.error_code, failures: row.failures })
            .toEqual({ slug: row.slug, state: 'queued', error_code: 'item_failures_systemic', failures: null });
        }
      }, { databaseUrl });
    }, 180_000);
  });
}

function pick(row: Row) {
  const outcome = row.outcome ?? {};
  return { state: row.state, links: outcome.links, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}
