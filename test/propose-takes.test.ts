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

import { describe, test, expect } from 'bun:test';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import {
  runPhaseProposeTakes,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  PROPOSE_TAKES_PROMPT_VERSION,
  type ProposeTakesExtractor,
  type ProposedTake,
} from '../src/core/cycle/propose-takes.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { BudgetMeter } from '../src/core/cycle/budget-meter.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

// ─── Mock engine ────────────────────────────────────────────────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}

function buildMockEngine(opts: {
  pages: Page[];
  existingProposals?: Set<string>; // composite-key strings already in take_proposals
  config?: Record<string, string>; // engine.getConfig plane (models.tier.* etc.)
}): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const existing = opts.existingProposals ?? new Set<string>();

  const engine = {
    kind: 'pglite',
    async getConfig(key: string) {
      return opts.config?.[key] ?? null;
    },
    async listPages() {
      return opts.pages;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      // Narrow candidate-page projection (replaces listPages in the phase).
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return opts.pages.map((p) => ({
          slug: p.slug,
          source_id: p.source_id,
          compiled_truth: p.compiled_truth,
        })) as T[];
      }
      // SELECT idempotency check
      if (sql.includes('SELECT id FROM take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (existing.has(key)) return [{ id: 1 } as unknown as T];
        return [];
      }
      // INSERT ... RETURNING id — emulate a successful insert so the
      // honest proposals_inserted counter (counts RETURNING rows, not
      // attempts) sees the row land (#2138). Guarded on RETURNING id so the
      // zero-claim sentinel INSERT (no RETURNING) correctly returns [].
      if (sql.includes('INSERT INTO take_proposals') && sql.includes('RETURNING id')) {
        return [{ id: 1 } as unknown as T];
      }
      return [];
    },
  } as unknown as BrainEngine;

  return { engine, captured };
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

  test('strips <think> reasoning tags before parsing (MiniMax-M3, DeepSeek-R1)', () => {
    const raw = '<think>Analyzing the prose... I see several claims.</think>\n\n```json\n[{"claim_text":"X","kind":"take","holder":"brain","weight":0.5}]\n```';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim_text).toBe('X');
  });

  test('strips multiple <think> blocks', () => {
    const raw = '<think>First thought.</think>\n<tool_call>...</tool_call>\n<think>Second thought.</think>\n\n[{"claim_text":"Y","kind":"bet","holder":"brain","weight":0.7}]';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
  });

  test('handles trailing noise after JSON (leftover fences)', () => {
    const raw = '<think>done</think>\n```json\n[{"claim_text":"Z","kind":"take","holder":"brain","weight":0.6}]\n```\n';
    const out = parseExtractorOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim_text).toBe('Z');
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

  test('#2138: multi-claim page inserts every claim with a per-claim conflict target', async () => {
    const pages = [buildPage({ slug: 'wiki/essays/thesis', body: 'Two strong claims live here.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'Claim one', kind: 'take', holder: 'brain', weight: 0.6 },
      { claim_text: 'Claim two', kind: 'bet', holder: 'brain', weight: 0.8 },
    ];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) expect(insert.sql).toContain('md5(claim_text)');
    expect(inserts.map(i => i.params[5])).toEqual(['Claim one', 'Claim two']);
  });

  test('extractor model resolves through the tier chain (models.tier.reasoning honored)', async () => {
    // Pre-fix the phase hardcoded 'claude-sonnet-4-6' as the budget label and
    // stored model_id while the actual gateway call rode chat_model — on
    // tier-configured brains telemetry recorded the wrong model. The phase
    // now resolves once via resolveModel; the extractor hint and the stored
    // model_id must both reflect the tier override.
    const pages = [buildPage({ slug: 'wiki/concepts/tier-routing', body: 'Tier-routed models will win.' })];
    const { engine, captured } = buildMockEngine({
      pages,
      config: { 'models.tier.reasoning': 'anthropic:claude-sonnet-5' },
    });
    const seen: Array<string | undefined> = [];
    const extractor: ProposeTakesExtractor = async ({ modelHint }) => {
      seen.push(modelHint);
      return [{ claim_text: 'tier-routed models win', kind: 'bet', holder: 'brain', weight: 0.7 }];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(result.status).toBe('ok');
    expect(seen).toEqual(['anthropic:claude-sonnet-5']); // chat call gets the FULL string
    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts[0]!.params[11]).toBe('anthropic:claude-sonnet-5'); // stored model_id carries the same full string
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

  test('phase deadline breaks the page loop with a partial result (deadline_hit)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/slow-a', body: 'page a' }),
      buildPage({ slug: 'wiki/slow-b', body: 'page b' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return [{ claim_text: 'x', kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    // 5ms deadline: page 1 processes (elapsed 0 at check), the 10ms extractor
    // call pushes elapsed past the cap, page 2 is never scanned.
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor, deadlineMs: 5 });

    expect(result.status).toBe('warn');
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(details.pages_scanned).toBe(1);
    expect(extractorCalls).toBe(1);
    expect((details.warnings as string[]).some(w => w.includes('phase deadline hit'))).toBe(true);

    // Rollup records the deadline break as a halt, not a completed round
    // (same posture as budget exhaustion). Params: $5 = halt, $8 = completed.
    const rollup = captured.find((c) => c.sql.includes('extract_rollup_7d'));
    expect(rollup).toBeDefined();
    expect(rollup!.params[4]).toBe(1); // halt_count delta
    expect(rollup!.params[7]).toBe(0); // round_completed delta
  });

  test('default deadline does not fire on a fast run', async () => {
    const pages = [buildPage({ slug: 'wiki/fast', body: 'quick page' })];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBeUndefined();
    expect(details.pages_scanned).toBe(1);
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

  test('records the configured gateway chat model when no phase model override is passed', async () => {
    configureGateway({
      chat_model: 'openai:gpt-5',
      env: { OPENAI_API_KEY: 'test-key' },
    });
    try {
      const pages = [buildPage({ slug: 'wiki/model-default', body: 'configured model should be recorded' })];
      const { engine, captured } = buildMockEngine({ pages });
      const extractor: ProposeTakesExtractor = async () => [
        { claim_text: 'configured model should be recorded', kind: 'take', holder: 'brain', weight: 0.5 },
      ];

      await runPhaseProposeTakes(buildCtx(engine), { extractor });

      const insert = captured.find(c => c.sql.includes('INSERT INTO take_proposals'));
      expect(insert).toBeDefined();
      expect(insert!.params[11]).toBe('openai:gpt-5');
    } finally {
      resetGateway();
    }
  });

  test('keeps nested provider model ids intact for budget checks and proposal records', async () => {
    configureGateway({
      chat_model: 'openrouter:anthropic/claude-sonnet-4-6',
      env: { OPENROUTER_API_KEY: 'test-key' },
    });
    try {
      const pages = [buildPage({ slug: 'wiki/openrouter-model', body: 'nested provider model should stay intact' })];
      const { engine, captured } = buildMockEngine({ pages });
      const extractor: ProposeTakesExtractor = async () => [
        { claim_text: 'nested provider model should stay intact', kind: 'take', holder: 'brain', weight: 0.5 },
      ];

      const result = await runPhaseProposeTakes(buildCtx(engine), {
        extractor,
        meter: new BudgetMeter({ budgetUsd: 0.000001, phase: 'propose_takes' }),
      });

      expect(result.status).toBe('ok');
      expect(result.details.budget_exhausted).toBe(false);
      const insert = captured.find(c => c.sql.includes('INSERT INTO take_proposals'));
      expect(insert).toBeDefined();
      expect(insert!.params[11]).toBe('openrouter:anthropic/claude-sonnet-4-6');
    } finally {
      resetGateway();
    }
  });

  test('default extractor skips cleanly when the Anthropic chat model has no key', async () => {
    // Empty GBRAIN_HOME so hasAnthropicKey's config-file fallback can't find
    // the operator's real key.
    await withEnv({ GBRAIN_HOME: emptyHome(), ANTHROPIC_API_KEY: undefined }, async () => {
      configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
      try {
        const { engine, captured } = buildMockEngine({
          pages: [buildPage({ slug: 'wiki/a', body: 'claim-ish prose' })],
        });
        const result = await runPhaseProposeTakes(buildCtx(engine));

        expect(result.status).toBe('skipped');
        expect((result.details as Record<string, unknown>).reason).toBe('no_provider');
        // Skips BEFORE touching the engine — no page scan, no cache probes.
        expect(captured).toHaveLength(0);
      } finally {
        resetGateway();
      }
    });
  });

  test('an injected extractor is never gated on provider availability', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome(), ANTHROPIC_API_KEY: undefined }, async () => {
      configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
      try {
        const { engine } = buildMockEngine({
          pages: [buildPage({ slug: 'wiki/b', body: 'still processed' })],
        });
        const extractor: ProposeTakesExtractor = async () => [];
        const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

        expect(result.status).toBe('ok');
        expect((result.details as Record<string, unknown>).pages_scanned).toBe(1);
      } finally {
        resetGateway();
      }
    });
  });

  test('loads proposal candidates with a narrow page projection', async () => {
    const pages = [buildPage({ slug: 'wiki/narrow', body: 'A narrow projection avoids unrelated page columns.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [];
    await runPhaseProposeTakes(buildCtx(engine), { extractor });

    const pageSelect = captured.find(c => c.sql.includes('FROM pages'));
    expect(pageSelect).toBeDefined();
    expect(pageSelect!.sql).toContain('SELECT slug, source_id, compiled_truth');
    expect(pageSelect!.sql).not.toContain('*');
    // Scalar sourceId scope from ctx binds as a plain equality param.
    expect(pageSelect!.params[0]).toBe('default');
  });

  test('narrow projection: federated sourceIds beat scalar sourceId', async () => {
    const { engine, captured } = buildMockEngine({ pages: [] });
    const extractor: ProposeTakesExtractor = async () => [];
    const ctx = {
      ...buildCtx(engine),
      auth: { allowedSources: ['team-a', 'team-b'] },
    } as OperationContext;
    await runPhaseProposeTakes(ctx, { extractor });

    const pageSelect = captured.find(c => c.sql.includes('FROM pages'));
    expect(pageSelect).toBeDefined();
    expect(pageSelect!.sql).toContain('source_id = ANY(');
    expect(pageSelect!.params[0]).toEqual(['team-a', 'team-b']);
  });
});
