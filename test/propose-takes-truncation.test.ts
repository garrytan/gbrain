/**
 * #3763 — propose_takes truncation + dead-lane halt.
 *
 * Pre-fix, defaultExtractor made exactly ONE gateway call at maxTokens=2048
 * and never checked stopReason: a 'length' (truncated) response produced
 * unparseable JSON, which the ambiguity guard rethrew as a GENERIC
 * 'transient — retry'. The phase's catch warned + continued, wrote no
 * tombstone, and re-billed the same pages at the same too-small cap every
 * cycle forever. And a run where EVERY extractor call failed still walked
 * the full page list, burning one LLM call per page.
 *
 * Post-fix:
 *   - stopReason 'length' retries ONCE at 4096 (facts/extract.ts #2113 parity);
 *   - a still-truncated retry throws an error NAMING the truncation;
 *   - the page loop halts after EXTRACTOR_FAILURE_HALT_STREAK consecutive
 *     failures with zero successes (status 'fail'); a mixed run never halts;
 *   - no failure tombstone in either case (#3910 policy).
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  defaultExtractor,
  PROPOSE_TAKES_MAX_TOKENS,
  PROPOSE_TAKES_RETRY_MAX_TOKENS,
  EXTRACTOR_FAILURE_HALT_STREAK,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene (facts-extract-truncation.test.ts precedent): restore the
// legacy 1536-d embedding pin so later fresh-schema files in this shard
// don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON = '[{"claim_text":"Acme doubles ARR by Q4","kind":"bet","holder":"brain","weight":0.7}]';

// ─── defaultExtractor truncation retry ──────────────────────────────

describe('defaultExtractor truncation retry (#3763)', () => {
  const input = {
    pagePath: 'companies/acme-example',
    pageBody: 'I bet Acme doubles ARR by Q4. They ship weekly.',
    existingTakes: [],
  };

  test('clean call: exactly one gateway call at the base cap', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    const takes = await defaultExtractor(input);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxTokens).toBe(PROPOSE_TAKES_MAX_TOKENS);
    expect(takes).toHaveLength(1);
  });

  test("stopReason 'length' retries ONCE at 4096 and recovers the takes", async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? chatResult('[{"claim_text":"Acme dou', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    const takes = await defaultExtractor(input);
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.maxTokens)).toEqual([
      PROPOSE_TAKES_MAX_TOKENS,
      PROPOSE_TAKES_RETRY_MAX_TOKENS,
    ]);
    expect(takes).toHaveLength(1);
    expect(takes[0]!.claim_text).toContain('Acme doubles ARR');
  });

  test('double truncation throws a message naming the truncation (not the generic transient)', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult('[{"claim_text":"Acme', 'length');
    });
    try {
      await defaultExtractor(input);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('truncated');
      expect(msg).toContain(String(PROPOSE_TAKES_RETRY_MAX_TOKENS));
      expect(msg).not.toContain('transient — retry');
    }
    expect(calls).toBe(2); // bounded at one retry
  });
});

// ─── phase-level dead-lane halt ─────────────────────────────────────

interface CapturedSql { sql: string; params: unknown[] }

function buildMockEngine(pageCount: number): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return Array.from({ length: pageCount }, (_, i) => ({
          slug: `wiki/page-${i}`,
          source_id: 'default',
          compiled_truth: `prose for page ${i} with a bold claim in it`,
        })) as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: captured.length } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, captured };
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

describe('extractor failure-streak halt (#3763)', () => {
  test(`always-throwing extractor over N+2 pages halts at N with status 'fail' and no tombstones`, async () => {
    const pageCount = EXTRACTOR_FAILURE_HALT_STREAK + 2;
    const { engine, captured } = buildMockEngine(pageCount);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      throw new Error('propose_takes extractor: no parseable takes JSON (transient — retry)');
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(calls).toBe(EXTRACTOR_FAILURE_HALT_STREAK);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(EXTRACTOR_FAILURE_HALT_STREAK);
    expect(details.aborted_failure_streak).toBe(true);
    expect(details.halted).toBe(true);
    expect(details.llm_calls_failed).toBe(EXTRACTOR_FAILURE_HALT_STREAK);
    expect(details.llm_calls_succeeded).toBe(0);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('consecutive extractor failures');

    // #3910 policy: failed pages write NO tombstone — they retry next cycle.
    const inserts = captured.filter((c) => c.sql.includes('INSERT INTO take_proposals'));
    expect(inserts).toHaveLength(0);
  });

  test('a single success disarms the halt: mixed run walks every page', async () => {
    const pageCount = EXTRACTOR_FAILURE_HALT_STREAK + 2;
    const { engine } = buildMockEngine(pageCount);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      if (calls === 1) {
        return [{ claim_text: 'one good claim', kind: 'take', holder: 'brain', weight: 0.6 }];
      }
      throw new Error('per-page failure');
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(calls).toBe(pageCount);
    const details = result.details as Record<string, unknown>;
    expect(details.pages_scanned).toBe(pageCount);
    expect(details.aborted_failure_streak).toBeUndefined();
    expect(details.llm_calls_succeeded).toBe(1);
    expect(result.status).toBe('warn'); // per-page failures still surface as warnings
  });

  test('fewer failures than the streak never halts', async () => {
    const pageCount = EXTRACTOR_FAILURE_HALT_STREAK - 1;
    const { engine } = buildMockEngine(pageCount);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      throw new Error('per-page failure');
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(calls).toBe(pageCount);
    const details = result.details as Record<string, unknown>;
    expect(details.aborted_failure_streak).toBeUndefined();
    expect(result.status).toBe('warn');
  });
});
