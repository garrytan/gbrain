/**
 * P8 memory writes on Postgres: withdrawal review queueing commits with the
 * withdrawal, the review lane proposes and an accept withdraws exactly once
 * under concurrency, and `remember.replaces` holds the target row lock so two
 * concurrent replacements (or a replacement racing a forget) leave one
 * consistent outcome. Zero model calls: fixture embed and decide transports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { listReviewProposals, runReviewLane } from '../../src/core/ai/decide/review-lane.ts';
import { acceptReviewProposal, rejectReviewProposal } from '../../src/core/facts/proposal-review.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const SLUG = 'people/alice-example';
const DIM = LEGACY_EMBEDDING_CONFIG.embedding_dimensions;
let engine: PostgresEngine;

function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const g = /\[g(\d+)\]/.exec(text);
  const m = /\[v(\d+)\]/.exec(text);
  if (!g) { v[1000 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 400)] = 1; return v; }
  v[Number(g[1]) * 20] = 1;
  if (m) v[Number(g[1]) * 20 + 1 + Number(m[1])] = 0.4;
  return v;
}

function gateway() {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(embed) })) as never);
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const same = String(q.instructions.candidate).includes('[same]');
      const probabilities = same ? { duplicate: 0.97, supersede: 0.02, independent: 0.01 } : { duplicate: 0.05, supersede: 0.1, independent: 0.85 };
      const choice = same ? 'duplicate' : 'independent';
      return [id, { type: 'choice', choice, confidence: probabilities[choice], probabilities }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 5 } }));
  });
}

async function remember(fact: string): Promise<number> {
  const r = await writeSingleFact(engine, 'default', { fact, provenance: 'test', entity: SLUG, kind: 'fact', visibility: 'world' });
  expect(r.status).toBe('inserted');
  return r.id;
}
async function forget(id: number): Promise<Record<string, any>> {
  return await operationsByName.forget!.handler({ engine, config: { engine: 'postgres' }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info: () => {}, warn: () => {}, error: () => {} } } as never, { id: String(id) }) as Record<string, any>;
}
async function replace(fact: string, target: number) {
  const res = await dispatchToolCall(engine, 'remember', { fact, provenance: 'test', entity: SLUG, replaces: String(target) }, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
async function factRow(id: number) {
  const [r] = await engine.executeRaw<{ expired: boolean; superseded_by: number | null }>(
    'SELECT expired_at IS NOT NULL AS expired, superseded_by::int AS superseded_by FROM facts WHERE id = $1', [id]);
  return r!;
}

beforeAll(async () => {
  if (!RUN) return;
  engine = await setupLegacyEmbeddingDB();
});
afterAll(async () => {
  if (!RUN) return;
  __setDecideTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await disposePersistenceConsumer(engine);
  await teardownDB();
});
beforeEach(async () => {
  if (!RUN) return;
  __resetDecideStoreForTests();
  gateway();
  await engine.executeRaw('DELETE FROM decide_review_proposals');
  await engine.executeRaw('DELETE FROM decide_review_queue');
  await engine.executeRaw('DELETE FROM decide_calibrations');
  await engine.executeRaw("DELETE FROM facts WHERE entity_slug = $1", [SLUG]);
  await importFromContent(engine, SLUG, '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n', { noEmbed: true, sourceId: 'default' });
  for (const [k, v] of Object.entries({
    'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'on',
    'decide.egress.typesafe.facts': 'allow', 'decide.slots.conflict.review_withdraw': 'true',
  })) await engine.setConfig(k, v);
});

d('P8 withdrawal review on Postgres', () => {
  test('the queue row commits with the withdrawal; concurrent accepts and a reject record one outcome', async () => {
    const anchor = await remember('[g5] Alice Example works at acme-example.');
    const restated = await remember('[g5][v1] Alice Example is employed by acme-example. [same]');
    const res = await forget(anchor);
    expect(res.similar_active.candidates.map((c: any) => c.fact_id)).toEqual([String(restated)]);
    expect(await engine.executeRaw('SELECT kind, a_ref FROM decide_review_queue')).toEqual([{ kind: 'withdraw', a_ref: String(anchor) }]);

    const id = await insertCalibration(engine, {
      slot: 'conflict', call_site: 'review_withdraw', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.9, min_keep: null,
      metric: 'precision', metric_value: 0.97, ece: 0.03, retest_sd: 0.01, repack_sd: 0.01, n: 200, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: false, pack_shape: packShape('conflict'), notes: null,
    });
    await engine.executeRaw('UPDATE decide_calibrations SET action_precision_lb = 0.95 WHERE id = $1', [id]);
    const lane = await runReviewLane(engine, { kind: 'withdraw' });
    expect(lane).toMatchObject({ effective: 'on', proposals: 1 });
    const [proposal] = await listReviewProposals(engine);
    expect(proposal!.b_ref).toBe(String(restated));

    const results = await Promise.all([acceptReviewProposal(engine, proposal!.id), acceptReviewProposal(engine, proposal!.id), rejectReviewProposal(engine, proposal!.id)]);
    const winners = results.filter(r => r.status === 'accepted' || r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect((await factRow(restated)).expired).toBe(winners[0]!.status === 'accepted');
    expect(await engine.executeRaw('SELECT kind FROM decide_review_queue')).toEqual([]);
  });
});

d('P8 remember.replaces on Postgres', () => {
  test('two concurrent replacements of one fact: one supersedes, the other is refused naming the chain head', async () => {
    const old = await remember('Alice Example lives in Lisbon.');
    const [a, b] = await Promise.all([replace('Alice Example lives in Porto.', old), replace('Alice Example lives in Madrid.', old)]);
    const won = [a, b].filter(r => !r.isError);
    const lost = [a, b].filter(r => r.isError);
    expect(won).toHaveLength(1);
    expect(won[0]!.body.status).toBe('superseded');
    expect(lost).toHaveLength(1);
    expect(JSON.stringify(lost[0]!.body)).toContain('target_superseded');
    expect(await factRow(old)).toEqual({ expired: true, superseded_by: Number(won[0]!.body.id) });
    const active = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE entity_slug = $1 AND expired_at IS NULL', [SLUG]);
    expect(active[0]!.n).toBe(1);
  });

  test('a replacement racing a forget leaves one consistent outcome', async () => {
    const old = await remember('Alice Example plays chess.');
    const [rep] = await Promise.all([replace('Alice Example plays go.', old), forget(old)]);
    const row = await factRow(old);
    expect(row.expired).toBe(true);
    if (rep.isError) {
      expect(JSON.stringify(rep.body)).toContain('target_withdrawn');
      expect(row.superseded_by).toBeNull();
    } else {
      expect(rep.body.status).toBe('superseded');
      expect(row.superseded_by).toBe(Number(rep.body.id));
    }
  });
});
