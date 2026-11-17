/**
 * BrainEngine parity — code_edges, eval_capture, salience_enrich families.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: code-edge storage and traversal, eval candidate/failure
 *    capture, and the salience / enrich-candidate / anomaly reads return the
 *    same observable result on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that drops the resolved/unresolved split of code
 *    edges, mis-scopes callers by source, loses eval fields, mis-orders
 *    salience, or counts inbound links across sources — code-callers,
 *    `gbrain eval export`, `get_recent_salience`, `enrich --thin` and
 *    `find_anomalies` all depend on these reads.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and covers none of these; the per-engine unit
 *    tests (test/code-edges.test.ts etc.) never compare two engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Chunk and row ids are sequence-generated and never returned: edges are
 *    mapped to `slug#chunk_index` labels, eval rows drop id/created_at.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodeEdgeResult, EvalCandidateInput } from '../../src/core/types.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** Create a code page with N chunks and return `chunk id -> slug#index` labels. */
async function seedCodePage(engine: BrainEngine, slug: string, symbols: string[], opts?: { sourceId?: string }) {
  await engine.putPage(slug, {
    type: 'code', page_kind: 'code', title: `${slug} (typescript)`, compiled_truth: symbols.map((s) => `function ${s}() {}`).join('\n'), timeline: '',
  }, opts);
  const inputs = symbols.map((s, i) => ({
    chunk_index: i,
    chunk_text: `function ${s}() {}`,
    chunk_source: 'compiled_truth' as const,
    language: 'typescript',
    symbol_name: s,
    symbol_type: 'function',
    symbol_name_qualified: s,
  }));
  await engine.upsertChunks(slug, inputs, opts);
  // Code-edge reads only serve sealed projections; the shared fixture seals them (see chunk-fixtures.ts).
  await installChunks(engine, slug, inputs, opts);
  const chunks = await engine.getChunks(slug, opts);
  return new Map(chunks.map((c) => [c.id, `${slug}#${c.chunk_index}`]));
}

function edgeView(labels: Map<number, string>, e: CodeEdgeResult): string {
  const from = labels.get(e.from_chunk_id) ?? `?${e.from_chunk_id}`;
  const to = e.to_chunk_id == null ? 'null' : (labels.get(e.to_chunk_id) ?? `?${e.to_chunk_id}`);
  return `${from} -[${e.edge_type}]-> ${to} (${e.from_symbol_qualified} => ${e.to_symbol_qualified}) resolved=${e.resolved} source=${e.source_id ?? 'null'}`;
}

describe('engine parity: code edges', () => {
  parityTest(
    'addCodeEdges splits resolved and unresolved edges, is idempotent, and getCallers/getCallees/getEdgesByChunk read them',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'addCodeEdges', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk'] },
    async (engine) => {
      const a = await seedCodePage(engine, 'src-a-ts', ['run', 'main']);
      const b = await seedCodePage(engine, 'src-b-ts', ['helper']);
      const labels = new Map([...a, ...b]);
      const id = (label: string) => [...labels.entries()].find(([, l]) => l === label)![0];
      const runId = id('src-a-ts#0');
      const mainId = id('src-a-ts#1');
      const helperId = id('src-b-ts#0');
      const edges = [
        { from_chunk_id: runId, to_chunk_id: helperId, from_symbol_qualified: 'run', to_symbol_qualified: 'helper', edge_type: 'calls' },
        { from_chunk_id: runId, to_chunk_id: null, from_symbol_qualified: 'run', to_symbol_qualified: 'external.fetch', edge_type: 'calls' },
        { from_chunk_id: mainId, to_chunk_id: null, from_symbol_qualified: 'main', to_symbol_qualified: 'helper', edge_type: 'calls' },
        { from_chunk_id: mainId, to_chunk_id: runId, from_symbol_qualified: 'main', to_symbol_qualified: 'run', edge_type: 'imports' },
      ];
      const inserted = await engine.addCodeEdges(edges);
      const again = await engine.addCodeEdges(edges);
      const empty = await engine.addCodeEdges([]);
      expect(inserted).toBe(4);
      expect(again).toBe(0);
      expect(empty).toBe(0);
      const view = (rows: CodeEdgeResult[]) => sorted(rows.map((e) => edgeView(labels, e)));
      const callersOfHelper = view(await engine.getCallersOf('helper', { allSources: true }));
      const callersLimited = (await engine.getCallersOf('helper', { allSources: true, limit: 1 })).length;
      const callersNone = await engine.getCallersOf('nobody', { allSources: true });
      const calleesOfRun = view(await engine.getCalleesOf('run', { allSources: true }));
      const calleesLimited = (await engine.getCalleesOf('run', { allSources: true, limit: 1 })).length;
      const outOfRun = view(await engine.getEdgesByChunk(runId, { direction: 'out' }));
      const inToRun = view(await engine.getEdgesByChunk(runId, { direction: 'in' }));
      const bothRun = view(await engine.getEdgesByChunk(runId, { direction: 'both' }));
      const importsOnly = view(await engine.getEdgesByChunk(runId, { direction: 'both', edgeType: 'imports' }));
      const inToHelper = view(await engine.getEdgesByChunk(helperId, { direction: 'in' }));
      expect(callersOfHelper).toHaveLength(2);
      expect(callersLimited).toBe(1);
      expect(calleesLimited).toBe(1);
      expect(callersNone).toEqual([]);
      expect(outOfRun).toHaveLength(2);
      expect(importsOnly).toHaveLength(1);
      return { inserted, again, empty, callersOfHelper, callersLimited, callersNone: callersNone.length, calleesOfRun, calleesLimited, outOfRun, inToRun, bothRun, importsOnly, inToHelper };
    },
  );

  parityTest(
    'getCallersOf/getCalleesOf scope by the anchor chunk source unless allSources is set',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'addCodeEdges', 'getCallersOf', 'getCalleesOf'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'code-other');
      const d = await seedCodePage(engine, 'src-d-ts', ['caller']);
      const o = await seedCodePage(engine, 'src-o-ts', ['caller'], { sourceId: 'code-other' });
      const labels = new Map([...d, ...o]);
      const idOf = (label: string) => [...labels.entries()].find(([, l]) => l === label)![0];
      await engine.addCodeEdges([
        { from_chunk_id: idOf('src-d-ts#0'), to_chunk_id: null, from_symbol_qualified: 'caller', to_symbol_qualified: 'shared.target', edge_type: 'calls', source_id: 'default' },
        { from_chunk_id: idOf('src-o-ts#0'), to_chunk_id: null, from_symbol_qualified: 'caller', to_symbol_qualified: 'shared.target', edge_type: 'calls', source_id: 'code-other' },
      ]);
      const view = (rows: CodeEdgeResult[]) => sorted(rows.map((e) => edgeView(labels, e)));
      const all = view(await engine.getCallersOf('shared.target', { allSources: true }));
      const defaultOnly = view(await engine.getCallersOf('shared.target', { sourceId: 'default' }));
      const otherOnly = view(await engine.getCallersOf('shared.target', { sourceId: 'code-other' }));
      const calleesDefault = view(await engine.getCalleesOf('caller', { sourceId: 'default' }));
      const calleesOther = view(await engine.getCalleesOf('caller', { sourceId: 'code-other' }));
      expect(all).toHaveLength(2);
      expect(defaultOnly).toHaveLength(1);
      expect(otherOnly).toHaveLength(1);
      return { all, defaultOnly, otherOnly, calleesDefault, calleesOther };
    },
  );

  parityTest(
    'deleteCodeEdgesForChunks wipes edges in both directions across resolved and unresolved tables',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'addCodeEdges', 'deleteCodeEdgesForChunks', 'getEdgesByChunk', 'getCallersOf'] },
    async (engine) => {
      const a = await seedCodePage(engine, 'src-del-a-ts', ['alpha']);
      const b = await seedCodePage(engine, 'src-del-b-ts', ['beta']);
      const c = await seedCodePage(engine, 'src-del-c-ts', ['gamma']);
      const labels = new Map([...a, ...b, ...c]);
      const idOf = (label: string) => [...labels.entries()].find(([, l]) => l === label)![0];
      const alpha = idOf('src-del-a-ts#0');
      const beta = idOf('src-del-b-ts#0');
      const gamma = idOf('src-del-c-ts#0');
      await engine.addCodeEdges([
        { from_chunk_id: alpha, to_chunk_id: beta, from_symbol_qualified: 'alpha', to_symbol_qualified: 'beta', edge_type: 'calls' },
        { from_chunk_id: gamma, to_chunk_id: alpha, from_symbol_qualified: 'gamma', to_symbol_qualified: 'alpha', edge_type: 'calls' },
        { from_chunk_id: alpha, to_chunk_id: null, from_symbol_qualified: 'alpha', to_symbol_qualified: 'ext.one', edge_type: 'calls' },
        { from_chunk_id: gamma, to_chunk_id: beta, from_symbol_qualified: 'gamma', to_symbol_qualified: 'beta', edge_type: 'calls' },
      ]);
      const view = (rows: CodeEdgeResult[]) => sorted(rows.map((e) => edgeView(labels, e)));
      const before = view(await engine.getEdgesByChunk(alpha, { direction: 'both' }));
      await engine.deleteCodeEdgesForChunks([alpha]);
      await engine.deleteCodeEdgesForChunks([]);
      const afterAlpha = view(await engine.getEdgesByChunk(alpha, { direction: 'both' }));
      const survivor = view(await engine.getEdgesByChunk(gamma, { direction: 'both' }));
      const callersOfExt = await engine.getCallersOf('ext.one', { allSources: true });
      expect(before).toHaveLength(3);
      expect(afterAlpha).toEqual([]);
      expect(survivor).toHaveLength(1);
      expect(callersOfExt).toEqual([]);
      return { before, afterAlpha, survivor, callersOfExt: callersOfExt.length };
    },
  );
});

const CANDIDATE: EvalCandidateInput = {
  tool_name: 'query',
  query: 'who runs acme',
  retrieved_slugs: ['people/alice', 'companies/acme'],
  retrieved_chunk_ids: [],
  source_ids: ['default'],
  expand_enabled: true,
  detail: 'medium',
  detail_resolved: 'high',
  vector_enabled: true,
  expansion_applied: false,
  latency_ms: 42,
  remote: false,
  job_id: null,
  subagent_id: null,
  embedding_column: 'embedding',
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A cutoff just after the newest stored timestamp (the database's own clock,
 * so no JS/DB skew on the old side), then a bounded wait until the wall clock
 * passes it, so the next row is stamped after the cutoff.
 */
async function cutoffAfter(stamps: readonly Date[]): Promise<Date> {
  const cutoff = new Date(Math.max(...stamps.map((d) => d.getTime())) + 1);
  const deadline = Date.now() + 2_000;
  while (Date.now() <= cutoff.getTime()) {
    if (Date.now() > deadline) throw new Error(`wall clock did not pass ${cutoff.toISOString()} within 2 s`);
    await delay(2);
  }
  return cutoff;
}

describe('engine parity: eval capture', () => {
  parityTest(
    'logEvalCandidate round-trips every field through listEvalCandidates, with tool filter and limit',
    { methods: ['logEvalCandidate', 'listEvalCandidates'] },
    async (engine) => {
      const first = await engine.logEvalCandidate(CANDIDATE);
      await delay(20);
      await engine.logEvalCandidate({
        ...CANDIDATE, tool_name: 'search', query: 'acme widgets', expand_enabled: null, detail: null, detail_resolved: null,
        vector_enabled: false, retrieved_slugs: ['companies/acme'], source_ids: ['default', 'other'], latency_ms: 7, remote: true, embedding_column: null,
      });
      await delay(20);
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'third query', latency_ms: 99, job_id: null });
      expect(typeof first).toBe('number');
      const view = (c: Awaited<ReturnType<typeof engine.listEvalCandidates>>[number]) => {
        const { id: _id, created_at, ...rest } = c;
        expect(created_at).toBeInstanceOf(Date);
        return rest;
      };
      const all = await engine.listEvalCandidates();
      const queries = await engine.listEvalCandidates({ tool: 'query' });
      const searches = await engine.listEvalCandidates({ tool: 'search' });
      const limited = await engine.listEvalCandidates({ limit: 2 });
      expect(all).toHaveLength(3);
      expect(queries).toHaveLength(2);
      expect(searches).toHaveLength(1);
      expect(limited).toHaveLength(2);
      return {
        all: sorted(all.map(view), (c) => c.query),
        queries: sorted(queries.map((c) => c.query)),
        searches: searches.map(view),
        limitedCount: limited.length,
        // Newest-first is the documented export order; the two newest are the last two inserted.
        newestFirst: all.map((c) => c.query),
      };
    },
  );

  parityTest(
    'listEvalCandidates since-window and deleteEvalCandidatesBefore split old from new rows',
    { methods: ['logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore'] },
    async (engine) => {
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'old one' });
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'old two' });
      const cutoff = await cutoffAfter((await engine.listEvalCandidates()).map((c) => c.created_at));
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'new one' });
      const sinceCutoff = (await engine.listEvalCandidates({ since: cutoff })).map((c) => c.query);
      const future = await engine.listEvalCandidates({ since: new Date(Date.now() + 3_600_000) });
      const deletedNone = await engine.deleteEvalCandidatesBefore(new Date(Date.now() - 3_600_000));
      const deleted = await engine.deleteEvalCandidatesBefore(cutoff);
      const remaining = (await engine.listEvalCandidates()).map((c) => c.query);
      const deletedRest = await engine.deleteEvalCandidatesBefore(new Date(Date.now() + 3_600_000));
      expect(sinceCutoff).toEqual(['new one']);
      expect(deleted).toBe(2);
      expect(remaining).toEqual(['new one']);
      return { sinceCutoff, future: future.length, deletedNone, deleted, remaining, deletedRest, afterAll: (await engine.listEvalCandidates()).length };
    },
  );

  parityTest(
    'logEvalCaptureFailure records reasons; listEvalCaptureFailures filters by since',
    { methods: ['logEvalCaptureFailure', 'listEvalCaptureFailures'] },
    async (engine) => {
      const none = await engine.listEvalCaptureFailures();
      await engine.logEvalCaptureFailure('db_down');
      await engine.logEvalCaptureFailure('scrubber_exception');
      const cutoff = await cutoffAfter((await engine.listEvalCaptureFailures()).map((f) => new Date(f.ts)));
      await engine.logEvalCaptureFailure('other');
      const all = await engine.listEvalCaptureFailures();
      const recent = await engine.listEvalCaptureFailures({ since: cutoff });
      const future = await engine.listEvalCaptureFailures({ since: new Date(Date.now() + 3_600_000) });
      expect(all).toHaveLength(3);
      expect(recent.map((f) => f.reason)).toEqual(['other']);
      return {
        none: none.length,
        all: sorted(all.map((f) => pick(f, ['reason', 'ts'] as const)), (f) => f.reason),
        recent: recent.map((f) => f.reason),
        future: future.length,
      };
    },
  );
});

describe('engine parity: salience + enrich + anomalies', () => {
  parityTest(
    'batchLoadEmotionalInputs returns tags and active takes per page; slug filter narrows',
    { methods: ['putPage', 'addTag', 'addTakesBatch', 'batchLoadEmotionalInputs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'sal-other');
      const alice = await engine.putPage('people/sal-alice', { type: 'person', title: 'Alice', compiled_truth: 'A.', timeline: '' });
      await engine.putPage('people/sal-bob', { type: 'person', title: 'Bob', compiled_truth: 'B.', timeline: '' });
      await engine.putPage('people/sal-bob', { type: 'person', title: 'Bob Other', compiled_truth: 'B2.', timeline: '' }, { sourceId: 'sal-other' });
      await engine.addTag('people/sal-alice', 'family');
      await engine.addTag('people/sal-alice', 'founder');
      await engine.addTag('people/sal-bob', 'founder');
      await engine.addTakesBatch([
        { page_id: alice.id, row_num: 1, claim: 'Alice cares a lot', kind: 'belief', holder: 'garry', weight: 0.9 },
        { page_id: alice.id, row_num: 2, claim: 'Alice is busy', kind: 'fact', holder: 'garry', weight: 0.4 },
        { page_id: alice.id, row_num: 3, claim: 'Retired claim', kind: 'belief', holder: 'garry', weight: 0.8, active: false },
      ]);
      const view = (rows: Awaited<ReturnType<typeof engine.batchLoadEmotionalInputs>>) =>
        sorted(rows.map((r) => ({
          id: `${r.source_id}:${r.slug}`,
          tags: sorted(r.tags),
          takes: sorted(r.takes.map((t) => `${t.kind}|${t.holder}|${t.weight}|${t.active}`)),
        })), (r) => r.id);
      const everything = view(await engine.batchLoadEmotionalInputs());
      const one = view(await engine.batchLoadEmotionalInputs(['people/sal-alice']));
      const none = await engine.batchLoadEmotionalInputs(['people/missing']);
      expect(everything).toHaveLength(3);
      expect(one).toHaveLength(1);
      expect(one[0]!.takes).toHaveLength(2);
      expect(none).toEqual([]);
      return { everything, one, none };
    },
  );

  parityTest(
    'setEmotionalWeightBatch counts changed rows only, is source-keyed, and feeds getRecentSalience ordering',
    { methods: ['putPage', 'addTakesBatch', 'setEmotionalWeightBatch', 'getRecentSalience'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'sal2-other');
      const calm = await engine.putPage('notes/sal-calm', { type: 'note', title: 'Calm', compiled_truth: 'Calm.', timeline: '' });
      await engine.putPage('notes/sal-charged', { type: 'note', title: 'Charged', compiled_truth: 'Charged.', timeline: '' });
      await engine.putPage('notes/sal-charged', { type: 'note', title: 'Charged Other', compiled_truth: 'Charged other.', timeline: '' }, { sourceId: 'sal2-other' });
      await engine.putPage('briefings/daily', { type: 'note', title: 'Briefing', compiled_truth: 'Briefing.', timeline: '' });
      await engine.putPage('people/sal-person', { type: 'person', title: 'Person', compiled_truth: 'Person.', timeline: '' });
      await engine.addTakesBatch([
        { page_id: calm.id, row_num: 1, claim: 'c1', kind: 'fact', holder: 'garry', weight: 0.5 },
        { page_id: calm.id, row_num: 2, claim: 'c2', kind: 'fact', holder: 'garry', weight: 0.7 },
      ]);
      const changed = await engine.setEmotionalWeightBatch([
        { slug: 'notes/sal-charged', source_id: 'default', weight: 0.9 },
        { slug: 'people/sal-person', source_id: 'default', weight: 0.2 },
        { slug: 'notes/sal-charged', source_id: 'sal2-other', weight: 0.4 },
        { slug: 'notes/not-a-page', source_id: 'default', weight: 1 },
      ]);
      const unchanged = await engine.setEmotionalWeightBatch([
        { slug: 'notes/sal-charged', source_id: 'default', weight: 0.9 },
      ]);
      const empty = await engine.setEmotionalWeightBatch([]);
      expect(changed).toBe(3);
      expect(unchanged).toBe(0);
      expect(empty).toBe(0);
      // score = emotional_weight*5 + ln(1+takes) + a recency term that drifts with wall time: round it.
      const view = (rows: Awaited<ReturnType<typeof engine.getRecentSalience>>) =>
        rows.map((r) => ({ id: `${r.source_id}:${r.slug}`, title: r.title, type: r.type, ew: Math.round(r.emotional_weight * 100) / 100, takes: r.take_count, avg: Math.round(r.take_avg_weight * 100) / 100, score: Math.round(r.score) }));
      const all = view(await engine.getRecentSalience({ days: 7 }));
      const scoped = view(await engine.getRecentSalience({ days: 7, sourceId: 'sal2-other' }));
      const prefixed = view(await engine.getRecentSalience({ days: 7, slugPrefix: 'people/' }));
      const limited = view(await engine.getRecentSalience({ days: 7, limit: 2 }));
      const noWindow = await engine.getRecentSalience({ days: 0 });
      expect(all.map((r) => r.id)).not.toContain('default:briefings/daily');
      expect(all[0]!.id).toBe('default:notes/sal-charged');
      expect(scoped.map((r) => r.id)).toEqual(['sal2-other:notes/sal-charged']);
      expect(prefixed.map((r) => r.id)).toEqual(['default:people/sal-person']);
      expect(limited).toHaveLength(2);
      return { changed, unchanged, empty, all, scoped, prefixed, limitedKeys: limited.map((r) => r.id), noWindow: noWindow.length };
    },
  );

  parityTest(
    'listEnrichCandidates picks thin pages by type, counts inbound links, orders and limits, and scopes by source',
    { methods: ['putPage', 'addLink', 'listEnrichCandidates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'enrich-other');
      const thin = { compiled_truth: 'Stub.', timeline: '' };
      await engine.putPage('people/enrich-a', { type: 'person', title: 'Alpha', ...thin });
      await engine.putPage('people/enrich-b', { type: 'person', title: 'Beta', ...thin });
      await engine.putPage('people/enrich-c', { type: 'person', title: 'Gamma', ...thin });
      await engine.putPage('companies/enrich-co', { type: 'company', title: 'Co', ...thin });
      await engine.putPage('people/enrich-thick', { type: 'person', title: 'Thick', compiled_truth: 'x'.repeat(400), timeline: '' });
      await engine.putPage('people/enrich-dream', { type: 'person', title: 'Dream', ...thin, frontmatter: { dream_generated: true } });
      await engine.putPage('people/enrich-o', { type: 'person', title: 'Other', ...thin }, { sourceId: 'enrich-other' });
      await engine.putPage('notes/enrich-linker', { type: 'note', title: 'Linker', compiled_truth: 'Links to people.', timeline: '' });
      await engine.addLink('notes/enrich-linker', 'people/enrich-b', '', 'mentions_person');
      await engine.addLink('notes/enrich-linker', 'people/enrich-c', '', 'mentions_person');
      await engine.addLink('companies/enrich-co', 'people/enrich-c', '', 'works_at');
      const view = (rows: Awaited<ReturnType<typeof engine.listEnrichCandidates>>) =>
        rows.map((r) => `${r.source_id}:${r.slug}|${r.type}|${r.title}|${r.body_len}|${r.inbound_count}`);
      const base = { types: ['person' as const], thinThreshold: 100, order: 'inbound-links' as const, limit: 50 };
      const byInbound = view(await engine.listEnrichCandidates(base));
      const limited = view(await engine.listEnrichCandidates({ ...base, limit: 2 }));
      const bySlugScoped = view(await engine.listEnrichCandidates({ ...base, sourceId: 'enrich-other' }));
      const federated = view(await engine.listEnrichCandidates({ ...base, sourceIds: ['default'] }));
      const twoTypes = view(await engine.listEnrichCandidates({ ...base, types: ['person', 'company'] }));
      const noTypes = await engine.listEnrichCandidates({ ...base, types: [] });
      const thickToo = view(await engine.listEnrichCandidates({ ...base, thinThreshold: 1000 }));
      const updated = view(await engine.listEnrichCandidates({ ...base, order: 'updated' }));
      expect(byInbound[0]).toContain('people/enrich-c');
      expect(byInbound.some((r) => r.includes('enrich-thick'))).toBe(false);
      expect(byInbound.some((r) => r.includes('enrich-dream'))).toBe(false);
      expect(noTypes).toEqual([]);
      expect(limited).toHaveLength(2);
      return { byInbound, limited, bySlugScoped, federated, twoTypes, noTypes: noTypes.length, thickToo, updatedCount: updated.length };
    },
  );

  parityTest(
    'findAnomalies flags a cohort with unusual activity today and respects source scope and sigma',
    { methods: ['putPage', 'addTag', 'findAnomalies'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'anom-other');
      for (let i = 0; i < 4; i++) {
        await engine.putPage(`notes/anom-${i}`, { type: 'note', title: `Anom ${i}`, compiled_truth: `Anomaly ${i}.`, timeline: '' });
        await engine.addTag(`notes/anom-${i}`, 'launch');
      }
      await engine.putPage('people/anom-solo', { type: 'person', title: 'Solo', compiled_truth: 'Solo.', timeline: '' });
      await engine.putPage('notes/anom-o', { type: 'note', title: 'Other', compiled_truth: 'Other.', timeline: '' }, { sourceId: 'anom-other' });
      // The day the pages were stamped by the database, not the JS clock, so a run across UTC midnight still matches.
      const today = new Date((await engine.getPage('notes/anom-3'))!.updated_at).toISOString().slice(0, 10);
      const view = (rows: Awaited<ReturnType<typeof engine.findAnomalies>>) =>
        rows.map((r) => ({ ...pick(r, ['cohort_kind', 'cohort_value', 'count'] as const), baseline_mean: r.baseline_mean, baseline_stddev: r.baseline_stddev, page_slugs: sorted(r.page_slugs) }));
      const found = view(await engine.findAnomalies({ since: today, lookback_days: 7 }));
      const scoped = view(await engine.findAnomalies({ since: today, lookback_days: 7, sourceId: 'anom-other' }));
      const strict = view(await engine.findAnomalies({ since: today, lookback_days: 7, sigma: 50 }));
      const otherDay = await engine.findAnomalies({ since: '2020-01-01', lookback_days: 7 });
      expect(found.find((r) => r.cohort_kind === 'tag' && r.cohort_value === 'launch')?.count).toBe(4);
      expect(otherDay).toEqual([]);
      return { found, scoped, strict, otherDay: otherDay.length };
    },
  );
});
