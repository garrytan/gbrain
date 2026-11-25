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
import { installChunks } from './chunk-fixtures.ts';
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

  parityTest('recursive-walk.ts:133 the language gate reads the symbol\'s languages: an unsupported one stops the walk, a mixed one walks only supported callers', {
    methods: ['putPage', 'upsertChunks', 'sealChunks', 'getChunks', 'addCodeEdges', 'getCallersOf'],
  }, async (engine) => {
    const code = (slug: string, language: string, symbols: string[]) => engine.putPage(slug, {
      type: 'code', page_kind: 'code', title: `${slug} (${language})`, compiled_truth: symbols.map(s => `function ${s}() {}`).join('\n'), timeline: '',
    } as never).then(async () => {
      const inputs = symbols.map((s, i) => ({ chunk_index: i, chunk_text: `function ${s}() {}`, chunk_source: 'compiled_truth' as const,
        language, symbol_name: s.split('.').pop()!, symbol_type: 'function', symbol_name_qualified: s }));
      await engine.upsertChunks(slug, inputs);
      await installChunks(engine, slug, inputs);
      return (await engine.getChunks(slug)).sort((a, b) => a.chunk_index - b.chunk_index).map(c => Number(c.id));
    });
    // Only an unsupported language defines legacy.thing: the gate stops the walk.
    await code('src/legacy-cobol', 'cobol', ['legacy.thing']);
    // pkg.mod.helper is defined in TypeScript and in an unsupported namesake; a TypeScript and a COBOL caller call it.
    const [helperTs] = await code('src/helper-ts', 'typescript', ['pkg.mod.helper']);
    const [helperCobol] = await code('src/helper-cobol', 'cobol', ['pkg.mod.helper']);
    const [callerTs] = await code('src/caller-ts', 'typescript', ['pkg.mod.caller']);
    const [callerCobol] = await code('src/caller-cobol', 'cobol', ['pkg.mod.oldcaller']);
    await engine.addCodeEdges([
      { from_chunk_id: callerTs!, to_chunk_id: helperTs!, from_symbol_qualified: 'pkg.mod.caller', to_symbol_qualified: 'pkg.mod.helper', edge_type: 'calls' },
      { from_chunk_id: callerCobol!, to_chunk_id: helperCobol!, from_symbol_qualified: 'pkg.mod.oldcaller', to_symbol_qualified: 'pkg.mod.helper', edge_type: 'calls' },
    ] as never);
    const legacy = await runRecursiveWalk(engine, 'legacy.thing', { direction: 'callers', sourceId: 'default', exact: true });
    const mixed = await runRecursiveWalk(engine, 'pkg.mod.helper', { direction: 'callers', sourceId: 'default', exact: true, depth: 1 });
    const symbols = (w: typeof mixed) => ('depth_groups' in w ? (w as { depth_groups: Array<{ nodes: Array<{ symbol: string }> }> }).depth_groups : [])
      .flatMap(g => g.nodes.map(n => n.symbol)).sort();
    const out = { legacy: legacy.result, mixed: mixed.result, callers: symbols(mixed) };
    expect(out).toEqual({ legacy: 'unsupported_language', mixed: 'ok', callers: ['pkg.mod.caller'] });
    return out;
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

  parityTest('reindex-consent.ts:44 the spend estimate prices the text of the pages the run would re-embed', {
    methods: ['putPage'],
  }, async (engine) => {
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Some text to embed.', timeline: '', frontmatter: {} } as never);
    await engine.putPage('notes/b', { type: 'concept', title: 'B', compiled_truth: 'More words here.', timeline: 'and a timeline', frontmatter: {} } as never);
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    try {
      const all = await estimateReindexSpend(engine, { type: null, target: 2 });
      const notes = await estimateReindexSpend(engine, { type: 'note', target: 1 });
      const none = await estimateReindexSpend(engine, { type: 'missing-type', target: 0 });
      const view = (p: { pages: number; est_usd: number | null }) => ({ pages: p.pages, usd: p.est_usd === null ? null : Number(p.est_usd.toFixed(12)) });
      const out = { all: view(all), notes: view(notes), none: view(none) };
      // 49 characters at the model's price for all pages; 19 for the note; none past an empty type.
      expect(out).toEqual({ all: { pages: 2, usd: 2.8e-7 }, notes: { pages: 1, usd: 1.2e-7 }, none: { pages: 0, usd: 0 } });
      return out;
    } finally {
      resetGateway();
    }
  });
});
