/**
 * CLI→MCP gap-closure wave — search_stats / search_modes / search_tune ops.
 * Pins the dashboard shapes (glossary block included per CDX-25), knob
 * attribution, the insufficient-data tune path, and the read-only guarantee
 * (search_tune NEVER mutates config — apply is CLI-only per CDX-21).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('search_stats op', () => {
  test('empty telemetry: zero counts, coverage caveat, glossary block', async () => {
    const res = await dispatchToolCall(engine, 'search_stats', { days: 30 }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.schema_version).toBe(2);
    expect(body.total_calls).toBe(0);
    expect(body.window_days).toBe(30);
    expect(body.coverage).toBeDefined();
    expect(typeof body.graph_signals.enabled).toBe('boolean');
    expect(body._meta.metric_glossary.cache_hit_rate).toContain('cache_hits');
  });
});

describe('search_modes op', () => {
  test('resolved knobs carry value + attribution + description; bundles frozen', async () => {
    const body = parsed(await dispatchToolCall(engine, 'search_modes', {}, { ...STDIO }));
    expect(body.schema_version).toBe(2);
    expect(['conservative', 'balanced', 'tokenmax']).toContain(body.active_mode);
    const knob = body.resolved.tokenBudget;
    expect(knob).toBeDefined();
    expect(typeof knob.source).toBe('string');
    expect(typeof knob.description).toBe('string');
    expect(Object.keys(body.bundles).sort()).toEqual(['balanced', 'conservative', 'tokenmax']);
    expect(operationsByName['search_modes'].scope).toBe('read');
  });
});

describe('search_stats on a pre-telemetry brain degrades gracefully', () => {
  test('a missing search_telemetry table yields zero-filled stats (the long-standing best-effort contract), not a crash', async () => {
    // readSearchStats is intentionally graceful for a pre-v0.32.3 brain that
    // has no telemetry table — it returns "0 searches" (the coverage caveat in
    // the op description explains low/zero counts), a contract pinned by
    // test/search-telemetry.test.ts and relied on by the CLI dashboard. The op
    // wraps readSearchStats in withRelationGuard for OTHER unexpected relation
    // errors, but the missing-telemetry-table case stays a healthy-empty
    // dashboard (an earlier gap-closure rethrow that broke this was reverted).
    const bareEngine = {
      async executeRaw() {
        throw new Error('relation "search_telemetry" does not exist');
      },
      // readGraphSignalsStats reads config (not the telemetry table); stub it
      // so the op's graph-signals section resolves via the mode-default path.
      async getConfig() { return null; },
    } as unknown as PGLiteEngine;
    const res = await dispatchToolCall(bareEngine, 'search_stats', { days: 30 }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.total_calls).toBe(0);
    expect(body.schema_version).toBe(2);
  });
});

describe('search_tune op', () => {
  test('insufficient data on a fresh brain; NEVER mutates config', async () => {
    const before = await engine.listConfigKeys('search.');
    const body = parsed(await dispatchToolCall(engine, 'search_tune', {}, { ...STDIO }));
    expect(body.status).toBe('insufficient_data');
    expect(body.recommendations).toEqual([]);
    expect(typeof body.total_calls).toBe('number');
    const after = await engine.listConfigKeys('search.');
    expect(after).toEqual(before);
    // No apply param exists on the op surface at all (CDX-21).
    expect(Object.keys(operationsByName['search_tune'].params)).toEqual([]);
  });
});
