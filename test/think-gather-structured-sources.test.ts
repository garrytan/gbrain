/**
 * Structured evidence must survive `runGather`.
 *
 * Two independent cuts were silently shrinking the evidence set think hands
 * to synthesis, and both fell hardest on terse, structurally-distinct pages
 * (calendar events, mail threads) sitting behind long, lexically rich ones
 * (meeting notes, chat transcripts):
 *
 *   1. The hybrid legs left `tokenBudget` unpinned, so the resolved search
 *      mode's budget (balanced 12K, conservative 4K) truncated the gather
 *      AFTER the limit slice. `enforceTokenBudget` is a greedy top-down
 *      packer, so the expensive head kept every slot and the cheap tail was
 *      dropped whole — a gather that asked for 40 pages returned a handful.
 *   2. The temporal-window date floor was appended BEHIND up to
 *      `gatherLimit * 4` hybrid rows and then cut at `gatherLimit`, so it
 *      only delivered anything when hybrid happened to under-return. It was
 *      a backfill, not a floor.
 *
 * Both are deterministic and neither is fixed by turning query expansion on
 * (equal-weight expansion costs small-k recall — see
 * docs/architecture/RETRIEVAL.md).
 *
 * A third cut sat in front of the gather: the `synthesize` verb scoped an
 * unqualified trusted-local call to its single resolved source, while
 * `search`/`query` span the transport-computed federated set. The last
 * describe pins the verb end-to-end (unit matrix: source-scope-resolver).
 *
 * Real PGLite + the real `hybridSearch`; no mock.module, no provider calls
 * (the chat transport is stubbed and provider keys are stripped by preload).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGather } from '../src/core/think/gather.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

/** April 2026, the window every windowed case below uses. */
const WINDOW = { startMs: Date.UTC(2026, 3, 1), endMs: Date.UTC(2026, 3, 30, 23, 59, 59, 999) };

/**
 * Seed one searchable page. `putPage` alone leaves the text projection
 * unsealed (search hides it) and `effective_date` NULL (the window floor's
 * `listPages` bound can't see it), so both are set explicitly here.
 */
async function seed(opts: {
  slug: string;
  title: string;
  body: string;
  /** Day of April 2026 for `effective_date`. Omit to leave the page undated. */
  day?: number;
  sourceId?: string;
  frontmatter?: Record<string, unknown>;
}): Promise<void> {
  const sourceId = opts.sourceId ?? 'default';
  await engine.putPage(opts.slug, {
    type: 'note', title: opts.title, compiled_truth: opts.body,
    timeline: '', frontmatter: opts.frontmatter ?? {},
  }, { sourceId });
  await installFixtureChunks(
    engine, opts.slug,
    [{ chunk_index: 0, chunk_text: opts.body, chunk_source: 'compiled_truth' }],
    { sourceId },
  );
  if (opts.day !== undefined) {
    await engine.executeRaw(
      `UPDATE pages SET effective_date = $3::timestamptz, effective_date_source = 'event_date'
       WHERE slug = $1 AND source_id = $2`,
      [opts.slug, sourceId, `2026-04-${String(opts.day).padStart(2, '0')}T12:00:00.000Z`],
    );
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('neighbor', 'neighbor', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`, [],
  );

  // --- Case 1 corpus: long pages that monopolize a token budget, plus terse
  // structured pages that cost almost nothing and rank behind them.
  const long = (n: number) =>
    `Quarterly pipeline review notes for acme-example. `.repeat(220) + ` session ${n}`;
  for (let i = 0; i < 12; i++) {
    await seed({
      slug: `meetings/2026-04-${String(i + 1).padStart(2, '0')}`,
      title: `Pipeline review ${i + 1} acme-example`,
      body: long(i),
    });
  }
  for (let i = 0; i < 4; i++) {
    await seed({
      slug: `work-mail/thread-${i + 1}`,
      title: 'acme-example pipeline',
      body: `acme-example pipeline review note ${i + 1}.`,
    });
  }

  // --- Case 2 corpus: enough cheap in-window matches to fill the gather on
  // their own, so the date floor has to be reserved slots to deliver at all.
  for (let i = 0; i < 45; i++) {
    await seed({
      slug: `syncs/note-${i + 1}`,
      title: `widget-co planning sync ${i + 1}`,
      body: `widget-co planning sync agenda item ${i + 1}.`,
      day: (i % 28) + 1,
    });
  }
  // In-window, but zero lexical overlap with the question: only the floor
  // can reach it.
  await seed({
    slug: 'work-mail/quiet-thread',
    title: 'quarterly invoice receipt',
    body: 'Attachment archived for the finance folder.',
    day: 14,
  });
  // Scope controls, all in-window and all unreachable by the question.
  await seed({
    slug: 'work-mail/other-source-thread',
    title: 'neighbor brain receipt',
    body: 'Attachment archived in a source the caller was never granted.',
    day: 15, sourceId: 'neighbor',
  });
  await seed({
    slug: 'work-mail/private-thread',
    title: 'restricted receipt',
    body: 'Attachment archived under a restricted visibility marker.',
    day: 16, frontmatter: { visibility: 'private' },
  });
  await seed({
    slug: 'work-mail/fenced-thread',
    title: 'fenced receipt',
    body: [
      'Attachment archived above the protected fence.',
      FACTS_FENCE_BEGIN,
      'PROTECTED-FENCE-PAYLOAD',
      FACTS_FENCE_END,
    ].join('\n'),
    day: 17,
  });
  // In-window but deliberately unsealed: listPages can enumerate it, while
  // untrusted search must not expose its canonical body until a safe text
  // projection has been installed.
  await engine.putPage('work-mail/unsealed-thread', {
    type: 'note', title: 'unsealed receipt',
    compiled_truth: 'UNSEALED-CANONICAL-PAYLOAD', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.executeRaw(
    `UPDATE pages SET effective_date = $3::timestamptz, effective_date_source = 'event_date'
     WHERE slug = $1 AND source_id = $2`,
    ['work-mail/unsealed-thread', 'default', '2026-04-18T12:00:00.000Z'],
  );

  // Same slugs in different sources are distinct canonical pages. The
  // trusted-local federated window must retain both identities.
  await seed({
    slug: 'shared/window-collision', title: 'default collision record',
    body: 'default-source-collision-token', day: 19,
  });
  await seed({
    slug: 'shared/window-collision', title: 'neighbor collision record',
    body: 'neighbor-source-collision-token', day: 20, sourceId: 'neighbor',
  });

  // The raw row deliberately retains an active claim while the durable
  // withdrawal ledger makes the canonical snapshot forgotten. Re-seal the
  // projection from that canonical snapshot: a remote temporal floor must
  // never bypass the overlay and resurrect the raw claim.
  const withdrawnClaim = 'withdrawn-sentinel prefers obsolete-widget';
  const withdrawnBody = `Public introduction.\n\n${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | ${withdrawnClaim} | fact | 1.0 | world | medium | 2026-01-01 | | test | |\n${FACTS_FENCE_END}`;
  await seed({
    slug: 'work-mail/withdrawn-thread', title: 'withdrawn receipt',
    body: withdrawnBody, day: 21,
  });
  await engine.executeRaw(
    `INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
     VALUES ('default','world',gbrain_fact_fingerprint($1)) ON CONFLICT DO NOTHING`,
    [withdrawnClaim],
  );
  const canonical = await engine.getPage('work-mail/withdrawn-thread', { sourceId: 'default' });
  expect(canonical).not.toBeNull();
  await installFixtureChunks(engine, 'work-mail/withdrawn-thread', [
    { chunk_index: 0, chunk_text: canonical!.compiled_truth, chunk_source: 'compiled_truth' },
  ], { sourceId: 'default' });
}, 300_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('think gather keeps structured evidence', () => {
  test('the plain leg is not truncated by the search mode token budget', async () => {
    const gather = await runGather(engine, {
      question: 'acme-example pipeline review',
      remote: false,
    });

    const structured = gather.pages.filter(page => page.slug.startsWith('work-mail/thread-'));
    // Pre-fix: the balanced bundle's 12K budget was spent by the first few
    // long pages, so gather returned 4 rows and none of the terse ones —
    // synthesis then reported the structured evidence as absent.
    expect(structured.map(page => page.slug).sort()).toEqual([
      'work-mail/thread-1', 'work-mail/thread-2', 'work-mail/thread-3', 'work-mail/thread-4',
    ]);
    expect(gather.pages.length).toBe(16);
  }, 120_000);

  test('the windowed date floor keeps reserved slots when hybrid fills the gather', async () => {
    const gather = await runGather(engine, {
      question: 'widget-co planning sync',
      window: WINDOW,
      remote: false,
    });

    // Pre-fix: 45 hybrid rows filled every slot and the floor's rows were
    // sliced off, so an in-window page hybrid cannot reach never arrived.
    expect(gather.pages.some(page => page.slug === 'work-mail/quiet-thread')).toBe(true);
    // The reservation moves the cut point; it never widens the gather.
    expect(gather.pages.length).toBeLessThanOrEqual(40);
    // Hybrid still owns the large majority of the budget.
    expect(gather.pages.filter(page => page.slug.startsWith('syncs/')).length)
      .toBeGreaterThanOrEqual(30);
  }, 120_000);

  test('an under-returning hybrid leg still fills the gather from the floor', async () => {
    // Non-regression for the reservation arithmetic: when hybrid returns
    // fewer rows than the reserve would have withheld, the floor tail takes
    // every remaining slot exactly as the pre-fix append did.
    const gather = await runGather(engine, {
      question: 'nonexistent-token-xyzzy',
      window: WINDOW,
      remote: false,
    });

    expect(gather.pages.length).toBe(40);
    expect(gather.pages.some(page => page.slug === 'work-mail/quiet-thread')).toBe(true);
  }, 120_000);

  test('reserved floor rows stay inside the caller source grant', async () => {
    const gather = await runGather(engine, {
      question: 'widget-co planning sync',
      window: WINDOW,
      sourceIds: ['default'],
      remote: false,
    });

    expect(gather.pages.some(page => page.slug === 'work-mail/quiet-thread')).toBe(true);
    expect(gather.pages.some(page => page.slug === 'work-mail/other-source-thread')).toBe(false);
    expect(gather.pages.every(page => (page.source_id ?? 'default') === 'default')).toBe(true);
  }, 120_000);

  test('reserved floor rows stay private-filtered and fence-sanitized for remote callers', async () => {
    const gather = await runGather(engine, {
      question: 'widget-co planning sync',
      window: WINDOW,
      sourceIds: ['default'],
      excludePrivate: true,
      remote: true,
    });

    expect(gather.pages.some(page => page.slug === 'work-mail/private-thread')).toBe(false);
    // The floor renders canonical page bodies rather than chunks, so its
    // remote output goes through the same protected-fence boundary
    // (`sanitizeRemoteBody`) that chunk creation enforces: fenced content is
    // re-rendered down to world-visible rows, never echoed verbatim.
    const fenced = gather.pages.find(page => page.slug === 'work-mail/fenced-thread');
    expect(fenced).toBeDefined();
    expect(fenced!.chunk_text).not.toContain('PROTECTED-FENCE-PAYLOAD');
    expect(fenced!.chunk_text).toContain('Attachment archived above the protected fence.');
    expect(gather.pages.some(page => page.slug === 'work-mail/unsealed-thread')).toBe(false);
    expect(gather.pages.some(page => page.chunk_text.includes('UNSEALED-CANONICAL-PAYLOAD'))).toBe(false);
    const withdrawn = gather.pages.find(page => page.slug === 'work-mail/withdrawn-thread');
    expect(withdrawn).toBeDefined();
    expect(withdrawn!.chunk_text).not.toContain('withdrawn-sentinel prefers obsolete-widget');
  }, 120_000);

  test('windowed federated gather keeps same-slug pages from distinct sources', async () => {
    const gather = await runGather(engine, {
      question: 'source-collision-token',
      window: WINDOW,
      sourceIds: ['default', 'neighbor'],
      remote: false,
    });

    const collisions = gather.pages
      .filter(page => page.slug === 'shared/window-collision')
      .map(page => page.source_id)
      .sort();
    expect(collisions).toEqual(['default', 'neighbor']);
  }, 120_000);
});

describe('synthesize gathers from the trusted-local federated set', () => {
  function localCtx(localFederatedSourceIds?: string[]): OperationContext {
    return {
      engine,
      config: {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      ...(localFederatedSourceIds ? { localFederatedSourceIds } : {}),
    } as unknown as OperationContext;
  }

  /** Non-JSON prose forces the extractive fallback, whose sources ARE the gather. */
  const refusal = async (): Promise<ChatResult> => ({
    text: 'I cannot help with that request.',
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  } as ChatResult);

  async function synthesize(ctx: OperationContext): Promise<{ sources: string[]; pages_gathered: number }> {
    __setChatTransportForTests(refusal);
    try {
      return await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
        operationsByName['synthesize'].handler(ctx, { question: 'orbit-example rollout' }),
      ) as { sources: string[]; pages_gathered: number };
    } finally {
      __setChatTransportForTests(null);
    }
  }

  beforeAll(async () => {
    await seed({
      slug: 'notes/orbit-plan', title: 'orbit-example rollout plan',
      body: 'orbit-example rollout plan drafted in the planning doc.',
    });
    await seed({
      slug: 'work-mail/orbit-thread', title: 'orbit-example rollout confirmation',
      body: 'orbit-example rollout confirmed by the customer over mail.',
      sourceId: 'neighbor',
    });
  });

  test('an unqualified local call reaches pages in every federated source', async () => {
    const body = await synthesize(localCtx(['default', 'neighbor']));
    // Pre-fix: the verb hand-mapped `sourceScopeOpts`, gathered from
    // 'default' alone, and the mail page never reached synthesis.
    expect(body.sources).toContain('work-mail/orbit-thread');
    expect(body.sources).toContain('notes/orbit-plan');
    expect(body.pages_gathered).toBe(2);
  }, 120_000);

  test('without a transport-computed federated set the call stays on its own source', async () => {
    const body = await synthesize(localCtx());
    expect(body.sources).toEqual(['notes/orbit-plan']);
    expect(body.pages_gathered).toBe(1);
  }, 120_000);
});
