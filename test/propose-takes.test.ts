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
import {
  runPhaseProposeTakes,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  isWellFormedEmptyExtraction,
  PROPOSE_TAKES_PROMPT_VERSION,
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
  type ProposeTakesExtractor,
  type ProposedTake,
} from '../src/core/cycle/propose-takes.ts';
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
      // SELECT idempotency check
      if (sql.includes('SELECT id FROM take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (existing.has(key)) return [{ id: 1 } as unknown as T];
        return [];
      }
      // INSERT into take_proposals — persist the idempotency key so a
      // subsequent cycle observes a cache hit, mirroring the real unique
      // index on (source_id, page_slug, content_hash, prompt_version).
      if (sql.includes('INSERT INTO take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        existing.add(`${sourceId}|${slug}|${ch}|${pv}`);
        return [];
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
