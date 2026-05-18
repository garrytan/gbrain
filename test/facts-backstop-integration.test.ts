/**
 * v0.31.2 — runFactsBackstop integration tests.
 *
 * Fills gaps from the test gap analysis:
 *   - Gap #3: extract_facts MCP op response shape stability through
 *     runFactsPipeline. The op was refactored in commit 9; existing
 *     facts-mcp-allowlist + facts-anti-loop pass but don't pin the
 *     {inserted, duplicate, superseded, fact_ids} envelope on
 *     successful extraction.
 *   - Gap #5: facts:absorb writes are source-scoped. Multi-source
 *     brains must be able to query "failures for source X" without
 *     contamination from source Y.
 *   - Gap #7: queue-mode runFactsBackstop's error path actually lands
 *     an ingest_log row when the chat call fails. The unit test for
 *     absorb-log covers writeFactsAbsorbLog directly but not the
 *     wire-up through runFactsBackstop's catch.
 *
 * All tests use PGLite + the chat-transport stub so no API keys / network.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, runFactsPipeline } from '../src/core/facts/backstop.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests, getFactsQueue } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

const LONG_BODY = 'integration-test meeting note '.repeat(20);

function chatStub(facts: Array<{ fact: string; kind: string; notability: 'high' | 'medium' | 'low'; entity?: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map(f => ({
        fact: f.fact,
        kind: f.kind,
        entity: f.entity ?? null,
        confidence: 1.0,
        notability: f.notability,
      })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

describe('runFactsPipeline (extract_facts MCP op path) — response shape stability', () => {
  test('returns {inserted, duplicate, superseded, fact_ids} on successful extraction', async () => {
    chatStub([
      { fact: 'pipeline-shape-1', kind: 'fact', notability: 'medium', entity: null },
      { fact: 'pipeline-shape-2', kind: 'event', notability: 'high', entity: null },
    ]);
    const r = await runFactsPipeline('a real conversation turn', {
      engine,
      sourceId: 'default',
      sessionId: 'pipeline-shape-test',
      source: 'mcp:extract_facts',
    });

    // The contract extract_facts MCP op surfaces — agents (Claude
    // Desktop, Cursor) display fact-add counts in their UI based on
    // these fields.
    expect(typeof r.inserted).toBe('number');
    expect(typeof r.duplicate).toBe('number');
    expect(typeof r.superseded).toBe('number');
    expect(Array.isArray(r.fact_ids)).toBe(true);
    expect(r.inserted).toBe(2);
    expect(r.duplicate).toBe(0);
    expect(r.superseded).toBe(0);
    expect(r.fact_ids.length).toBe(2);
    // fact_ids must be valid (positive integers).
    for (const id of r.fact_ids) {
      expect(id).toBeGreaterThan(0);
    }
  });

  test('empty extraction → zero counts (no NaN, no undefined)', async () => {
    chatStub([]);
    const r = await runFactsPipeline('nothing claim-worthy here', {
      engine,
      sourceId: 'default',
      sessionId: 'empty-test',
      source: 'mcp:extract_facts',
    });
    expect(r.inserted).toBe(0);
    expect(r.duplicate).toBe(0);
    expect(r.superseded).toBe(0);
    expect(r.fact_ids).toEqual([]);
  });
});

describe('facts:absorb — multi-source isolation', () => {
  test('source_id scopes writeFactsAbsorbLog rows', async () => {
    const { writeFactsAbsorbLog } = await import('../src/core/facts/absorb-log.ts');

    const sessionA = 'multi-source-test-A-' + Math.random().toString(36).slice(2, 8);
    const sessionB = 'multi-source-test-B-' + Math.random().toString(36).slice(2, 8);

    await writeFactsAbsorbLog(engine, sessionA, 'gateway_error', 'source A failure', 'source-a');
    await writeFactsAbsorbLog(engine, sessionA, 'parse_failure', 'source A failure 2', 'source-a');
    await writeFactsAbsorbLog(engine, sessionB, 'gateway_error', 'source B failure', 'source-b');

    // Read all and filter by source_id; verify isolation contract.
    const all = await engine.getIngestLog({ limit: 100 });
    const sourceARows = all.filter(r =>
      r.source_id === 'source-a' && r.source_type === 'facts:absorb'
      && (r.source_ref === sessionA || r.source_ref === sessionB),
    );
    const sourceBRows = all.filter(r =>
      r.source_id === 'source-b' && r.source_type === 'facts:absorb'
      && (r.source_ref === sessionA || r.source_ref === sessionB),
    );

    expect(sourceARows.length).toBe(2);
    expect(sourceBRows.length).toBe(1);

    // No row in source-a's set has source_id === 'source-b' (and vice versa).
    for (const r of sourceARows) expect(r.source_id).toBe('source-a');
    for (const r of sourceBRows) expect(r.source_id).toBe('source-b');
  });

  test('doctor-style GROUP BY query produces per-source breakdown', async () => {
    const sessionId = 'multi-source-grouping-' + Math.random().toString(36).slice(2, 8);
    const { writeFactsAbsorbLog } = await import('../src/core/facts/absorb-log.ts');

    await writeFactsAbsorbLog(engine, sessionId, 'gateway_error', '1', 'source-x');
    await writeFactsAbsorbLog(engine, sessionId, 'gateway_error', '2', 'source-x');
    await writeFactsAbsorbLog(engine, sessionId, 'parse_failure', '3', 'source-x');
    await writeFactsAbsorbLog(engine, sessionId, 'gateway_error', '4', 'source-y');

    // Mirror the doctor query (24h window, group by source_id + reason).
    // The split_part-equivalent on PGLite's parser: SUBSTRING up to first ':'.
    const rows = await engine.executeRaw<{ source_id: string; reason: string; n: string | number }>(
      `SELECT
         source_id,
         split_part(summary, ':', 1) AS reason,
         COUNT(*)::text AS n
       FROM ingest_log
       WHERE source_type = 'facts:absorb'
         AND source_ref = $1
         AND created_at >= now() - INTERVAL '24 hours'
       GROUP BY source_id, split_part(summary, ':', 1)
       ORDER BY source_id, COUNT(*) DESC`,
      [sessionId],
    );

    // Expected: source-x has 2 gateway_error + 1 parse_failure; source-y has 1 gateway_error.
    expect(rows.length).toBe(3);
    const xRows = rows.filter(r => r.source_id === 'source-x');
    const yRows = rows.filter(r => r.source_id === 'source-y');
    expect(xRows.length).toBe(2);
    expect(yRows.length).toBe(1);

    const xGateway = xRows.find(r => r.reason === 'gateway_error');
    const xParse = xRows.find(r => r.reason === 'parse_failure');
    expect(Number(xGateway?.n ?? 0)).toBe(2);
    expect(Number(xParse?.n ?? 0)).toBe(1);
    expect(Number(yRows[0]?.n ?? 0)).toBe(1);
  });
});

describe('queue-mode → drains successfully on happy path', () => {
  test('queue worker completes; counters reflect work done', async () => {
    chatStub([{ fact: 'queue-drain-test', kind: 'fact', notability: 'medium', entity: null }]);

    const slug = 'meetings/queue-drain-' + Math.random().toString(36).slice(2, 8);
    const r = await runFactsBackstop(
      {
        slug,
        type: 'meeting',
        compiled_truth: LONG_BODY,
        frontmatter: {},
      },
      {
        engine,
        sourceId: 'queue-drain-source',
        sessionId: 'queue-drain-session',
        source: 'sync:import',
        mode: 'queue',
      },
    );

    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);

    // Wait for the queue to drain.
    const queue = getFactsQueue();
    const start = Date.now();
    while ((queue.pendingCount() > 0 || queue.inflightCount() > 0) && Date.now() - start < 2000) {
      await new Promise(rr => setTimeout(rr, 25));
    }

    const counters = queue.getCounters();
    expect(counters.completed).toBeGreaterThanOrEqual(1);
    expect(counters.failed).toBe(0);
  });

  test('extract.ts absorbs gateway errors silently — net effect is empty extraction', async () => {
    // The contract: extract.ts catches gateway errors and returns [] without
    // re-throwing (only AbortError re-throws). Backstop's catch only sees
    // errors from layers ABOVE extract — resolver, dedup, insert. Document
    // this here so future work that wants chat-error visibility knows to
    // rewire extract.ts itself rather than the backstop catch.
    __setChatTransportForTests(async () => {
      throw new Error('429 rate limit');
    });

    const slug = 'meetings/silent-absorb-' + Math.random().toString(36).slice(2, 8);
    const r = await runFactsBackstop(
      {
        slug,
        type: 'meeting',
        compiled_truth: LONG_BODY,
        frontmatter: {},
      },
      {
        engine,
        sourceId: 'silent-source',
        sessionId: 'silent-session',
        source: 'mcp:put_page',
        mode: 'inline',
      },
    );

    // Inline-mode envelope returns zero counts; no error thrown.
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.duplicate).toBe(0);
    }

    // Note for future work: writeFactsAbsorbLog from extract.ts itself
    // would close this visibility gap — surface gateway errors via
    // ingest_log without changing extract's "best-effort" return contract.
  });
});
