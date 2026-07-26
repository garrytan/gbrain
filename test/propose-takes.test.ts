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
  chunkCounts?: Map<number, number>;
  checkpointKeys?: Set<string>;
}): { engine: BrainEngine; captured: CapturedSql[]; checkpointKeys: Set<string> } {
  const captured: CapturedSql[] = [];
  const existing = opts.existingProposals ?? new Set<string>();
  const chunkCounts = opts.chunkCounts ?? new Map(opts.pages.map((page) => [page.id, 1]));
  const checkpointKeys = opts.checkpointKeys ?? new Set<string>();

  const engine = {
    kind: 'pglite',
    async listPages() {
      return opts.pages;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('FROM content_chunks')) {
        return (params ?? [])
          .map((id) => ({ page_id: Number(id), chunk_count: chunkCounts.get(Number(id)) ?? 0 }))
          .filter((row) => row.chunk_count > 0) as T[];
      }
      if (sql.includes('FROM op_checkpoints')) {
        return checkpointKeys.size > 0
          ? [{ completed_keys: [...checkpointKeys], completed_kind: 'array' } as unknown as T]
          : [];
      }
      if (sql.includes('INSERT INTO op_checkpoints')) {
        checkpointKeys.clear();
        for (const key of JSON.parse(String(params?.[2] ?? '[]')) as string[]) checkpointKeys.add(key);
        return [];
      }
      if (sql.includes('SELECT source_id, page_slug, content_hash') && sql.includes('FROM take_proposals')) {
        return [...existing].map((key) => {
          const [source_id, page_slug, content_hash, prompt_version] = key.split('|');
          return { source_id, page_slug, content_hash, prompt_version } as unknown as T;
        });
      }
      // SELECT idempotency check
      if (sql.includes('SELECT id FROM take_proposals')) {
        const [sourceId, slug, ch, pv] = params ?? [];
        const key = `${sourceId}|${slug}|${ch}|${pv}`;
        if (existing.has(key)) return [{ id: 1 } as unknown as T];
        return [];
      }
      if (sql.includes('INSERT INTO take_proposals')) {
        return [{ id: captured.length } as unknown as T];
      }
      // INSERT — return nothing
      return [];
    },
  } as unknown as BrainEngine;

  return { engine, captured, checkpointKeys };
}

function buildPage(opts: { slug: string; body: string; sourceId?: string; id?: number }): Page {
  return {
    id: opts.id ?? 1,
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
    expect(details.proposal_samples).toEqual([{
      claim_text: 'Marketplaces with cold-start liquidity win',
      page_slug: 'wiki/concepts/network-effects',
      kind: 'bet',
    }]);

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

  test('selects truly unprocessed pages before applying the page limit', async () => {
    const cachedBody = 'newest but already processed';
    const pendingBody = 'older and still pending';
    const pages = [
      buildPage({ id: 1, slug: 'wiki/cached', body: cachedBody }),
      buildPage({ id: 2, slug: 'wiki/pending', body: pendingBody }),
    ];
    const existing = new Set([
      `default|wiki/cached|${contentHash(cachedBody)}|${PROPOSE_TAKES_PROMPT_VERSION}`,
    ]);
    const { engine } = buildMockEngine({ pages, existingProposals: existing });
    const visited: string[] = [];

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      pageLimit: 1,
      extractor: async ({ pagePath }) => {
        visited.push(pagePath);
        return [];
      },
    });

    expect(visited).toEqual(['wiki/pending']);
    expect(result.details.cache_hits).toBe(1);
    expect(result.details.pages_processed).toBe(1);
    expect(result.details.remaining).toBe(0);
  });

  test('prioritizes pages changed by the current sync', async () => {
    const pages = [
      buildPage({ id: 1, slug: 'wiki/newer', body: 'newer page' }),
      buildPage({ id: 2, slug: 'wiki/just-synced', body: 'just synced page' }),
    ];
    const { engine } = buildMockEngine({ pages });
    const visited: string[] = [];

    await runPhaseProposeTakes(buildCtx(engine), {
      pageLimit: 1,
      prioritySlugs: ['wiki/just-synced'],
      extractor: async ({ pagePath }) => {
        visited.push(pagePath);
        return [];
      },
    });

    expect(visited).toEqual(['wiki/just-synced']);
  });

  test('drain processes repeated bounded batches until the pending backlog is empty', async () => {
    const pages = Array.from({ length: 5 }, (_, index) => buildPage({
      id: index + 1,
      slug: `wiki/page-${index + 1}`,
      body: `page ${index + 1}`,
    }));
    const { engine } = buildMockEngine({ pages });
    let calls = 0;

    const result = await runPhaseProposeTakes(buildCtx(engine), {
      pageLimit: 2,
      drain: true,
      windowMs: 60_000,
      extractor: async () => {
        calls++;
        return [];
      },
    });

    expect(calls).toBe(5);
    expect(result.details.batches).toBe(3);
    expect(result.details.pages_processed).toBe(5);
    expect(result.details.remaining).toBe(0);
    expect(result.details.stopped).toBe('drained');
  });

  test('checkpoint remembers successful zero-proposal pages across runs', async () => {
    const pages = [buildPage({ slug: 'wiki/no-take', body: 'descriptive prose without a gradeable claim' })];
    const checkpointKeys = new Set<string>();
    const first = buildMockEngine({ pages, checkpointKeys });
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };

    const firstResult = await runPhaseProposeTakes(buildCtx(first.engine), { extractor });
    const second = buildMockEngine({ pages, checkpointKeys });
    const secondResult = await runPhaseProposeTakes(buildCtx(second.engine), { extractor });

    expect(firstResult.details.pages_processed).toBe(1);
    expect(checkpointKeys.size).toBe(1);
    expect(calls).toBe(1);
    expect(secondResult.details.cache_hits).toBe(1);
    expect(secondResult.details.pages_processed).toBe(0);
  });

  test('dry-run does not call extractor or write proposals', async () => {
    const pages = [buildPage({ slug: 'wiki/dry-run', body: 'This page would need LLM extraction.' })];
    const { engine, captured } = buildMockEngine({ pages });
    let extractorCalled = false;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalled = true;
      return [{ claim_text: 'should not be written', kind: 'take', holder: 'brain', weight: 0.5 }];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor, dryRun: true });

    expect(extractorCalled).toBe(false);
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('dry-run');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(1);
    expect(details.cache_misses).toBe(1);
    expect(details.dry_run_no_llm).toBe(true);
    expect(details.proposals_inserted).toBe(0);
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

    expect(result.status).toBe('warn');
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(2);
    expect(details.proposals_inserted).toBe(1);
    expect((details.warnings as string[]).length).toBeGreaterThan(0);
    expect((details.warnings as string[])[0]).toContain('LLM timeout');
  });

  test('reports per-page progress with percent and slug', async () => {
    const pages = [
      buildPage({ slug: 'wiki/a', body: 'page A prose' }),
      buildPage({ slug: 'wiki/b', body: 'page B prose' }),
    ];
    const { engine } = buildMockEngine({ pages });
    const events: Array<{ type: string; phase?: string; total?: number; note?: string }> = [];
    const reporter = {
      start: (phase: string, total?: number) => events.push({ type: 'start', phase, total }),
      tick: (_n?: number, note?: string) => events.push({ type: 'tick', note }),
      heartbeat: (note: string) => events.push({ type: 'heartbeat', note }),
      finish: () => events.push({ type: 'finish' }),
      child: () => reporter,
    };
    const extractor: ProposeTakesExtractor = async () => [];

    await runPhaseProposeTakes(buildCtx(engine), { extractor, reporter });

    expect(events).toContainEqual({ type: 'start', phase: 'propose_takes.pages', total: 2 });
    expect(events.some(e => e.type === 'heartbeat' && e.note === 'processing 1/2 (50%) wiki/a')).toBe(true);
    expect(events.some(e => e.type === 'tick' && e.note === 'done +0 1/2 (50%) wiki/a')).toBe(true);
    expect(events.some(e => e.type === 'heartbeat' && e.note === 'processing 2/2 (100%) wiki/b')).toBe(true);
    expect(events.some(e => e.type === 'tick' && e.note === 'done +0 2/2 (100%) wiki/b')).toBe(true);
    expect(events.at(-1)?.type).toBe('finish');
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

  test('requireChunks skips pages without text chunks before extractor/cache work', async () => {
    const pages = [
      buildPage({ id: 1, slug: 'wiki/no-chunks', body: 'large unchunked body' }),
      buildPage({ id: 2, slug: 'wiki/with-chunks', body: 'normal chunked body' }),
    ];
    const { engine, captured } = buildMockEngine({
      pages,
      chunkCounts: new Map([[1, 0], [2, 2]]),
    });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    const details = result.details as Record<string, unknown>;
    expect(extractorCalls).toBe(1);
    expect(details.pages_scanned).toBe(1);
    expect(details.skipped_no_chunks).toBe(1);
    expect(captured.filter(c => c.sql.includes('SELECT source_id, page_slug, content_hash'))).toHaveLength(1);
  });

  test('requireChunks:false preserves old behavior for unchunked pages', async () => {
    const pages = [buildPage({ slug: 'wiki/no-chunks', body: 'unchunked prose' })];
    const { engine } = buildMockEngine({
      pages,
      chunkCounts: new Map([[1, 0]]),
    });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      return [];
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor, requireChunks: false });

    expect(extractorCalls).toBe(1);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(1);
    expect(details.skipped_no_chunks).toBe(0);
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
