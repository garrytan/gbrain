/**
 * v0.36.1.0 (T3) — propose_takes phase unit tests.
 *
 * Pure structural tests against a mock BrainEngine + injected extractor.
 * No real LLM gateway, no PGLite — the phase's contract is exercised through
 * the public surface and the engine's executeRaw/listPages stubs.
 *
 * Tests cover:
 *  - happy path: extracts proposals, writes via executeRaw with idempotency clause
 *  - cache hit path: skip pages already in take_proposals (F2 idempotency)
 *  - fence dedup: existing fence rows pass through to extractor as context
 *  - budget exhaustion mid-page: phase aborts cleanly with warn status
 *  - extractor parse failures: warning logged, phase continues
 *  - parseExtractorOutput unit tests for the raw JSON parser
 */

import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPhaseProposeTakes as runPhaseProposeTakesBase,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  PROPOSE_TAKES_PROMPT_VERSION,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let auditDir: string;

beforeAll(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-propose-takes-audit-'));
});

afterAll(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts?: Parameters<typeof runPhaseProposeTakesBase>[1],
) {
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => runPhaseProposeTakesBase(ctx, opts));
}

// ─── Mock engine ────────────────────────────────────────────────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}

interface CapturedPutPage {
  slug: string;
  page: Record<string, unknown>;
  opts?: { sourceId?: string };
}

function buildMockEngine(opts: {
  pages: Page[];
  existingProposals?: Set<string>; // composite-key strings already in take_proposals
}): { engine: BrainEngine; captured: CapturedSql[]; putPages: CapturedPutPage[] } {
  const captured: CapturedSql[] = [];
  const putPages: CapturedPutPage[] = [];
  const existing = opts.existingProposals ?? new Set<string>();

  const engine = {
    kind: 'pglite',
    async listPages() {
      return opts.pages;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      // SELECT idempotency check
      if (sql.includes('SELECT id FROM take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (existing.has(key)) return [{ id: 1 } as unknown as T];
        return [];
      }
      // INSERT — return nothing
      return [];
    },
    async putPage(slug: string, page: Record<string, unknown>, putOpts?: { sourceId?: string }) {
      putPages.push({ slug, page, opts: putOpts });
      return {
        id: putPages.length,
        slug,
        type: page.type ?? 'extract_receipt',
        title: page.title ?? slug,
        compiled_truth: page.compiled_truth ?? '',
        timeline: '',
        frontmatter: page.frontmatter ?? {},
        source_id: putOpts?.sourceId ?? 'default',
        created_at: new Date(),
        updated_at: new Date(),
      } as Page;
    },
  } as unknown as BrainEngine;

  return { engine, captured, putPages };
}

function buildPage(opts: { slug: string; body: string; sourceId?: string }): Page {
  return {
    id: 1,
    slug: opts.slug,
    type: 'analysis',
    title: opts.slug,
    compiled_truth: opts.body,
    timeline: '',
    frontmatter: {},
    source_id: opts.sourceId ?? 'default',
    created_at: new Date(),
    updated_at: new Date(),
  } as Page;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

// ─── parseExtractorOutput ───────────────────────────────────────────

describe('parseExtractorOutput', () => {
  test('parses a clean JSON array', () => {
    const raw = '[{"claim_text":"Cities send messages","kind":"take","holder":"brain","weight":0.65}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim_text).toBe('Cities send messages');
    expect(out[0]!.kind).toBe('take');
    expect(out[0]!.weight).toBe(0.65);
  });

  test('strips markdown code fence wrapping', () => {
    const raw = '```json\n[{"claim_text":"X","kind":"bet","holder":"world","weight":0.8}]\n```';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
  });

  test('accepts a single object as a one-element array', () => {
    const raw = '{"claim_text":"Y","kind":"hunch","holder":"brain","weight":0.4}';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('hunch');
  });

  test('skips leading prose before the JSON', () => {
    const raw = 'Here are the takes:\n\n[{"claim_text":"Z","kind":"take","holder":"brain","weight":0.5}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
  });

  test('returns [] on empty input', () => {
    expect(parseExtractorOutput('')).toEqual([]);
    expect(parseExtractorOutput('   ')).toEqual([]);
  });

  test('returns [] on malformed JSON without throwing', () => {
    expect(parseExtractorOutput('[not valid json')).toEqual([]);
    expect(parseExtractorOutput('completely unrelated prose')).toEqual([]);
  });

  test('drops rows without claim_text and rows over 500 chars', () => {
    const longClaim = 'x'.repeat(600);
    const raw = JSON.stringify([
      { kind: 'take', holder: 'brain', weight: 0.5 }, // no claim_text
      { claim_text: longClaim, kind: 'take', holder: 'brain', weight: 0.5 },
      { claim_text: 'valid', kind: 'take', holder: 'brain', weight: 0.5 },
    ]);
    expect(parseExtractorOutput(raw)).toHaveLength(1);
  });

  test('coerces unknown kind to "take" and clamps weight to [0,1]', () => {
    const raw = JSON.stringify([
      { claim_text: 'a', kind: 'unknown_kind', holder: 'brain', weight: 2.5 },
      { claim_text: 'b', kind: 'take', holder: 'brain', weight: -0.5 },
    ]);
    const out = parseExtractorOutput(raw);
    expect(out[0]!.kind).toBe('take');
    expect(out[0]!.weight).toBe(1);
    expect(out[1]!.weight).toBe(0);
  });

  test('preserves optional domain field', () => {
    const raw = '[{"claim_text":"X","kind":"take","holder":"brain","weight":0.5,"domain":"macro"}]';
    const out = parseExtractorOutput(raw);
    expect(out[0]!.domain).toBe('macro');
  });
});

// ─── contentHash ────────────────────────────────────────────────────

describe('contentHash', () => {
  test('produces deterministic SHA-256 hex', () => {
    const h1 = contentHash('hello world');
    const h2 = contentHash('hello world');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });

  test('different input produces different hash', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

// ─── hasCompleteFence ───────────────────────────────────────────────

describe('hasCompleteFence', () => {
  test('detects a well-formed fence', () => {
    const body = `# Page

<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | X | take | brain | 0.5 | 2026-01 | |
<!-- gbrain:takes:end -->

prose continues
`;
    expect(hasCompleteFence(body)).toBe(true);
  });

  test('returns false when fence is incomplete (begin only)', () => {
    expect(hasCompleteFence('<!-- gbrain:takes:begin -->\n| #')).toBe(false);
  });

  test('returns false when no fence at all', () => {
    expect(hasCompleteFence('just some prose')).toBe(false);
  });

  test('detects fence with triple-dash variant', () => {
    expect(hasCompleteFence('<!--- gbrain:takes:begin -->\n| # |\n<!--- gbrain:takes:end -->')).toBe(true);
  });
});

// ─── extractExistingTakesForDedup ───────────────────────────────────

describe('extractExistingTakesForDedup', () => {
  test('returns [] when no fence present', () => {
    expect(extractExistingTakesForDedup('plain prose')).toEqual([]);
  });

  test('parses active rows from a well-formed fence', () => {
    const body = `<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Cities send messages | take | brain | 0.65 | 2026-01 | essay |
| 2 | Y will happen | bet | garry | 0.8 | 2026-01 | |
<!-- gbrain:takes:end -->`;
    const out = extractExistingTakesForDedup(body);
    expect(out).toHaveLength(2);
    expect(out[0]!.claim).toBe('Cities send messages');
    expect(out[0]!.kind).toBe('take');
    expect(out[1]!.weight).toBe(0.8);
  });

  test('skips strikethrough rows', () => {
    const body = `<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight |
|---|-------|------|-----|--------|
| 1 | ~~stale claim~~ | take | brain | 0.5 |
| 2 | active claim | take | brain | 0.5 |
<!-- gbrain:takes:end -->`;
    const out = extractExistingTakesForDedup(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('active claim');
  });
});

// ─── Phase integration ──────────────────────────────────────────────

describe('runPhaseProposeTakes — phase integration', () => {
  test('happy path: scans pages, extracts proposals, writes via INSERT', async () => {
    const pages = [buildPage({ slug: 'wiki/concepts/network-effects', body: 'Marketplaces with cold-start liquidity always win.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Marketplaces with cold-start liquidity win', kind: 'bet', holder: 'brain', weight: 0.7, domain: 'market' },
    ];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(1);
    expect(details.cache_misses).toBe(1);
    expect(details.cache_hits).toBe(0);
    expect(details.proposals_inserted).toBe(1);

    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[5]).toBe('Marketplaces with cold-start liquidity win'); // claim_text
    expect(inserts[0]!.params[6]).toBe('bet'); // kind
    expect(inserts[0]!.params[9]).toBe('market'); // domain
  });

  test('cache hit: page already in take_proposals is skipped', async () => {
    const body = 'A page that was already processed.';
    const pages = [buildPage({ slug: 'wiki/old-page', body })];
    const ch = contentHash(body);
    const existing = new Set([`default|wiki/old-page|${ch}|${PROPOSE_TAKES_PROMPT_VERSION}`]);
    const { engine, captured } = buildMockEngine({ pages, existingProposals: existing });
    let extractorCalled = false;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalled = true;
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalled).toBe(false);
    const details = result.details as Record<string, unknown>;
    expect(details.cache_hits).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    // v0.42: extract rollup row UPSERTs on every phase invocation (best-
    // effort cache). Filter the assertion to take_proposals INSERTs only.
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });

  test('passes existing fence rows to extractor as dedup context (F2 fix)', async () => {
    const body = `# Page

<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Already captured claim | take | brain | 0.5 | 2026-01 | |
<!-- gbrain:takes:end -->

New prose appended here.`;
    const pages = [buildPage({ slug: 'wiki/existing', body })];
    const { engine } = buildMockEngine({ pages });
    let receivedExistingTakes: unknown;
    const extractor: ProposeTakesExtractor = async ({ existingTakes }) => {
      receivedExistingTakes = existingTakes;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(Array.isArray(receivedExistingTakes)).toBe(true);
    expect((receivedExistingTakes as Array<{ claim: string }>)[0]?.claim).toBe('Already captured claim');
  });

  test('extractor throw on a single page logs warning + phase continues', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page A prose' }),
      buildPage({ slug: 'wiki/b', body: 'page B prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let callCount = 0;
    const extractor: ProposeTakesExtractor = async () => {
      callCount++;
      if (callCount === 1) throw new Error('LLM timeout');
      return [{ claim_text: 'second page claim', kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(2);
    expect(details.proposals_inserted).toBe(1);
    expect((details.warnings as string[]).length).toBeGreaterThan(0);
    expect((details.warnings as string[])[0]).toContain('LLM timeout');
  });

  test('pages with empty compiled_truth are skipped silently (no extractor call)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/empty', body: '' }),
      buildPage({ slug: 'wiki/whitespace', body: '   \n   ' }),
      buildPage({ slug: 'wiki/real', body: 'has prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(extractorCalls).toBe(1);
  });

  test('oversize prompts are skipped before the extractor can spend', async () => {
    const pages = [
      buildPage({ slug: 'wiki/huge', body: 'oversized body '.repeat(1_000) }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    const ctx = buildCtx(engine);
    ctx.config = { 'cycle.propose_takes.max_prompt_tokens': 100 } as never;
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [{ claim_text: 'should not run', kind: 'take', holder: 'brain', weight: 0.5 }];
    };

    const result = await runPhaseProposeTakes(ctx, { extractor });
    const details = result.details as Record<string, unknown>;

    expect(extractorCalls).toBe(0);
    expect(result.status).toBe('ok');
    expect(details.cache_misses).toBe(1);
    expect(details.oversize_pages_skipped).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    expect((details.warnings as string[])[0]).toContain('prompt estimate');
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });

  test('skipPagesWithFence:true bypasses pages that already have a complete fence', async () => {
    const pages = [
      buildPage({
        slug: 'wiki/fenced',
        body: `<!-- gbrain:takes:begin -->\n| # | claim | kind | who | weight |\n|---|---|---|---|---|\n| 1 | x | take | brain | 0.5 |\n<!-- gbrain:takes:end -->\n\nprose`,
      }),
      buildPage({ slug: 'wiki/unfenced', body: 'plain prose only' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor, skipPagesWithFence: true });
    expect(extractorCalls).toBe(1);
  });

  test('proposal_run_id is stable across all proposals from one phase invocation', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a' }),
      buildPage({ slug: 'wiki/b', body: 'page b' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'x', kind: 'take', holder: 'brain', weight: 0.5 },
    ];
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(2);
    const runIdA = inserts[0]!.params[4];
    const runIdB = inserts[1]!.params[4];
    expect(runIdA).toBe(runIdB);
    expect(typeof runIdA).toBe('string');
    expect((runIdA as string).startsWith('propose-')).toBe(true);
  });

  test('receipt and rollup record active BudgetTracker spend', async () => {
    const pages = [buildPage({ slug: 'wiki/costed', body: 'This market will expand faster than consensus expects.' })];
    const { engine, captured, putPages } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => {
      const tracker = getCurrentBudgetTracker();
      expect(tracker).not.toBeNull();
      tracker!.record({
        modelId: 'anthropic:claude-sonnet-4-6',
        inputTokens: 1_000,
        outputTokens: 500,
        label: 'gateway.chat',
      });
      return [
        {
          claim_text: 'The market will expand faster than consensus expects',
          kind: 'take',
          holder: 'brain',
          weight: 0.6,
        },
      ];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      model: 'anthropic:claude-sonnet-4-6',
    });

    const costUsd = (result.details as Record<string, unknown>).cost_usd as number;
    expect(costUsd).toBeGreaterThan(0);
    expect(putPages).toHaveLength(1);
    expect((putPages[0]!.page.frontmatter as Record<string, unknown>).cost_usd).toBe(costUsd);
    expect(putPages[0]!.page.compiled_truth as string).toContain('Cost: $');

    const rollup = captured.find(c => c.sql.includes('INSERT INTO extract_rollup_7d'));
    expect(rollup).toBeDefined();
    expect(rollup!.params[3]).toBe(costUsd);
  });

  test('receipt omits model_id when the model came from gateway configuration', async () => {
    const pages = [buildPage({ slug: 'wiki/no-explicit-model', body: 'Configured model is not known to the receipt layer.' })];
    const { engine, putPages } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Configured model is not known to the receipt layer', kind: 'take', holder: 'brain', weight: 0.5 },
    ];

    await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect((putPages[0]!.page.frontmatter as Record<string, unknown>).model_id).toBeUndefined();
  });

  test('receipt cost is the phase delta when an outer BudgetTracker already has spend', async () => {
    const pages = [buildPage({ slug: 'wiki/outer-tracker', body: 'One more prediction worth proposing.' })];
    const { engine, putPages } = buildMockEngine({ pages });
    const outerTracker = new BudgetTracker({
      label: 'outer-test',
      maxCostUsd: 1,
      auditPath: join(auditDir, 'outer-test-budget.jsonl'),
    });
    outerTracker.record({
      modelId: 'anthropic:claude-sonnet-4-6',
      inputTokens: 10_000,
      outputTokens: 1_000,
      label: 'prior.phase',
    });
    const priorCost = outerTracker.snapshot().cumulativeCostUsd;
    const extractor: ProposeTakesExtractor = async () => {
      getCurrentBudgetTracker()!.record({
        modelId: 'anthropic:claude-sonnet-4-6',
        inputTokens: 1_000,
        outputTokens: 500,
        label: 'gateway.chat',
      });
      return [{ claim_text: 'One more prediction will matter', kind: 'take', holder: 'brain', weight: 0.55 }];
    };

    const result = await withBudgetTracker(outerTracker, () =>
      runPhaseProposeTakes(buildCtx(engine), { extractor, model: 'anthropic:claude-sonnet-4-6' }),
    );

    const costUsd = (result.details as Record<string, unknown>).cost_usd as number;
    expect(costUsd).toBeGreaterThan(0);
    expect(outerTracker.snapshot().cumulativeCostUsd).toBeGreaterThan(priorCost + costUsd - 0.0000001);
    expect(costUsd).toBeLessThan(priorCost);
    expect((putPages[0]!.page.frontmatter as Record<string, unknown>).cost_usd).toBe(costUsd);
  });

  test('BudgetExhausted from the gateway tracker stops the phase as warn', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a' }),
      buildPage({ slug: 'wiki/b', body: 'page b' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      throw new BudgetExhausted('cycle.propose_takes: cap reached', {
        reason: 'cost',
        spent: 0.01,
        cap: 0.01,
        modelId: 'anthropic:claude-sonnet-4-6',
      });
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const details = result.details as Record<string, unknown>;
    expect(result.status).toBe('warn');
    expect(details.budget_exhausted).toBe(true);
    expect((details.warnings as string[])[0]).toContain('budget exhausted');
    expect(calls).toBe(1);
  });

  test('default wrapper does not hard-fail unpriced chat models without an explicit cap', async () => {
    const pages = [buildPage({ slug: 'wiki/unpriced', body: 'Unpriced local model should still propose.' })];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => {
      getCurrentBudgetTracker()!.reserve({
        modelId: 'local-chat:unpriced-test-model',
        estimatedInputTokens: 100,
        maxOutputTokens: 50,
        kind: 'chat',
        label: 'gateway.chat',
      });
      return [{ claim_text: 'Unpriced local model should still propose', kind: 'take', holder: 'brain', weight: 0.5 }];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      model: 'local-chat:unpriced-test-model',
    });
    const details = result.details as Record<string, unknown>;
    expect(result.status).toBe('ok');
    expect(details.budget_exhausted).toBe(false);
    expect(details.proposals_inserted).toBe(1);
  });

  test('final-call BudgetTracker overage marks the phase halted', async () => {
    const pages = [buildPage({ slug: 'wiki/final-overage', body: 'Final call can exceed cap after usage records.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const tracker = new BudgetTracker({
      label: 'outer-tight',
      maxCostUsd: 0.000001,
      auditPath: join(auditDir, 'outer-tight-budget.jsonl'),
    });
    const extractor: ProposeTakesExtractor = async () => {
      try {
        getCurrentBudgetTracker()!.record({
          modelId: 'anthropic:claude-sonnet-4-6',
          inputTokens: 1_000,
          outputTokens: 500,
          label: 'gateway.chat',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExhausted);
      }
      return [{ claim_text: 'Final call can exceed cap', kind: 'take', holder: 'brain', weight: 0.6 }];
    };

    const result = await withBudgetTracker(tracker, () =>
      runPhaseProposeTakes(buildCtx(engine), { extractor, model: 'anthropic:claude-sonnet-4-6' }),
    );
    const details = result.details as Record<string, unknown>;
    expect(result.status).toBe('warn');
    expect(details.budget_exhausted).toBe(true);
    expect((details.warnings as string[]).at(-1)).toContain('budget exhausted');
    const rollup = captured.find(c => c.sql.includes('INSERT INTO extract_rollup_7d'));
    expect(rollup!.params[4]).toBe(1); // halt_delta
    expect(rollup!.params[7]).toBe(0); // round_completed_delta
  });

  test('default phase cap still halts final actual spend overage', async () => {
    const pages = [
      buildPage({ slug: 'wiki/default-cap-overage', body: 'A very expensive final call should halt.' }),
      buildPage({ slug: 'wiki/should-not-run', body: 'This page should not be submitted after the overage.' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      getCurrentBudgetTracker()!.record({
        modelId: 'anthropic:claude-sonnet-4-6',
        inputTokens: 2_000_000,
        outputTokens: 0,
        label: 'gateway.chat',
      });
      return [{ claim_text: 'A very expensive final call should halt', kind: 'take', holder: 'brain', weight: 0.6 }];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      model: 'anthropic:claude-sonnet-4-6',
    });
    const details = result.details as Record<string, unknown>;
    expect(result.status).toBe('warn');
    expect(details.budget_exhausted).toBe(true);
    expect((details.cost_usd as number)).toBeGreaterThan(5);
    expect(calls).toBe(1);
    const rollup = captured.find(c => c.sql.includes('INSERT INTO extract_rollup_7d'));
    expect(rollup!.params[4]).toBe(1);
    expect(rollup!.params[7]).toBe(0);
  });

  test('failed extractor calls check actual spend before continuing', async () => {
    const pages = [
      buildPage({ slug: 'wiki/failed-expensive', body: 'The failed call is expensive.' }),
      buildPage({ slug: 'wiki/should-not-run-after-failure-overage', body: 'This should not run.' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      getCurrentBudgetTracker()!.record({
        modelId: 'anthropic:claude-sonnet-4-6',
        inputTokens: 2_000_000,
        outputTokens: 0,
        label: 'gateway.chat.failed',
      });
      throw new Error('provider returned malformed JSON after usage');
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      model: 'anthropic:claude-sonnet-4-6',
    });
    const details = result.details as Record<string, unknown>;
    expect(result.status).toBe('warn');
    expect(details.budget_exhausted).toBe(true);
    expect(calls).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    const rollup = captured.find(c => c.sql.includes('INSERT INTO extract_rollup_7d'));
    expect(rollup!.params[4]).toBe(1);
    expect(rollup!.params[7]).toBe(0);
  });

  test('multi-source federated scope skips instead of writing default-source spend', async () => {
    const { engine, captured, putPages } = buildMockEngine({
      pages: [buildPage({ slug: 'wiki/a', body: 'federated page', sourceId: 'source-a' })],
    });
    const ctx = {
      ...buildCtx(engine),
      sourceId: undefined,
      auth: {
        token: 'test',
        clientId: 'client',
        scopes: ['read'],
        allowedSources: ['source-a', 'source-b'],
      },
    } as unknown as OperationContext;
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [{ claim_text: 'x', kind: 'take', holder: 'brain', weight: 0.5 }];
    };

    const result = await runPhaseProposeTakes(ctx, { extractor });
    expect(result.status).toBe('warn');
    expect((result.details as Record<string, unknown>).reason).toBe('federated_source_scope');
    expect(extractorCalls).toBe(0);
    expect(putPages).toHaveLength(0);
    expect(captured.find(c => c.sql.includes('INSERT INTO extract_rollup_7d'))).toBeUndefined();
  });

  test('unscoped local scope defaults receipts to default source', async () => {
    const { engine, putPages } = buildMockEngine({
      pages: [buildPage({ slug: 'wiki/unscoped-default', body: 'Unscoped local cycle should still propose.' })],
    });
    const ctx = {
      ...buildCtx(engine),
      sourceId: undefined,
    } as unknown as OperationContext;
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Unscoped local cycle should still propose', kind: 'take', holder: 'brain', weight: 0.5 },
    ];

    const result = await runPhaseProposeTakes(ctx, { extractor });
    expect(result.status).toBe('ok');
    expect(putPages).toHaveLength(1);
    expect(putPages[0]!.opts?.sourceId).toBe('default');
  });

  test('pulses yieldDuringPhase while scanning pages', async () => {
    const pages = [
      buildPage({ slug: 'wiki/p1', body: 'I think pricing resets in Q4.' }),
      buildPage({ slug: 'wiki/p2', body: 'I bet the founder hires a COO.' }),
    ];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [];
    let yieldCalls = 0;

    await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      yieldDuringPhase: async () => { yieldCalls += 1; },
    });

    expect(yieldCalls).toBe(2);
  });
});
