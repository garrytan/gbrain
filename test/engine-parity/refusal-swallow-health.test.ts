/**
 * BrainEngine parity: the bootstrap and health-path refusal-swallow sites (lane 8's triage, rule
 * capability_refusal_swallowed). The brain id, the takes count and the probe-fact cleanup now go through typed
 * members, so a Rust brain answers; the code walk's language gate, the reindex estimate and the impact log let a refusal
 * through (the impact log as a typed step marker). serve-health.ts:69 has no engine member to declare, so its case is in
 * test/serve-transport-application-name.test.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm the recovery banner names the brain id, the takes metric reads the count, verify's cleanup
 *    removes exactly the probe pages' facts. The walk's language
 *    gate and the reindex estimate answer on PGLite and Postgres and throw the typed refusal on Rust. closeStepImpact
 *    returns `recorded` where the engine keeps the impact log and `engine_capability_missing` where it does not.
 *  - Regression: on a Rust brain each catch answered a default: the banner had no id, the takes metric was null, the
 *    probe facts stayed, the walk said "no languages", the estimate said "no known
 *    price" and the impact row was lost with only a stderr line.
 *  - Why existing coverage misses it: every site ran `executeRaw` inside a catch, and its tests run on PGLite only.
 *  - Seam: none; real engines.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { recoveryBannerHost } from '../../src/commands/upgrade.ts';
import { removeProbeFacts, VERIFY_PROBE_ENTITY_SLUG, VERIFY_PROBE_SLUG } from '../../src/core/bootstrap/verify.ts';
import { runRecursiveWalk } from '../../src/core/code-intel/recursive-walk.ts';
import { captureMetric, closeStepImpact } from '../../src/core/onboard/impact-capture.ts';
import { estimateReindexSpend } from '../../src/core/reindex-consent.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('refusal-swallow bootstrap and health sites', () => {
  parityTest('upgrade.ts:1093 the recovery banner names the brain id', { methods: ['readPersistenceBrainIdText'] }, async (engine) => {
    return (await recoveryBannerHost(engine)).replace(/^host \((pglite|postgres|rust)/, 'host (<engine>').replace(/id [0-9a-f-]{8,}/, 'id <uuid>');
  });

  parityTest('verify.ts:257 cleanup removes the probe pages\' facts and keeps the user\'s', { methods: ['insertFacts', 'listFactsForPage', 'deletePurgedFacts', 'transaction', 'deleteFactsForPage'] }, async (engine) => {
    for (const slug of [VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG, 'wiki/user-note']) {
      await engine.insertFacts([{ fact: `a fact on ${slug}`, source: 'fence', row_num: 1, source_markdown_slug: slug }], { source_id: 'default' });
    }
    const warnings = await removeProbeFacts(engine, 'default', false);
    const left = async (slug: string) => (await engine.deleteFactsForPage(slug, 'default')).deleted;
    return { warnings, probe: await left(VERIFY_PROBE_SLUG), entity: await left(VERIFY_PROBE_ENTITY_SLUG), user: await left('wiki/user-note') };
  });

  parityTest('recursive-walk.ts:133 the language gate refuses instead of finding no languages', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const walk = await runRecursiveWalk(engine, 'pkg.mod.helper', { direction: 'callers', sourceId: 'default', exact: true });
    return walk.result;
  });

  parityTest('impact-capture.ts:116 the takes metric reads the takes count', { methods: ['countTakes'] }, async (engine) => {
    return captureMetric(engine, 'takes_count');
  });

  parityTest('impact-capture.ts:157 the impact row is written or its write refused, never dropped', { methods: ['countTakes', 'executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    const probe = { metric: 'takes_count' as const, before: 0, startedAt: new Date().toISOString() };
    const step = { id: 'parity-step', job: 'parity-job', idempotency_key: 'parity-key', params: {} } as never;
    await closeStepImpact(engine, probe, step, { jobId: 1, status: 'completed', doctorRunId: 'run-1' });
    // A Rust arm that gets here wrote nothing and must not finish as if it had: the harness fails a case that returns
    // after catching a refusal. The SQL arms read the row back.
    if (backend === 'rust') return [];
    return (await engine.executeRaw<{ remediation_id: string; metric_before: number; metric_after: number }>(
      'SELECT remediation_id, metric_before, metric_after FROM migration_impact_log')).map(r => ({ ...r, metric_before: Number(r.metric_before), metric_after: Number(r.metric_after) }));
  });

  parityTest('reindex-consent.ts:44 the spend estimate refuses instead of reporting no known price', { methods: ['executeRaw', 'putPage'], requires: 'raw_sql' }, async (engine) => {
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Some text to embed.', timeline: '', frontmatter: {} } as never);
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    try {
      const plan = await estimateReindexSpend(engine, { type: null, target: 1 });
      return { pages: plan.pages, priced: plan.est_usd !== null };
    } finally {
      resetGateway();
    }
  });
});
