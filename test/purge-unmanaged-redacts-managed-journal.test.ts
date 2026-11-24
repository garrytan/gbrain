import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';

const SLUG = 'notes/journal-example';
const CANARY = 'canaryjournalbody';

async function put(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\ntitle: ${slug}\ntype: note\n---\n${body}` } });
}
async function deletePage(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
}
async function unmanagedWhile<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await disposePersistenceConsumer(engine);
  }
}

async function journalCopies(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE intent::text LIKE '%' || $1 || '%' OR coalesce(outcome::text, '') LIKE '%' || $1 || '%'", [CANARY]);
  return row!.n;
}

async function writtenWhileManaged(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await put(engine, ctx, SLUG, `A note whose body says ${CANARY}.`);
  await put(engine, ctx, SLUG, `An edit that still says ${CANARY}.`);
  for (const date of ['2026-02-03', '2026-02-04']) {
    await submitPageMutation(ctx, { operation: 'add_timeline_entry', params: { slug: SLUG, date, summary: `Met about ${CANARY} on ${date}`, request_id: randomUUID() } });
  }
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'edit_page', params: { slug: SLUG, expected_revision: snapshot!.revision, request_id: randomUUID(), edits: [{ old_text: 'still says', new_text: 'now says' }] } });
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_requests SET intent=NULL, compacted=true WHERE (operation='add_timeline_entry' AND outcome->'entry'->>'summary' LIKE '%2026-02-04') OR operation='edit_page'");
  });
  await deletePage(engine, ctx, SLUG);
  expect(await journalCopies(engine)).toBeGreaterThan(0);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`an unmanaged purge redacts the journal rows a managed brain wrote for the page (${backend})`, () => {
    test('the automatic retention purge, run while the brain is unmanaged, leaves no copy of the body in persistence_requests', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await writtenWhileManaged(engine, ctx);
        await unmanagedWhile(engine, async () => { await engine.executeRaw("UPDATE pages SET deleted_at = deleted_at - interval '100 hours' WHERE source_id = 'default' AND slug = $1", [SLUG]); });
        const purged = await unmanagedWhile(engine, async () => (await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs);
        expect(purged).toEqual([SLUG]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug = $1', [SLUG])).toHaveLength(0);
        expect(await journalCopies(engine)).toBe(0);
      }, { databaseUrl });
    }, 300_000);

    test('the automatic purge of a source the belief ledger covers (its per-page expiry), run while the brain is unmanaged, leaves no copy of the body in persistence_requests', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await writtenWhileManaged(engine, ctx);
        await unmanagedWhile(engine, async () => {
          await enableBeliefLedger(engine, 'default');
          await engine.executeRaw("UPDATE pages SET deleted_at = deleted_at - interval '100 hours' WHERE source_id = 'default' AND slug = $1", [SLUG]);
        });
        const purged = await unmanagedWhile(engine, async () => (await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs);
        expect(purged).toEqual([SLUG]);
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug = $1', [SLUG])).toHaveLength(0);
        expect(await journalCopies(engine)).toBe(0);
      }, { databaseUrl });
    }, 300_000);

    test('an explicit purge, run while the brain is unmanaged, leaves no copy of the body in persistence_requests', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await writtenWhileManaged(engine, ctx);
        await unmanagedWhile(engine, async () => {
          const tombstone = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
          await submitPageMutation({ ...ctx, remote: false }, { operation: 'delete_page', params: { slug: SLUG, purge: true, expected_revision: tombstone!.revision, request_id: randomUUID() } });
        });
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug = $1', [SLUG])).toHaveLength(0);
        expect(await journalCopies(engine)).toBe(0);
      }, { databaseUrl });
    }, 300_000);
  });
}
