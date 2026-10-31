/** #7299: operator rejections survive unrelated page edits and prompt changes.
 * Real queue writes on both engines; injected extractors intentionally ignore
 * the rejection context, so prompt compliance alone cannot pass this suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { listPendingProposals, rejectProposal } from '../src/core/take-proposals.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CLAIM = 'The example market will grow next year';
const fresh = (claim_text = CLAIM) => ({ claim_text, kind: 'take' as const, holder: 'brain', weight: 0.6 });

for (const backend of testBackends()) describe(`#7299 rejected proposals (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'pglite') {
      const local = new PGLiteEngine();
      await local.connect({});
      await local.initSchema();
      engine = local;
      close = () => local.disconnect();
    } else {
      const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = fixture.engine;
      close = fixture.close;
    }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  function ctx(sourceId: string): OperationContext {
    return { engine, sourceId, config: {} as never, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } as never };
  }
  async function page(source: string, slug: string, body = 'An essay predicts market growth.') {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [source]);
    await engine.putPage(slug, { title: slug, type: 'analysis', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: source });
  }
  async function run(source: string, extractor: ProposeTakesExtractor, promptVersion = 'rejected-test-v1') {
    const result = await runPhaseProposeTakes(ctx(source), { extractor, promptVersion, skipPagesWithFence: false });
    expect(result.error?.message ?? '').toBe('');
    expect(result.status).not.toBe('fail');
    return result.details;
  }
  async function rejected(source: string, slug: string) {
    await page(source, slug);
    await run(source, async () => [fresh()]);
    const [proposal] = await listPendingProposals(engine, { sourceId: source });
    expect(proposal).toBeDefined();
    await rejectProposal({ engine, sourceId: source }, proposal!.id);
    return proposal!.id;
  }

  test('edited pages keep rejected claims out but admit genuinely new claims across prompt versions', async () => {
    const source = 'rejection-mixed', slug = 'wiki/thesis';
    const id = await rejected(source, slug);
    await page(source, slug, 'An essay predicts market growth.\n\nA new link and fact fence were added.');
    let context: unknown;
    const details = await run(source, async input => {
      context = input.rejectedClaims;
      return [fresh(), fresh('A different market will shrink next year')];
    }, 'rejected-test-v2');
    expect(context).toEqual([CLAIM]);
    expect(details.proposals_inserted).toBe(1);
    expect((await listPendingProposals(engine, { sourceId: source })).map(p => p.claim_text)).toEqual(['A different market will shrink next year']);
    const [history] = await engine.executeRaw<{ status: string; acted_by: string }>('SELECT status, acted_by FROM take_proposals WHERE id = $1', [id]);
    expect(history).toEqual({ status: 'rejected', acted_by: 'cli' });
  }, 120_000);

  test('an all-rejected response is memoized, without poisoning later edited prose', async () => {
    const source = 'rejection-empty', slug = 'wiki/thesis';
    await rejected(source, slug);
    await page(source, slug, 'The same prose with an unrelated edit.');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => { calls++; return [fresh()]; };
    const first = await run(source, extractor);
    expect(first.proposals_inserted).toBe(0);
    expect(first.tombstones_written).toBe(1);
    expect((await run(source, extractor)).cache_hits).toBe(1);
    expect(calls).toBe(1);
    expect(await listPendingProposals(engine, { sourceId: source })).toEqual([]);
    await page(source, slug, 'A later edit introduces a genuinely different prediction.');
    expect((await run(source, async () => [fresh('A new prediction')])).proposals_inserted).toBe(1);
  }, 120_000);

  test('rejection identity is source and page scoped; case-different claims are not silently folded', async () => {
    const source = 'rejection-scope', slug = 'wiki/thesis';
    await rejected(source, slug);
    await page(source, 'wiki/sibling');
    const other = 'rejection-other';
    await page(other, slug);
    expect((await run(source, async () => [fresh()])).proposals_inserted).toBe(1);
    expect((await run(other, async () => [fresh()])).proposals_inserted).toBe(1);
    await page(source, slug, 'Changed prose with a case-sensitive claim.');
    expect((await run(source, async () => [fresh(CLAIM.toUpperCase())])).proposals_inserted).toBe(1);
  }, 120_000);

  test('a rejection committed while the model runs is honored at queue admission', async () => {
    const source = 'rejection-race', slug = 'wiki/thesis';
    await page(source, slug);
    await run(source, async () => [fresh()]);
    const [proposal] = await listPendingProposals(engine, { sourceId: source });
    await page(source, slug, 'The essay was edited while its old proposal awaits review.');
    expect((await run(source, async () => {
      await rejectProposal({ engine, sourceId: source }, proposal!.id);
      return [fresh()];
    })).proposals_inserted).toBe(0);
    expect(await listPendingProposals(engine, { sourceId: source })).toEqual([]);
    expect((await run(source, async () => { throw new Error('must be cached'); })).cache_hits).toBe(1);
  }, 120_000);

  test('automatic empty outcomes are not presented as human rejections; failed extracts remain retryable', async () => {
    const source = 'rejection-retry', slug = 'wiki/thesis';
    await page(source, slug);
    await run(source, async () => []);
    await page(source, slug, 'Edited empty page with a new prediction.');
    let context: unknown;
    await run(source, async input => {
      context = input.rejectedClaims;
      throw new Error('transient extractor failure');
    });
    expect(context).toEqual([]);
    const recovered = await run(source, async () => [fresh()]);
    expect(recovered.cache_misses).toBe(1);
    expect(recovered.proposals_inserted).toBe(1);
  }, 120_000);

  test('bounded prompt history cannot release an older operator rejection', async () => {
    const source = 'rejection-bounded', slug = 'wiki/thesis';
    await rejected(source, slug);
    // Simulate an operator who has triaged many later versions of this page.
    await engine.executeRaw(
      `INSERT INTO take_proposals
        (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
         claim_text, kind, holder, weight, model_id, status, acted_at, acted_by)
       SELECT $1, $2, 'later-body', 'later-prompt', 'later-run',
         'Later rejected claim ' || n, 'take', 'brain', 0.6, 'test', 'rejected', now(), 'cli'
       FROM generate_series(1, 101) AS n`, [source, slug]);
    await page(source, slug, 'An edit after more than a hundred reviewed claims.');
    let context: string[] | undefined;
    const details = await run(source, async input => {
      context = input.rejectedClaims;
      return [fresh()];
    });
    expect(context).toHaveLength(100);
    expect(context).not.toContain(CLAIM);
    expect(details.proposals_inserted).toBe(0);
    expect(details.tombstones_written).toBe(1);
    expect(await listPendingProposals(engine, { sourceId: source })).toEqual([]);
  }, 120_000);
});
