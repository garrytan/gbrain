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
  parseExtractorOutputDetailed,
  parseExtractorOutputStrict,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
  PROPOSE_TAKES_PROMPT_VERSION,
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
  existingPageScans?: Set<string>; // composite-key strings already in take_proposal_page_scans
}): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const existing = opts.existingProposals ?? new Set<string>();
  const pageScans = opts.existingPageScans ?? new Set<string>();
  const proposalRows = new Set<string>();

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
      // SELECT idempotency check for successful scans, including zero-proposal scans.
      if (sql.includes('FROM take_proposal_page_scans')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (pageScans.has(key)) return [{ id: 1 } as unknown as T];
        return [];
      }
      // INSERT proposal queue rows. Mirror ON CONFLICT ... DO NOTHING RETURNING id.
      if (sql.includes('INSERT INTO take_proposals')) {
        const [sourceId, slug, ch, pv, _runId, claimText] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}|${claimText}`;
        if (proposalRows.has(key)) return [];
        proposalRows.add(key);
        return [{ id: proposalRows.size } as unknown as T];
      }
      // INSERT successful page-scan cache rows.
      if (sql.includes('INSERT INTO take_proposal_page_scans')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        pageScans.add(`${sourceId}|${slug}|${ch}|${pv}`);
        return [];
      }
      // Other statements return nothing
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

  test('detailed parser distinguishes literal JSON [] from malformed output', () => {
    expect(parseExtractorOutputDetailed('[]')).toEqual({ ok: true, proposals: [] });
    expect(parseExtractorOutputDetailed('[not valid json')).toEqual({ ok: false, proposals: [] });
    expect(parseExtractorOutputDetailed('completely unrelated prose')).toEqual({ ok: false, proposals: [] });
    expect(parseExtractorOutputDetailed('')).toEqual({ ok: false, proposals: [] });
  });

  test('detailed parser rejects parseable but wrong-shape JSON', () => {
    expect(parseExtractorOutputDetailed('{"claims":[]}')).toEqual({ ok: false, proposals: [] });
    expect(parseExtractorOutputDetailed('[{"claim":"missing claim_text"}]')).toEqual({ ok: false, proposals: [] });
    expect(parseExtractorOutputDetailed('[{"claim_text":"valid"},{"claim":"ignored"}]')).toEqual({
      ok: true,
      proposals: [{ claim_text: 'valid', kind: 'take', holder: 'brain', weight: 0.5, domain: undefined }],
    });
  });

  test('strict parser throws on malformed model output so callers do not cache it', () => {
    expect(() => parseExtractorOutputStrict('completely unrelated prose')).toThrow('extractor returned malformed JSON');
    expect(() => parseExtractorOutputStrict('{"claims":[]}')).toThrow('extractor returned malformed JSON');
    expect(parseExtractorOutputStrict('[]')).toEqual([]);
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
    expect(details.scan_cache_writes).toBe(1);

    const scanCacheSelect = captured.find(c => c.sql.includes('FROM take_proposal_page_scans'));
    expect(scanCacheSelect?.sql).toContain('SELECT 1');
    expect(scanCacheSelect?.sql).not.toContain('SELECT id');

    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[5]).toBe('Marketplaces with cold-start liquidity win'); // claim_text
    expect(inserts[0]!.params[6]).toBe('bet'); // kind
    expect(inserts[0]!.params[9]).toBe('market'); // domain
  });

  test('same-page distinct proposals are queued separately; duplicate claims are not counted as inserted', async () => {
    const pages = [buildPage({ slug: 'wiki/multiple-claims', body: 'Two gradeable claims in one page.' })];
    const { engine, captured } = buildMockEngine({ pages });
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'first distinct claim', kind: 'take', holder: 'brain', weight: 0.55 },
      { claim_text: 'second distinct claim', kind: 'bet', holder: 'brain', weight: 0.7 },
      { claim_text: 'first distinct claim', kind: 'take', holder: 'brain', weight: 0.55 },
    ];

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    const proposalInserts = captured.filter(c => c.sql.includes('INSERT INTO take_proposals'));
    expect(proposalInserts).toHaveLength(3);
    expect(proposalInserts[0]!.sql).toContain('ON CONFLICT (source_id, page_slug, content_hash, prompt_version, claim_text) DO NOTHING');
    expect(proposalInserts[0]!.sql).toContain('RETURNING id');
    expect(proposalInserts.map(i => i.params[5])).toEqual(['first distinct claim', 'second distinct claim', 'first distinct claim']);
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(2);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposal_page_scans'))).toHaveLength(1);
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
    expect(captured.filter(c => c.sql.includes('INSERT'))).toHaveLength(0);
  });

  test('dry-run skips extractor calls and writes while reporting cache misses', async () => {
    const body = 'Dry-run should inspect the page but not spend tokens or write cache rows.';
    const pages = [buildPage({ slug: 'wiki/dry-run', body })];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [{ claim_text: 'should never be produced', kind: 'take', holder: 'brain', weight: 0.5 }];
    };
    const ctx = buildCtx(engine);
    ctx.dryRun = true;

    const result = await runPhaseProposeTakes(ctx, { extractor });

    expect(extractorCalls).toBe(0);
    const details = result.details as Record<string, unknown>;
    expect(details.dry_run).toBe(true);
    expect(details.cache_misses).toBe(1);
    expect(details.llm_calls_skipped).toBe(1);
    expect(details.proposals_inserted).toBe(0);
    expect(details.scan_cache_writes).toBe(0);
    expect(captured.filter(c => c.sql.includes('INSERT'))).toHaveLength(0);
  });

  test('empty extractor result is cached so unchanged pages do not re-spend LLM calls', async () => {
    const body = 'This page has prose, but no gradeable claims.';
    const pages = [buildPage({ slug: 'wiki/no-claims', body })];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };

    const first = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    const second = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalls).toBe(1);
    expect((first.details as Record<string, unknown>).cache_misses).toBe(1);
    expect((second.details as Record<string, unknown>).cache_hits).toBe(1);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposal_page_scans'))).toHaveLength(1);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposals'))).toHaveLength(0);
  });

  test('extractor failures are not cached, so transient LLM errors retry later', async () => {
    const pages = [buildPage({ slug: 'wiki/transient-failure', body: 'retryable prose' })];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      throw new Error('temporary upstream timeout');
    };

    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(extractorCalls).toBe(2);
    expect(captured.filter(c => c.sql.includes('INSERT INTO take_proposal_page_scans'))).toHaveLength(0);
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
