/**
 * The duplicate kinds of the ambiguous-band review lane: other subsystems
 * enqueue candidate page pairs; the lane judges them (once per pair) and writes
 * pending proposals; accepting runs the owning subsystem's registered handler,
 * or records the owner's verdict as accepted_no_action when none is registered.
 * Bulk accept of a sweep excludes withdraw proposals unless asked.
 * Serial: mutates the process-global decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import {
  enqueueReviewCandidate, listReviewProposals, registerReviewAcceptHandler, reviewProposalIdsFromSweep, runReviewLane,
} from '../../src/core/ai/decide/review-lane.ts';
import { acceptReviewProposal } from '../../src/core/facts/proposal-review.ts';

let engine: PGLiteEngine;
let calls = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { __setDecideTransportForTests(null); resetGateway(); await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  calls = 0;
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setDecideTransportForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const same = String(q.instructions.candidate).includes('Acme Example Inc');
      const probabilities = same ? { same: 0.96, different: 0.04 } : { same: 0.1, different: 0.9 };
      const choice = same ? 'same' : 'different';
      return [id, { type: 'choice', choice, confidence: probabilities[choice], probabilities }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 5 } }));
  });
  for (const [k, v] of Object.entries({
    'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'on', 'decide.egress.typesafe.candidates': 'allow',
    'decide.egress.private': 'allow', 'decide.slots.conflict.review_duplicate_page': 'true',
  })) await engine.setConfig(k, v);
  const id = await insertCalibration(engine, {
    slot: 'conflict', call_site: 'review_duplicate_page', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.9, min_keep: null,
    metric: 'precision', metric_value: 0.97, ece: 0.03, retest_sd: 0.01, repack_sd: 0.01, n: 200, dataset_hash: 'd', split_hash: 's',
    calibrate_ids_hash: 'c', calibrate_only: false, pack_shape: packShape('conflict'), notes: null,
  });
  await engine.executeRaw('UPDATE decide_calibrations SET action_precision_lb = 0.95 WHERE id = $1', [id]);
  for (const [slug, title, body] of [
    ['companies/acme-example', 'Acme Example', 'A widget company.'],
    ['companies/acme-example-inc', 'Acme Example Inc', 'Acme Example Inc makes widgets.'],
    ['companies/widget-example', 'Widget Example', 'A different company.'],
  ]) await importFromContent(engine, slug!, `---\ntitle: ${title}\ntype: company\n---\n${body}\n`, { noEmbed: true, sourceId: 'default' });
});

describe('duplicate_page review', () => {
  test('enqueued pairs are judged once; same-thing pairs become proposals', async () => {
    await enqueueReviewCandidate(engine, { kind: 'duplicate_page', source_id: 'default', a_ref: 'companies/acme-example-inc', b_ref: 'companies/acme-example', evidence: 'cosine 0.88' });
    await enqueueReviewCandidate(engine, { kind: 'duplicate_page', source_id: 'default', a_ref: 'companies/acme-example', b_ref: 'companies/acme-example-inc' });
    await enqueueReviewCandidate(engine, { kind: 'duplicate_page', source_id: 'default', a_ref: 'companies/acme-example', b_ref: 'companies/widget-example' });
    const r = await runReviewLane(engine, { kind: 'duplicate_page' });
    expect(r).toMatchObject({ effective: 'on', anchors: 2, proposals: 1, independents: 1 });
    const [p] = await listReviewProposals(engine);
    expect(p).toMatchObject({ kind: 'duplicate_page', a_ref: 'companies/acme-example', b_ref: 'companies/acme-example-inc' });
    expect(calls).toBe(2);
  });

  test('accept records the verdict without a handler and runs one when registered', async () => {
    await enqueueReviewCandidate(engine, { kind: 'duplicate_page', source_id: 'default', a_ref: 'companies/acme-example', b_ref: 'companies/acme-example-inc' });
    const r = await runReviewLane(engine, { kind: 'duplicate_page' });
    const [p] = await listReviewProposals(engine);
    expect((await acceptReviewProposal(engine, p!.id)).status).toBe('accepted_no_action');
    expect(await reviewProposalIdsFromSweep(engine, r.sweep_id, { includeWithdrawals: false })).toEqual([]);

    await resetPgliteState(engine);
    for (const [k, v] of Object.entries({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.conflict.mode': 'shadow', 'decide.egress.typesafe.candidates': 'allow', 'decide.slots.conflict.review_duplicate_page': 'true' })) await engine.setConfig(k, v);
    const seen: string[] = [];
    registerReviewAcceptHandler('duplicate_page', async (_e, proposal) => { seen.push(`${proposal.a_ref}=${proposal.b_ref}`); return { status: 'accepted' }; });
    await engine.executeRaw(`INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, p_action) VALUES ('duplicate_page','default','s1','a','b',0.97)`);
    const [q] = await listReviewProposals(engine);
    expect((await acceptReviewProposal(engine, q!.id)).status).toBe('accepted');
    expect(seen).toEqual(['a=b']);
  });

  test('a kind that is off never runs', async () => {
    await engine.setConfig('decide.slots.conflict.review_duplicate_page', 'false');
    await enqueueReviewCandidate(engine, { kind: 'duplicate_page', source_id: 'default', a_ref: 'companies/acme-example', b_ref: 'companies/acme-example-inc' });
    const r = await runReviewLane(engine, { kind: 'duplicate_page' });
    expect(r).toMatchObject({ effective: 'off', inactive: 'review_kind_off' });
    expect(calls).toBe(0);
  });
});
