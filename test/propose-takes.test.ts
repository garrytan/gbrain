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
  EXTRACT_TAKES_PROMPT,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  isWellFormedEmptyExtraction,
  PROPOSE_TAKES_PROMPT_VERSION,
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
  resolveProposeTakesDeadlineMs,
  PROPOSE_TAKES_FALLBACK_DEADLINE_MS,
  MIN_PROPOSE_TAKES_BUDGET_MS,
  type ProposeTakesExtractor,
  type ProposedTake,
} from '../src/core/cycle/propose-takes.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { BudgetMeter } from '../src/core/cycle/budget-meter.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from '../src/core/cycle/base-phase.ts';
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
}): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const existing = opts.existingProposals ?? new Set<string>();

  const engine = {
    kind: 'pglite',
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
      // INSERT into take_proposals — persist the idempotency key so a
      // subsequent cycle observes a cache hit (the real unique index folds
      // md5(claim_text) in per #2138/v125, but the SELECT above matches any
      // row for the per-page 4-tuple), and return one row per successful
      // insert to satisfy RETURNING id.
      if (sql.includes('INSERT INTO take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        existing.add(`${sourceId}|${slug}|${ch}|${pv}`);
        return [{ id: captured.length } as unknown as T];
      }
      // Other writes — return nothing.
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

  // #4736 — the prompt's kind vocabulary and the parser's allowlist must
  // never diverge again: every kind token the prompt instructs the model to
  // emit must survive parsing with its provenance intact (NOT be silently
  // coerced to the default 'take').
  test('every kind token in EXTRACT_TAKES_PROMPT is accepted, not coerced (#4736)', () => {
    const kindLine = EXTRACT_TAKES_PROMPT.split('\n').find((l) => l.trim().startsWith('- kind'));
    expect(kindLine).toBeDefined();
    const tokens = [...kindLine!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    for (const token of tokens) {
      const out = parseExtractorOutput(
        JSON.stringify([{ claim_text: `claim of kind ${token}`, kind: token, holder: 'brain', weight: 0.6 }]),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.kind).toBe(token as ProposedTake['kind']);
    }
  });

  test('legacy prompt kinds (prediction/judgment) map onto the fence vocabulary (#4736)', () => {
    // Cached / old-model outputs still emit the pre-#4736 prompt vocabulary;
    // they classify deterministically instead of relying on blind coercion.
    const legacy: Array<[string, ProposedTake['kind']]> = [
      ['prediction', 'take'],
      ['judgment', 'take'],
    ];
    for (const [legacyKind, mapped] of legacy) {
      const out = parseExtractorOutput(
        JSON.stringify([{ claim_text: 'x', kind: legacyKind, holder: 'brain', weight: 0.5 }]),
      );
      expect(out[0]!.kind).toBe(mapped);
    }
  });

  test('kind matching is case/whitespace-insensitive (#4736)', () => {
    const out = parseExtractorOutput(
      JSON.stringify([
        { claim_text: 'a', kind: 'Bet', holder: 'brain', weight: 0.5 },
        { claim_text: 'b', kind: ' hunch ', holder: 'brain', weight: 0.5 },
      ]),
    );
    expect(out[0]!.kind).toBe('bet');
    expect(out[1]!.kind).toBe('hunch');
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

// ─── isWellFormedEmptyExtraction ────────────────────────────────────
// Guards the tombstone against permanently memoizing a transient parse
// failure as "no claims". Only a cleanly-parsed empty array counts as a
// genuine empty extraction; malformed/prose/truncated output must not.

describe('isWellFormedEmptyExtraction', () => {
  test('true for a clean empty array (the well-behaved "no claims" response)', () => {
    expect(isWellFormedEmptyExtraction('[]')).toBe(true);
    expect(isWellFormedEmptyExtraction('  []  ')).toBe(true);
    expect(isWellFormedEmptyExtraction('[   ]')).toBe(true);
  });

  test('true for a fenced empty array', () => {
    expect(isWellFormedEmptyExtraction('```json\n[]\n```')).toBe(true);
  });

  test('true for leading prose then an empty array', () => {
    expect(isWellFormedEmptyExtraction('No gradeable claims.\n\n[]')).toBe(true);
  });

  test('false for empty / whitespace output (transient, must retry)', () => {
    expect(isWellFormedEmptyExtraction('')).toBe(false);
    expect(isWellFormedEmptyExtraction('   \n  ')).toBe(false);
  });

  test('false for prose-only / non-JSON output (transient, must retry)', () => {
    expect(isWellFormedEmptyExtraction('There are no gradeable claims here.')).toBe(false);
    expect(isWellFormedEmptyExtraction('null')).toBe(false);
  });

  test('false for malformed / truncated JSON (transient, must retry)', () => {
    expect(isWellFormedEmptyExtraction('[')).toBe(false);
    expect(isWellFormedEmptyExtraction('[{"claim_text":"x"')).toBe(false);
  });

  test('false for a NON-empty array (has content — not an empty extraction)', () => {
    expect(isWellFormedEmptyExtraction('[{"claim_text":"x","kind":"take","holder":"brain","weight":0.5}]')).toBe(false);
    // Parseable but claim-less array is ambiguous garbage → not a genuine empty.
    expect(isWellFormedEmptyExtraction('[{"foo":"bar"}]')).toBe(false);
  });

  test('false for an empty object (model ignored the array-format instruction)', () => {
    expect(isWellFormedEmptyExtraction('{}')).toBe(false);
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

    // #3044: swallowed per-page failures no longer read as a clean 'ok' —
    // the phase continues but reports 'warn' with a warning count.
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('(1 warning(s))');
    expect(result.summary).not.toContain('aborted on');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(2);
    expect(details.proposals_inserted).toBe(1);
    expect(details.aborted_global_error).toBeUndefined();
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

    // #4482 three-way stop classification: a deadline cap is the extractor
    // working as designed (partial progress banked) — recorded as an
    // expected_limit, NOT a halt and NOT a completed round (same posture as
    // budget exhaustion). Params: $5 = halt, $8 = completed, $9 = expected_limit.
    const rollup = captured.find((c) => c.sql.includes('extract_rollup_7d'));
    expect(rollup).toBeDefined();
    expect(rollup!.params[4]).toBe(0); // halt_count delta (error halts only)
    expect(rollup!.params[7]).toBe(0); // round_completed delta
    expect(rollup!.params[8]).toBe(1); // expected_limit delta (deadline cap)
  });

  test('default deadline does not fire on a fast run', async () => {
    const pages = [buildPage({ slug: 'wiki/fast', body: 'quick page' })];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const details = result.details as Record<string, unknown>;
    // gbrain#4168: deadline_hit is now explicitly initialized false (was
    // undefined-when-unhit); the behavior pinned here is unchanged.
    expect(details.deadline_hit).toBe(false);
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

// ─── Empty-extraction memoization (idle-cost fix) ───────────────────
// A page that yields zero gradeable claims must still record an
// idempotency row, or every cycle re-spends an LLM call on unchanged
// prose. Regression guard for the "empty result never memoized" bug.

describe('runPhaseProposeTakes — empty extraction memoization', () => {
  test('zero-claim page writes a tombstone row (proposals_inserted stays 0)', async () => {
    const pages = [buildPage({ slug: 'test/embed-probe', body: '# probe\njust a test, nothing to grade.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [];
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    const details = result.details as Record<string, unknown>;
    expect(details.cache_misses).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    expect(details.tombstones_written).toBe(1);

    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(1);
    // Tombstone carries the sentinel claim_text and an out-of-queue status.
    expect(inserts[0]!.params[5]).toBe(EMPTY_EXTRACTION_TOMBSTONE_TEXT); // claim_text
    expect(inserts[0]!.sql).toContain("'rejected'");
  });

  test('unchanged zero-claim page is a cache hit next cycle (no repeat LLM call)', async () => {
    const pages = [buildPage({ slug: 'test/embed-probe', body: '# probe\njust a test, nothing to grade.' })];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };

    // Cycle 1: cache miss → LLM call → tombstone written.
    const r1 = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(extractorCalls).toBe(1);
    expect((r1.details as Record<string, unknown>).cache_misses).toBe(1);
    expect((r1.details as Record<string, unknown>).tombstones_written).toBe(1);

    // Cycle 2: same unchanged page → cache hit → extractor NOT called again.
    const r2 = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(extractorCalls).toBe(1); // the whole point: no re-spend
    expect((r2.details as Record<string, unknown>).cache_hits).toBe(1);
    expect((r2.details as Record<string, unknown>).cache_misses).toBe(0);
  });

  test('extractor error does NOT write a tombstone (page retried next cycle)', async () => {
    const pages = [buildPage({ slug: 'wiki/x', body: 'some prose' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => {
      throw new Error('LLM timeout');
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect((result.details as Record<string, unknown>).tombstones_written).toBe(0);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });
});

describe('resolveProposeTakesDeadlineMs — derived phase budget (#4168)', () => {
  const NOW = 1_000_000_000_000;

  test('no job deadline (gbrain dream CLI) falls back to the DERIVED constant, strictly under the anchor', () => {
    expect(resolveProposeTakesDeadlineMs(null, NOW)).toBe(PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
    expect(resolveProposeTakesDeadlineMs(undefined, NOW)).toBe(PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
  });

  test('generous job deadline is capped at the fallback (min, not raw remaining)', () => {
    const generous = NOW + 10 * 60 * 60 * 1000;
    expect(resolveProposeTakesDeadlineMs(generous, NOW)).toBe(PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
  });

  test('tight job deadline yields the FRACTION of remaining-minus-reserve (headroom for the downstream calibration phases)', () => {
    const tight = NOW + 10 * 60 * 1000; // 10min left
    const remaining = 10 * 60 * 1000 - CYCLE_DEADLINE_RESERVE_MS;
    // Red-team fix: un-fractioned, a small budget was consumed whole and
    // grade_takes/calibration_profile started inside the reserve.
    expect(resolveProposeTakesDeadlineMs(tight, NOW)).toBe(Math.floor(remaining * 0.8));
  });

  test('boundary: the skip line sits where the FRACTIONED budget crosses MIN (adversarial F4 — never clamp a sub-MIN fraction back up)', () => {
    // Non-null requires floor(remaining * 0.8) >= MIN, i.e. remaining >= MIN/0.8.
    const minRemaining = Math.ceil(MIN_PROPOSE_TAKES_BUDGET_MS / 0.8);
    const atBoundary = NOW + CYCLE_DEADLINE_RESERVE_MS + minRemaining;
    expect(resolveProposeTakesDeadlineMs(atBoundary, NOW)).toBe(MIN_PROPOSE_TAKES_BUDGET_MS);
    // remaining == MIN exactly → fractioned < MIN → honest skip (was: clamped
    // UP to MIN, handing propose_takes the whole window and starving the
    // downstream calibration phases into the reserve).
    const atMin = NOW + CYCLE_DEADLINE_RESERVE_MS + MIN_PROPOSE_TAKES_BUDGET_MS;
    expect(resolveProposeTakesDeadlineMs(atMin, NOW)).toBeNull();
    expect(resolveProposeTakesDeadlineMs(atBoundary - 2, NOW)).toBeNull();
    expect(resolveProposeTakesDeadlineMs(NOW - 1, NOW)).toBeNull();
  });
});

describe('deadlineAtMs threading through the phase (#4168)', () => {
  test('a sufficient deadlineAtMs does not skip (runtime governance is pinned by the resolver unit tests above)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/gov-a', body: 'page a' }),
      buildPage({ slug: 'wiki/gov-b', body: 'page b' }),
    ];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [];
    };
    // remaining = reserve + MIN + 10ms → resolved budget ≈ MIN... too large to
    // fire on a 30ms extractor. Instead use explicit-precedence coverage below
    // and pin GOVERNANCE structurally: resolved = min(remaining-reserve, fallback).
    // Here: a deadlineAtMs whose remaining-minus-reserve lands at 5ms cannot be
    // constructed above MIN, so governance-at-runtime is proven via the resolver
    // unit tests + the skip case below (the two reachable production shapes).
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      // Above the F4 boundary: non-null needs floor(remaining*0.8) >= MIN.
      deadlineAtMs: Date.now() + CYCLE_DEADLINE_RESERVE_MS + Math.ceil(MIN_PROPOSE_TAKES_BUDGET_MS / 0.8) + 10_000,
    });
    expect(result.status).not.toBe('skipped'); // enough budget → runs
  });

  test('an exhausted job budget returns status skipped with insufficient_cycle_budget and writes NO rollup row', async () => {
    const pages = [buildPage({ slug: 'wiki/never-scanned', body: 'x' })];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => { extractorCalls++; return []; };
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      deadlineAtMs: Date.now() + 1000, // ~1s left — far under MIN
    });
    expect(result.status).toBe('skipped');
    const details = result.details as Record<string, unknown>;
    expect(details.reason).toBe('insufficient_cycle_budget');
    expect(details.pages_scanned).toBe(0);
    expect(extractorCalls).toBe(0);
    expect(result.summary).toContain('raise the autopilot interval'); // operator hint is load-bearing
    // BEFORE any rollup write — an insufficient-budget run records neither a
    // halt nor a completed round (no_provider-skip parity).
    expect(captured.filter((c) => c.sql.includes('extract_rollup_7d'))).toHaveLength(0);
    expect(captured.filter((c) => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });

  test('explicit opts.deadlineMs still wins over deadlineAtMs (test-override precedence)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/prec-a', body: 'page a' }),
      buildPage({ slug: 'wiki/prec-b', body: 'page b' }),
    ];
    const { engine } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor,
      deadlineMs: 5, // explicit override
      deadlineAtMs: Date.now() + 60 * 60 * 1000, // generous job budget must NOT mask it
    });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(details.pages_scanned).toBe(1);
  });
});

// ─── Global-error halt (#3044) ──────────────────────────────────────
// A billing/auth/rate-limit failure is a whole-run condition: every
// remaining page would fail identically. Pre-fix, each page swallowed
// its failure into warnings[] and the phase completed with status 'ok'
// and a green summary — an exhausted spend limit left zero trace.

describe('runPhaseProposeTakes — global-error halt (#3044)', () => {
  test('claude-cli spend-limit blob halts as billing on the FIRST hit, status fail (zero successes)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a prose' }),
      buildPage({ slug: 'wiki/b', body: 'page b prose' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      throw new Error(
        'claude-cli exited 1: {"type":"result","subtype":"error_during_execution","api_error_status":429,"result":"you have reached your monthly spend limit"}',
      );
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    // Billing is deterministic — the loop broke on the FIRST failure.
    expect(extractorCalls).toBe(1);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(1);
    expect(details.aborted_global_error).toBe('billing');
    expect(details.llm_calls_succeeded).toBe(0);
    expect(details.llm_calls_failed).toBe(1);
    expect(details.halted).toBe(true);

    // Zero successful extractor calls → the whole LLM lane is down → 'fail'.
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('aborted on billing error after 1 page(s)');
    // Single combined warning line — no double counting of the same failure.
    expect(result.summary).toContain('(1 warning(s))');
    expect((details.warnings as string[])).toHaveLength(1);
    expect((details.warnings as string[])[0]).toContain('whole-run condition');
    expect((details.warnings as string[])[0]).toContain('extractor failed on wiki/a');

    // Rollup records a halt, not a completed round (same posture as budget
    // exhaustion / deadline). Params: $5 = halt delta, $8 = completed delta.
    const rollup = captured.find(c => c.sql.includes('extract_rollup_7d'));
    expect(rollup).toBeDefined();
    expect(rollup!.params[4]).toBe(1); // halt_count delta
    expect(rollup!.params[7]).toBe(0); // round_completed delta
  });

  test('bare 429s halt only after 3 CONSECUTIVE hits (transient bursts tolerated)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a prose' }),
      buildPage({ slug: 'wiki/b', body: 'page b prose' }),
      buildPage({ slug: 'wiki/c', body: 'page c prose' }),
      buildPage({ slug: 'wiki/d', body: 'page d prose' }),
    ];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    // Pages 1-2 warn and continue; the 3rd consecutive hit halts; page 4
    // never calls the LLM.
    expect(extractorCalls).toBe(3);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(3);
    expect(details.aborted_global_error).toBe('rate_limit');
    expect(details.llm_calls_succeeded).toBe(0);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('aborted on rate_limit error after 3 page(s)');
    // 2 per-page warnings + 1 combined abort line.
    expect(result.summary).toContain('(3 warning(s))');
    expect((details.warnings as string[])[2]).toContain('3 consecutive rate_limit errors');

    const rollup = captured.find(c => c.sql.includes('extract_rollup_7d'));
    expect(rollup!.params[4]).toBe(1); // halt_count delta
    expect(rollup!.params[7]).toBe(0); // round_completed delta
  });

  test('a success between 429s resets the streak (no halt)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a prose' }),
      buildPage({ slug: 'wiki/b', body: 'page b prose' }),
      buildPage({ slug: 'wiki/c', body: 'page c prose' }),
      buildPage({ slug: 'wiki/d', body: 'page d prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      // 429, 429, success, 429 — never 3 in a row.
      if (extractorCalls === 3) return [];
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalls).toBe(4);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(4);
    expect(details.aborted_global_error).toBeUndefined();
    expect(details.llm_calls_succeeded).toBe(1);
    expect(result.status).toBe('warn'); // 3 per-page warnings, but no halt
    expect(result.summary).not.toContain('aborted on');
  });

  test('a global halt AFTER a successful call reports warn, not fail (partial run)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a prose' }),
      buildPage({ slug: 'wiki/b', body: 'page b prose' }),
      buildPage({ slug: 'wiki/c', body: 'page c prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      if (extractorCalls === 1) {
        return [{ claim_text: 'first page worked', kind: 'take', holder: 'brain', weight: 0.5 }];
      }
      throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalls).toBe(2); // auth halts on the first hit
    const details = result.details as Record<string, unknown>;
    expect(details.aborted_global_error).toBe('auth');
    expect(details.llm_calls_succeeded).toBe(1);
    expect(details.proposals_inserted).toBe(1); // banked work stays
    expect(result.status).toBe('warn'); // partial run, not a total failure
    expect(result.summary).toContain('aborted on auth error after 2 page(s)');
  });

  test('non-global extractor error does NOT halt (remaining pages still processed)', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page a prose' }),
      buildPage({ slug: 'wiki/b', body: 'page b prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      if (extractorCalls === 1) throw new Error('fetch failed: ECONNRESET');
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalls).toBe(2);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(2);
    expect(details.aborted_global_error).toBeUndefined();
    expect(result.status).toBe('warn'); // still surfaced as a warning
    expect(result.summary).not.toContain('aborted on');
  });
});

// ─── #4102: cycle.propose_takes.enabled off switch ─────────────────

describe('cycle.propose_takes.enabled gate (#4102)', () => {
  function stubConfig(engine: BrainEngine, value: string | null): void {
    (engine as unknown as { getConfig: (k: string) => Promise<string | null> }).getConfig =
      async (k: string) => (k === 'cycle.propose_takes.enabled' ? value : null);
  }

  function countingExtractor(): { extractor: ProposeTakesExtractor; calls: () => number } {
    let n = 0;
    return {
      extractor: async () => { n += 1; return []; },
      calls: () => n,
    };
  }

  test('explicit false skips before any extractor call or DB write', async () => {
    const pages = [buildPage({ slug: 'wiki/gated', body: 'Some gated prose.' })];
    const { engine, captured } = buildMockEngine({ pages });
    stubConfig(engine, 'false');
    const { extractor, calls } = countingExtractor();
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(result.status).toBe('skipped');
    const details = result.details as Record<string, unknown>;
    expect(details.reason).toBe('disabled');
    expect(String(details.enable_hint)).toContain('cycle.propose_takes.enabled');
    expect(calls()).toBe(0);
    expect(captured.filter(c => c.sql.includes('take_proposals'))).toHaveLength(0);
  });

  test("'0' and 'off' also skip (isConfigTruthy semantics)", async () => {
    for (const value of ['0', 'off', 'no']) {
      const pages = [buildPage({ slug: 'wiki/gated2', body: 'prose' })];
      const { engine } = buildMockEngine({ pages });
      stubConfig(engine, value);
      const { extractor, calls } = countingExtractor();
      const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
      expect(result.status).toBe('skipped');
      expect(calls()).toBe(0);
    }
  });

  test('unset (null) = default ON: the phase runs', async () => {
    const pages = [buildPage({ slug: 'wiki/ungated', body: 'Some prose worth scanning.' })];
    const { engine } = buildMockEngine({ pages });
    stubConfig(engine, null);
    const { extractor, calls } = countingExtractor();
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(result.status).not.toBe('skipped');
    expect(calls()).toBe(1);
  });

  test("explicit 'true' runs", async () => {
    const pages = [buildPage({ slug: 'wiki/on', body: 'More prose.' })];
    const { engine } = buildMockEngine({ pages });
    stubConfig(engine, 'true');
    const { extractor, calls } = countingExtractor();
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(calls()).toBe(1);
  });

  test('once:true bypasses an explicit false for this run only', async () => {
    const pages = [buildPage({ slug: 'wiki/once', body: 'Once-run prose.' })];
    const { engine } = buildMockEngine({ pages });
    stubConfig(engine, 'false');
    const { extractor, calls } = countingExtractor();
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor, once: true });
    expect(result.status).not.toBe('skipped');
    expect(calls()).toBe(1);
  });
});
