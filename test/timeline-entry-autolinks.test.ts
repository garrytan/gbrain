/**
 * G5 lane B (door): an `add_timeline_entry` publication derives the page's markdown links, as put_page and edit_page do,
 * so a bullet whose summary links an existing page creates that edge when it publishes, not at the next re-import.
 * A remote caller's entry still derives nothing inline and queues no mention `links` effect (REMOTE_MENTION_OPERATIONS is
 * unchanged). Runs on PGLite, and on Postgres through test/e2e/timeline-entry-autolinks-postgres.test.ts. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const TARGET = 'projects/acme-example';
const PAGE = 'people/alice-example';
const SUMMARY = `Kicked off [${TARGET}](${TARGET}) with the team`;

async function seed(ctx: OperationContext) {
  await op('put_page').handler(ctx, { slug: TARGET, content: '---\ntype: project\ntitle: Acme Example\n---\n\nA project.\n' });
  await op('put_page').handler(ctx, { slug: PAGE, content: '---\ntype: person\ntitle: Alice Example\n---\n\nA person.\n' });
}
const edges = async (engine: BrainEngine) => engine.executeRaw<{ link_type: string; link_source: string | null }>(
  `SELECT l.link_type, l.link_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id='default' AND f.slug=$1 AND t.slug=$2 ORDER BY l.id`, [PAGE, TARGET]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`add_timeline_entry derives its page's markdown links at publication (G5 lane B, ${backend})`, () => {
    test('a local entry whose summary links an existing page creates that edge when it publishes', () => managedBrain(async ({ engine, ctx }) => {
      await seed(ctx);
      expect(await edges(engine)).toEqual([]);
      await op('add_timeline_entry').handler(ctx, { slug: PAGE, date: '2026-10-01', summary: SUMMARY, source: 'meetings/source-a' });
      expect((await engine.getPage(PAGE, { sourceId: 'default' }))!.timeline).toContain(SUMMARY);
      expect(await edges(engine)).toEqual([{ link_type: 'mentions', link_source: 'markdown' }]);
    }, { databaseUrl }), 120_000);

    test('a remote entry derives no edge inline and queues no mention links effect', () => managedBrain(async ({ engine, ctx }) => {
      await seed(ctx);
      await op('add_timeline_entry').handler({ ...ctx, remote: true } as OperationContext, { slug: PAGE, date: '2026-10-01', summary: SUMMARY, source: 'meetings/source-a' });
      expect((await engine.getPage(PAGE, { sourceId: 'default' }))!.timeline).toContain(SUMMARY);
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 50 });
      expect(await engine.executeRaw(`SELECT 1 FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
        WHERE r.operation='add_timeline_entry' AND e.kind='links'`)).toEqual([]);
      expect(await edges(engine)).toEqual([]);
    }, { databaseUrl }), 120_000);
  });
}
