/**
 * BrainEngine parity — the whole receipt of a committed `purge_fact` (src/core/facts/purge.ts submitPurgeFactMutation,
 * receipt from src/core/facts/purge-verify.ts verifyFactPurge) on a brain where the claim reaches every store a fact
 * purge sweeps: facts, takes, take proposals, a decide proposal, an inline page's facts fence and its chunks, a segmented
 * page's facts fence, the belief ledger and a live fact context that quotes the claim.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the dry run's receipt and the committed receipt (every store's status and counts, the residuals, the
 *    completion) are the same on PGLite, Postgres and Rust, and the claim is gone from the live stores afterwards. On a
 *    source that records belief events, a Rust purge stops at its pre-write check on the belief-ledger raw sites
 *    (persistence/fact-purge-path-members.ts, owner lane 3, due 5 PM PST Nov 28) with nothing journaled or removed.
 *  - Regression: an engine whose purge stops part way, or whose receipt reads a store differently (the belief ledger's
 *    recorded values, a fact context that quotes the claim, a segmented page's rewrite), tells the user a different
 *    story about what was erased.
 *  - Why existing coverage misses it: the purge parity files call the typed purge members one by one
 *    (fact-purge-members, purge-writes, segmented-purge-writes, belief-purge-probes, fact-purge-probes), and
 *    fact-purge-commit runs the operation on a brain that holds one fact row only; none compares a whole receipt.
 *  - Seam: none. Real engines; every row is seeded through typed members. Generated values (ids, request ids,
 *    revisions, times) are compared by shape, never by value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { enableBeliefCoverage, parityArms } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { readSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CLAIM = 'Gate code at the lake house is 7731';
const KEPT = 'Likes green tea';
const INLINE = 'people/alice-example';
const SEGMENTED = 'people/bob-example';
const REQUEST = 'a0000000-0000-4000-8000-0000000000e1';
const purge = operations.find((o) => o.name === 'purge_fact')!;

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
/** A long conversation page whose facts fence sits in one segment of many, so the purge rewrites it as a new generation. */
const segmentedBodyText = `${conversationBody(640 * 1024, { seed: 41 })}\n\n## Facts\n\n${fence([row(1, CLAIM)])}\n\n` + conversationBody(640 * 1024, { seed: 42 });
const inlineBody = `# Alice Example\n\nProse about the lake house.\n\n## Facts\n\n${fence([row(1, CLAIM), row(2, KEPT)])}\n`;

const contextFor = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: SRC,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

/** Generated values (ids, request ids, revisions, tokens, times) replaced by their type, so arms compare. */
const GENERATED = /(^|_)(id|ids|request_id|revision|expected_revision|confirm_token|at|created_at|updated_at|purged_at|version_id|elapsed_ms|ms)$/;
function shape(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => shape(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, shape(v, k)]));
  }
  if (GENERATED.test(key) && value !== null && value !== undefined) return `<${typeof value}>`;
  if (typeof value !== 'string') return value;
  // A fact's subject key (`f<id>`) carries its serial id, which differs by engine.
  return /^f\d+$/.test(value) ? 'f<id>' : value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

/** A segmented page's live body, read through its manifest. */
async function segmentedBody(engine: BrainEngine, pageId: number): Promise<string> {
  const parts: string[] = [];
  for await (const part of readSegmentedBody(engine, pageId, SRC)) parts.push(new TextDecoder().decode(part.bytes));
  return parts.join('');
}

/**
 * Write the segmented page through the string import's staging (stageSegmentedImport), as segmented-rewrite.test.ts
 * does: a fenced importFromContent also runs the facts withdrawal overlay, which this case does not exercise.
 */
async function segmentedPage(engine: BrainEngine, slug: string, truth: string): Promise<number> {
  const meta = { title: slug, type: 'person' as const, frontmatter: {}, page_kind: 'markdown' as const };
  const staged = await stageSegmentedImport(engine, { slug, sourceId: SRC, existing: null, policy: await readPageBodyPolicy(engine), baseRevision: null,
    page: { title: slug, type: 'person', compiled_truth: truth, timeline: '', frontmatter: {}, tags: [] }, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
  const pageId = await engine.transaction(async tx => {
    const applied = await staged.apply(tx, meta as never, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
    return applied.pageId;
  });
  expect(await staged.afterCommit(engine)).toBe(true);
  return pageId;
}

/**
 * The receipt as the arms compare it. The `database_physical` residual names the engine's own storage (PGLite's
 * --vacuum, the Postgres operator's VACUUM), so only its store and status are compared, and the Postgres-only
 * `tell_user_to_run` VACUUM command is checked per engine by the case; every other entry is whole.
 */
function receipt({ tell_user_to_run: _vacuum, ...value }: Record<string, unknown>): unknown {
  const residuals = (value.residuals as Array<Record<string, unknown>> | undefined)?.map((r) =>
    r.store === 'database_physical' ? { store: r.store, status: r.status } : r);
  return shape({ ...value, ...(residuals ? { residuals } : {}) });
}

async function seed(engine: BrainEngine): Promise<{ id: number; bob: number }> {
  const alice = await engine.putPage(INLINE, { type: 'person', title: 'Alice Example', compiled_truth: inlineBody, timeline: '' } as never);
  await installChunks(engine, INLINE, [chunk(0, 'Prose about the lake house.'), chunk(1, `${CLAIM}. ${KEPT}.`)]);
  await engine.setConfig('pages.segmented_storage', 'on');
  const bob = await segmentedPage(engine, SEGMENTED, segmentedBodyText);
  const fact = (text: string, entity: string, over: Record<string, unknown> = {}) =>
    ({ fact: text, entity_slug: entity, kind: 'fact', visibility: 'world', source: 'chat', ...over });
  await engine.insertFacts([
    fact(CLAIM, INLINE), fact(KEPT, INLINE), fact(CLAIM, SEGMENTED),
    // A live fact whose context quotes the claim: the purge keeps it, and the receipt names it.
    fact('Alice owns a lake house', INLINE, { context: `She said: ${CLAIM}.` }),
  ] as never, { source_id: SRC });
  await engine.addTakesBatch([
    { page_id: alice.id, row_num: 1, claim: CLAIM, kind: 'take', holder: 'people/alice-example', weight: 0.7 },
    { page_id: alice.id, row_num: 2, claim: KEPT, kind: 'take', holder: 'people/alice-example', weight: 0.5 },
  ]);
  await engine.insertTakeProposal({ sourceId: SRC, pageSlug: INLINE, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1',
    claimText: CLAIM, kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model' });
  const facts = await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 100 } as never);
  const idOf = (text: string, entity: string) => Number(facts.find((f) => f.fact === text && f.entity_slug === entity)!.id);
  const target = idOf(CLAIM, INLINE);
  // A supersession proposal between the purged fact and a kept one: the purge drops it with the fact.
  await engine.insertDecideProposal({ source_id: SRC, sweep_id: 'sweep-1', pair_index: 0, new_fact_id: target, old_fact_id: idOf(KEPT, INLINE),
    direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' });
  return { id: target, bob };
}

describe('engine parity: the receipt of a whole fact purge', () => {
  for (const ledger of [false, true]) {
    parityTest(`purge_fact on a brain where the claim reaches facts, takes, proposals, an inline and a segmented page${ledger ? ' and the belief ledger' : ''} gives the same receipt`, {
      methods: ['putPage', 'insertFacts', 'addTakesBatch', 'insertTakeProposal', 'insertDecideProposal', 'listFactsSince', 'transaction',
        'loadPurgeTarget', 'planFactPurgeIds', 'planFactPurgeTakes', 'insertFactPurge', 'deletePurgedTakes', 'deletePurgedFacts', 'deletePurgeTakeProposals',
        'deletePurgeDecideProposals', 'listBeliefEventsForPurgeProbe', 'listFactContextsForPurgeProbe', 'countPurgeProbe', 'hasBeliefEvents'],
      // With the ledger, a Rust purge stops at the pre-write check on the belief-ledger raw sites (lane 3).
      ...(ledger ? { requires: 'raw_sql' as const } : {}),
      timeout: 600_000,
    }, async (engine, backend) => {
      await registerLocalWriter(engine, 'cli');
      if (ledger) await enableBeliefCoverage(engine, backend, SRC);
      const { id, bob } = await seed(engine);
      const ctx = contextFor(engine);
      const dry = await purge.handler(ctx, { id, all_subjects: true, dry_run: true }) as Record<string, unknown>;
      const run = await purge.handler(ctx, { id, all_subjects: true, confirm: dry.confirm_token, expected_revision: dry.expected_revision,
        request_id: REQUEST }).then((outcome) => ({ outcome: outcome as Record<string, unknown> }), (error: unknown) => ({ error }));
      if ('error' in run) {
        // Only the Rust arm with a ledger stops: before it journals or writes anything, naming the first ledger stop.
        const error = run.error as { code?: unknown; message?: string; detail?: string };
        expect({ backend, ledger, code: error.code }).toEqual({ backend: 'rust', ledger: true, code: 'engine_capability_missing' });
        expect(error.message).toContain('which needs derivedStreamSlugs (belief/purge.ts)');
        expect(error.detail).toContain('outcome=none');
        expect(error.detail).toContain('owner="lane 3 (rust-belief-purge)" due="5 PM PST Nov 28"');
        const facts = (await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 100 } as never)).map((f) => String(f.fact));
        expect(facts.filter((f) => f === CLAIM)).toHaveLength(2);
        throw run.error;
      }
      const done = run.outcome;
      expect(done.state).toBe('committed');
      const left = (await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 100 } as never)).map((f) => String(f.fact)).sort();
      const page = await engine.getPage(INLINE);
      return {
        dry: receipt(dry), done: receipt(done), left,
        // Only a Postgres brain hands the operator a VACUUM command.
        vacuumCommand: ('tell_user_to_run' in done) === (backend === 'postgres'),
        inline: { claim: page!.compiled_truth.includes(CLAIM), kept: page!.compiled_truth.includes(KEPT) },
        segmented: (await segmentedBody(engine, bob)).includes(CLAIM),
        chunks: (await engine.getChunks(INLINE, { includeUnsealed: true } as never)).map((c) => c.chunk_text.includes(CLAIM)),
      };
    });
  }
});
