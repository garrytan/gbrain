import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';

/** What the journal recorded while the history fixture was built. */
export interface AttributionHistory { pages: number; edits: number; deletes: number; restores: number; remembers: number; forgets: number }

async function run(ctx: OperationContext, operation: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await operationsByName[operation].handler(ctx, { request_id: randomUUID(), ...params }) as Record<string, unknown>;
}
const revisionOf = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ revision: string }>(
  'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]?.revision;

/**
 * A brain with real persistence history built through the journaled
 * operations (each write is a committed `persistence_requests` row): every
 * page is created, every third is edited (archiving a version), every seventh
 * is deleted and every fourteenth restored, every fifth gets a remembered
 * fact and every tenth fact is forgotten.
 */
export async function buildAttributionHistory(ctx: OperationContext, pages: number): Promise<AttributionHistory> {
  const sourceId = ctx.sourceId ?? 'default';
  const history: AttributionHistory = { pages: 0, edits: 0, deletes: 0, restores: 0, remembers: 0, forgets: 0 };
  const note = (i: number, body: string) => `---\ntype: person\ntitle: Example ${i}\n---\n${body}\n`;
  for (let i = 0; i < pages; i++) {
    const slug = `people/history-example-${i}`;
    await run(ctx, 'put_page', { slug, content: note(i, `Example person ${i} works on project ${i % 17}.`) });
    history.pages++;
    if (i % 3 === 0) {
      await run(ctx, 'put_page', { slug, content: note(i, `Example person ${i} moved to project ${(i + 1) % 17}.`),
        expected_revision: await revisionOf(ctx.engine, sourceId, slug) });
      history.edits++;
    }
    if (i % 5 === 0) {
      const remembered = await run(ctx, 'remember', { fact: `Example person ${i} prefers written updates on topic ${i}.`, provenance: 'history-fixture', entity: slug });
      history.remembers++;
      if (i % 10 === 0 && remembered.id !== undefined) {
        await run(ctx, 'forget', { id: remembered.id, reason: 'history-fixture correction' });
        history.forgets++;
      }
    }
    if (i % 7 === 0) {
      await run(ctx, 'delete_page', { slug, expected_revision: await revisionOf(ctx.engine, sourceId, slug) });
      history.deletes++;
      if (i % 14 === 0) {
        await run(ctx, 'restore_page', { slug, expected_revision: await revisionOf(ctx.engine, sourceId, slug) });
        history.restores++;
      }
    }
  }
  // A forget rewrites its page through an asynchronous withdrawal-mirror effect; the history is complete (and its
  // content stable for the callers' before/after reads) only once those effects have run.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [pending] = await ctx.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE source_id=$1 AND kind='withdrawal-mirror' AND state IN ('queued','running')`, [sourceId]);
    if (!pending?.n) break;
    if (Date.now() > deadline) throw new Error(`${pending.n} withdrawal-mirror effects still pending after 60 s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return history;
}
