/**
 * Semantic withdrawal review (the `withdraw` kind of the ambiguous-band review
 * lane) on PGLite with a fixture decide transport; no provider is called.
 *
 * Protects: a withdrawal queues review work in its own transaction only when
 * the kind is on and the caller did not opt out; forget returns zero-model
 * `similar_active` ids; the lane never calls the provider without a calibration
 * qualified for action precision (an operator threshold override is not a
 * qualification); with one, a restatement becomes a pending proposal and an
 * independent neighbour does not; shadow mode writes receipts only; a forgotten
 * private claim is not sent unless private egress is explicitly allowed;
 * accepting withdraws the candidate through `forget` (ledger row, expiry) and
 * queues no further review; a changed candidate goes stale; undo refuses with
 * a fix; a later paraphrase re-queues the withdrawn anchor through the sweep.
 * Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { runReviewLane, listReviewProposals } from '../../src/core/ai/decide/review-lane.ts';
import { runConflictSweep } from '../../src/core/ai/decide/sweep.ts';
import { setSweepWatermark } from '../../src/core/ai/decide/proposals-store.ts';
import { acceptReviewProposal, rejectReviewProposal, undoReviewProposal } from '../../src/core/facts/proposal-review.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

let engine: PGLiteEngine;
let brainDir: string;
const SLUG = 'people/alice-example';
const OTHER = 'people/bob-example';
const DIM = 1536;

/** `[gN]` picks a direction, `[vM]` a small offset: two variants of one group have cosine ~0.86. */
function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const g = /\[g(\d+)\]/.exec(text);
  const m = /\[v(\d+)\]/.exec(text);
  if (!g) { v[1000 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 400)] = 1; return v; }
  v[Number(g[1]) * 20] = 1;
  if (m) v[Number(g[1]) * 20 + 1 + Number(m[1])] = 0.4;
  return v;
}

type Probs = { duplicate: number; supersede: number; independent: number };
let bodies: any[] = [];
function transport(judge: (fact: string, candidate: string) => Probs, model = 'jev-1.13.0') {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const probabilities = judge(body.state.fact, q.instructions.candidate);
      const choice = (Object.entries(probabilities) as Array<[string, number]>).sort((a, b) => b[1] - a[1])[0]![0];
      return [id, { type: 'choice', choice, confidence: probabilities[choice as keyof Probs], probabilities }];
    }));
    return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 50, output_tokens: 5 } }));
  });
}
/** Restatements carry `[same]` in their text in these fixtures. */
const judgeSame = (_fact: string, candidate: string): Probs => candidate.includes('[same]') ? { duplicate: 0.97, supersede: 0.02, independent: 0.01 } : { duplicate: 0.05, supersede: 0.1, independent: 0.85 };

const BASE = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'on',
  'decide.egress.typesafe.facts': 'allow', 'decide.egress.private': 'allow', 'decide.slots.conflict.review_withdraw': 'true',
};
async function setConfig(kv: Record<string, string>) { for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v); }

async function qualify(lb = 0.95) {
  const id = await insertCalibration(engine, {
    slot: 'conflict', call_site: 'review_withdraw', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.9, min_keep: null,
    metric: 'precision', metric_value: 0.97, ece: 0.03, retest_sd: 0.01, repack_sd: 0.01, n: 200, dataset_hash: 'd', split_hash: 's',
    calibrate_ids_hash: 'c', calibrate_only: false, pack_shape: packShape('conflict'), notes: null,
  });
  await engine.executeRaw('UPDATE decide_calibrations SET action_precision_lb = $2 WHERE id = $1', [id, lb]);
}

async function remember(fact: string, entity: string | null = SLUG, visibility: 'world' | 'private' = 'world'): Promise<number> {
  const r = await writeSingleFact(engine, 'default', { fact, provenance: 'test', entity, kind: 'fact', visibility });
  expect(r.status).toBe('inserted');
  return r.id;
}

async function forget(id: number, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return await operationsByName.forget!.handler({ engine, config: { engine: 'pglite' }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info: () => {}, warn: () => {}, error: () => {} } } as never, { id: String(id), ...extra }) as Record<string, any>;
}

async function queue() {
  return engine.executeRaw<{ kind: string; a_ref: string }>('SELECT kind, a_ref FROM decide_review_queue ORDER BY a_ref');
}
async function isActive(id: number): Promise<boolean> {
  const [r] = await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id = $1', [id]);
  return r!.active;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  bodies = [];
  brainDir = mkdtempSync(join(tmpdir(), 'review-brain-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(embed) })) as never);
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  for (const [slug, title] of [[SLUG, 'Alice Example'], [OTHER, 'Bob Example']] as const) {
    const content = `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nA person.\n`;
    writeFileSync(join(brainDir, `${slug}.md`), content);
    await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
  }
});

afterEach(async () => {
  __setDecideTransportForTests(null);
  await disposePersistenceConsumer(engine);
  rmSync(brainDir, { recursive: true, force: true });
});

describe('queueing and the forget response', () => {
  test('a withdrawal queues review unless the kind is turned off or the caller opted out (on by default)', async () => {
    await setConfig({ 'decide.slots.conflict.review_withdraw': 'false' });
    const a = await remember('[g1] Alice Example prefers tea.');
    await forget(a);
    expect(await queue()).toEqual([]);
    await setConfig(BASE);
    await engine.unsetConfig('decide.slots.conflict.review_withdraw');
    const b = await remember('[g2] Alice Example lives in Lisbon.');
    await forget(b);
    const c = await remember('[g3] Alice Example dislikes flying.');
    await forget(c, { semantic_review: false });
    expect(await queue()).toEqual([{ kind: 'withdraw', a_ref: String(b) }]);
  });

  test('forget returns similar active facts as ids and scores only, with what happens next', async () => {
    await setConfig(BASE);
    const anchor = await remember('[g4] Alice Example invested in acme-example.');
    const close = await remember('[g4][v1] Alice Example put money into acme-example.');
    await remember('[g9] Alice Example runs marathons.');
    const twin = await remember('[g4][v2] Bob Example invested in acme-example.', OTHER);
    const res = await forget(anchor);
    expect(res.similar_active.state).toBe('checked');
    expect(res.similar_active.candidates.map((c: any) => c.fact_id)).toEqual([String(close)]);
    expect(res.similar_active.candidates.map((c: any) => c.fact_id)).not.toContain(String(twin));
    expect(JSON.stringify(res.similar_active)).not.toContain('acme-example.');
    expect(res.similar_active.next).toContain('forget one only if the user confirms');
    expect(res.similar_active.semantic_review).toBe('scheduled');
  });
});

describe('the review lane', () => {
  test('without a qualified calibration the provider is never called (an operator threshold is not a qualification)', async () => {
    await setConfig({ ...BASE, 'decide.slots.conflict.threshold': '0.8' });
    transport(judgeSame);
    const anchor = await remember('[g5] Alice Example works at acme-example.');
    await remember('[g5][v1] Alice Example is employed by acme-example. [same]');
    await forget(anchor);
    const r = await runReviewLane(engine, { kind: 'withdraw' });
    expect(r).toMatchObject({ effective: 'off', inactive: 'no_qualification', proposals: 0 });
    expect(bodies).toHaveLength(0);
  });

  test('a restatement becomes a pending proposal; an independent neighbour does not', async () => {
    await setConfig(BASE);
    await qualify();
    transport(judgeSame);
    const anchor = await remember('[g6] Alice Example works at acme-example.');
    const same = await remember('[g6][v1] Alice Example is employed by acme-example. [same]');
    await remember('[g6][v2] Alice Example visited acme-example last spring.');
    await forget(anchor);
    const r = await runReviewLane(engine, { kind: 'withdraw' });
    expect(r).toMatchObject({ effective: 'on', anchors: 1, pairs: 2, proposals: 1, independents: 1 });
    const [p] = await listReviewProposals(engine);
    expect(p).toMatchObject({ kind: 'withdraw', a_ref: String(anchor), b_ref: String(same), status: 'pending', subject: SLUG });
    expect(await queue()).toEqual([]);
    await flushDecideWrites();
    const receipts = await engine.executeRaw<{ outcome: string; call_site: string }>(`SELECT outcome, call_site FROM decision_receipts WHERE slot = 'conflict'`);
    expect(receipts.every(x => x.call_site === 'review_withdraw')).toBe(true);
    // Judged pairs are not judged again.
    await engine.executeRaw(`INSERT INTO decide_review_queue(kind,source_id,a_ref) VALUES ('withdraw','default',$1)`, [String(anchor)]);
    bodies = [];
    await runReviewLane(engine, { kind: 'withdraw' });
    expect(bodies).toHaveLength(0);
  });

  test('shadow mode judges and writes receipts but no proposals', async () => {
    await setConfig({ ...BASE, 'decide.slots.conflict.mode': 'shadow' });
    transport(judgeSame);
    const anchor = await remember('[g7] Alice Example owns a red bicycle.');
    await remember('[g7][v1] Alice Example has a red bike. [same]');
    await forget(anchor);
    const r = await runReviewLane(engine, { kind: 'withdraw' });
    expect(r).toMatchObject({ effective: 'shadow', proposals: 0, shadow_proposals: 1 });
    expect(await listReviewProposals(engine)).toEqual([]);
  });

  test('a forgotten private claim is not sent unless private egress is explicitly allowed', async () => {
    await setConfig({ ...BASE, 'decide.egress.private': 'deny' });
    await qualify();
    transport(judgeSame);
    const anchor = await remember('[g8] Alice Example takes a daily medication.', SLUG, 'private');
    await remember('[g8][v1] Alice Example is on daily medication. [same]', SLUG, 'private');
    await forget(anchor);
    const r = await runReviewLane(engine, { kind: 'withdraw' });
    expect(r).toMatchObject({ skipped: 1, proposals: 0 });
    expect(bodies).toHaveLength(0);
  });
});

describe('owner actions', () => {
  async function proposal(): Promise<{ id: number; anchor: number; same: number }> {
    await setConfig(BASE);
    await qualify();
    transport(judgeSame);
    const anchor = await remember('[g10] Alice Example founded widget-example.');
    const same = await remember('[g10][v1] Alice Example started widget-example. [same]');
    await forget(anchor);
    await runReviewLane(engine, { kind: 'withdraw' });
    const [p] = await listReviewProposals(engine);
    return { id: p!.id, anchor, same };
  }

  test('accept withdraws the candidate through forget and queues no further review', async () => {
    const { id, same } = await proposal();
    const r = await acceptReviewProposal(engine, id);
    expect(r.status).toBe('accepted');
    expect(await isActive(same)).toBe(false);
    const ledger = await engine.executeRaw('SELECT 1 FROM fact_withdrawals');
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(await queue()).toEqual([]);
    expect((await acceptReviewProposal(engine, id)).status).toBe('refused');
  });

  test('a changed candidate goes stale; reject and undo behave', async () => {
    const { id, same } = await proposal();
    await engine.executeRaw(`UPDATE facts SET fact = fact || ' (edited)' WHERE id = $1`, [same]);
    expect((await acceptReviewProposal(engine, id)).status).toBe('stale');
    expect(await isActive(same)).toBe(true);
    const undo = await undoReviewProposal(engine, id);
    expect(undo).toMatchObject({ status: 'refused', reason: 'withdrawal_is_durable' });
    expect(undo.fix).toContain('remember a corrected wording');
    expect((await rejectReviewProposal(engine, id)).status).toBe('refused');
  });
});

describe('a later paraphrase', () => {
  test('re-queues the withdrawn claim through the conflict sweep', async () => {
    await setConfig(BASE);
    transport(() => ({ duplicate: 0.1, supersede: 0.1, independent: 0.8 }));
    const anchor = await remember('[g11] Alice Example speaks Portuguese.');
    await forget(anchor);
    await engine.executeRaw('DELETE FROM decide_review_queue');
    await setSweepWatermark(engine, 'default', anchor);
    await remember('[g11][v1] Alice Example is fluent in Portuguese.');
    await runConflictSweep(engine, { now: () => Date.now() + 120_000 });
    expect(await queue()).toEqual([{ kind: 'withdraw', a_ref: String(anchor) }]);
  });
});
