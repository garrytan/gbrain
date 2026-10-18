/**
 * GBRA-130 A-51: managed conversation-facts publication sends a run's pages as one batch request. When the batch
 * failed with a deterministic code (`request_too_large`, `payload_too_large`, `permission_denied`), the failure was
 * booked against every member: each page's history held a deterministic failure, so the next run blocked all of
 * them "until they change", although one page caused it. Innocent batch-mates never got their facts.
 *
 * Now a deterministic failure of a batch of more than one page re-publishes it in halves within the run, so the
 * code lands only on the page that fails alone, and the next run blocks a page on a deterministic code only when
 * that failed batch held it alone (a shared failure counts as one ordinary attempt).
 * Seam: the persistence fault hook refuses, at preparation, any conversation batch that holds page X, which is
 * what a per-member deterministic refusal of the batch does. PGLite; Postgres when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ExtractedFact } from '../../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_INTENT } from '../../src/core/facts/conversation-publication.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { expectUnitNotAborted } from './harness.ts';

const X = 'meetings/2026-09-28-oversized';
const Y = 'meetings/2026-09-28-plan-sync';
const Z = 'meetings/2026-09-28-budget-sync';
const transcript = (title: string) => [
  '---', `title: ${title}`, 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.', '',
].join('\n');

afterEach(() => { installFaultHook(undefined); });

async function extract(engine: BrainEngine) {
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [X, Y, Z], sleepMs: 0, overrideDisabled: true,
    extractor: async () => [{ fact: 'Owner Example sends the quarterly plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null,
      source: 'test', notability: 'high' } as ExtractedFact] });
}
const factsOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source_id='default'
  AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL`, [slug])).length;
const batches = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; members: string[] }>(
  `SELECT state, error_code, (SELECT jsonb_agg(p->>'slug' ORDER BY p->>'slug') FROM jsonb_array_elements(intent->'pages') p) AS members
     FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence`, [CONVERSATION_FACTS_INTENT]);

/** Refuses, at preparation, every conversation batch that holds X with `error()`. */
function refuseBatchesHoldingX(engine: BrainEngine, error: () => Error) {
  installFaultHook(async (point, detail) => {
    if (point !== 'consumer:preparing' || detail.operation !== 'submit_job') return;
    const [row] = await engine.executeRaw<{ members: string[] | null }>(
      "SELECT (SELECT jsonb_agg(p->>'slug') FROM jsonb_array_elements(intent->'pages') p) AS members FROM persistence_requests WHERE id=$1::uuid AND intent->>'kind'=$2",
      [detail.writeId, CONVERSATION_FACTS_INTENT]);
    if (row?.members?.includes(X)) throw error();
  });
}

const seed = async ({ engine }: { engine: BrainEngine }) => {
  for (const [slug, title] of [[X, 'Oversized'], [Y, 'Plan sync'], [Z, 'Budget sync']] as const) {
    await engine.putPage(slug, { type: 'meeting', title, compiled_truth: transcript(title), timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`A-51 conversation facts batch with one deterministically refused page (${backend})`, () => {
    test('A-51 item: the batch is re-published in halves, the other pages commit, and only the page that fails alone is blocked', async () => {
      await managedBrain(async ({ engine }) => {
        refuseBatchesHoldingX(engine, () => new OperationError('payload_too_large', 'The batch holds a page over the request limit.'));
        await expectUnitNotAborted(() => extract(engine));
        const second = await expectUnitNotAborted(() => extract(engine));
        expect({ x: await factsOf(engine, X), y: await factsOf(engine, Y), z: await factsOf(engine, Z) }).toEqual({ x: 0, y: 1, z: 1 });
        expect(second.pages_blocked).toBe(1);
        const failedAlone = (await batches(engine)).filter(b => b.state !== 'committed' && b.members.length === 1).map(b => b.members[0]);
        expect([...new Set(failedAlone)]).toEqual([X]);
      }, { databaseUrl, setup: seed });
    }, 180_000);

    test('A-51 run: a run-scoped failure of the batch is not split and blocks no page', async () => {
      await managedBrain(async ({ engine }) => {
        refuseBatchesHoldingX(engine, () => new OperationError('owner_unavailable', 'The canonical writer for this source is unavailable.'));
        const first = await extract(engine).catch((error: Error) => error);
        expect((await batches(engine)).map(b => b.members.length)).toEqual([3]);
        expect(first instanceof Error ? 0 : first.pages_blocked ?? 0).toBe(0);
        installFaultHook(undefined);
        await expectUnitNotAborted(() => extract(engine));
        expect({ x: await factsOf(engine, X), y: await factsOf(engine, Y), z: await factsOf(engine, Z) }).toEqual({ x: 1, y: 1, z: 1 });
      }, { databaseUrl, setup: seed });
    }, 180_000);
  });
}
