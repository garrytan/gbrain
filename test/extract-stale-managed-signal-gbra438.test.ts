/**
 * GBRA-438 PR 2: the managed stale link drain stops on its caller's abort signal.
 *
 * 1. Protects: runManagedStaleExtraction hands its `signal` to
 *    extractManagedStaleLinks, so an idle upkeep slice on a managed brain (the
 *    default PGLite install) stops between pages when a request or its budget
 *    aborts it, instead of draining every stale page first.
 * 2. Fails when: the signal is dropped on the way in and an aborted run keeps
 *    deriving pages until nothing is stale.
 * 3. Real seams: a real managed brain (coordinated writes, persistence
 *    protocol) on PGLite and Postgres; the abort fires after the first page's
 *    coordinated transaction commits.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_LINK_EXTRACTION_WIDTH, runManagedStaleExtraction } from '../src/core/persistence/links-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const PAGES = 40;
const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n` } });
const derivedPages = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ n: number }>('SELECT count(DISTINCT from_page_id)::int AS n FROM links'))[0]!.n;

for (const kind of testBackends()) {
  describe(`managed stale link drain (${kind})`, () => {
    test('an aborted signal passed to runManagedStaleExtraction stops extractManagedStaleLinks between pages', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await engine.setConfig('auto_link', 'false');
        for (let i = 0; i < PAGES; i++) await put(ctx, `notes/n${i}`, `Links [[notes/n${(i + 1) % PAGES}]].`);
        await disposePersistenceConsumer(engine);
        expect(await derivedPages(engine)).toBe(0);
        const controller = new AbortController();
        const transaction = engine.transaction;
        engine.transaction = (async function (this: BrainEngine, fn: Parameters<BrainEngine['transaction']>[0], o?: Parameters<BrainEngine['transaction']>[1]) {
          try { return await transaction.call(this, fn, o); } finally { if (this === engine) controller.abort(); }
        }) as BrainEngine['transaction'];
        let thrown: unknown = null;
        try {
          await runManagedStaleExtraction(engine, { sourceId: 'default', counts: false, signal: controller.signal });
        } catch (error) {
          thrown = error;
        } finally {
          engine.transaction = transaction;
        }
        const derived = await derivedPages(engine);
        expect(derived).toBeLessThan(PAGES);
        expect(derived).toBeGreaterThan(0);
        expect(derived).toBeLessThanOrEqual(engine.kind === 'postgres' ? MANAGED_LINK_EXTRACTION_WIDTH : 1);
        expect((thrown as { name?: string } | null)?.name).toBe('AbortError');
      }, { databaseUrl: kind === 'postgres' ? process.env.DATABASE_URL : undefined });
    }, 120_000);
  });
}
