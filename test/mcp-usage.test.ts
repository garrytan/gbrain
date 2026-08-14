/**
 * T12 (amendment 30) — src/core/mcp-usage.ts, the shared mcp_request_log
 * usage reader. Pins the row-hygiene rules that three consumers (auth
 * clients --usage, the advisor starter-fit collector, derive-starter-ops)
 * must agree on:
 *   - JSON-RPC method rows ('tools/list', 'initialize', ...) are not op calls
 *   - 'surface_change' audit rows (ENG-8) are excluded
 *   - the legacy 'tools/call:<name>' prefix strips to <name>
 *   - windowing on created_at (default 30d)
 *   - D12 behavioral automation classification (>90% context_pack/delta)
 *
 * Hermetic in-memory PGLite (real SQL, both-engine-portable shape).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  readClientOpUsage,
  normalizeLoggedOperation,
  AUTOMATION_FRACTION_THRESHOLD,
  MCP_USAGE_DEFAULT_WINDOW_DAYS,
} from '../src/core/mcp-usage.ts';

let engine: PGLiteEngine;

async function seed(token: string | null, operation: string, count: number, daysAgo = 0, status = 'success'): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, created_at)
       VALUES ($1, $2, $3, 5, $5, now() - ($4::int * interval '1 day'))`,
      [token, token ?? 'anon', operation, daysAgo, status],
    );
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // client-a: real ops + method rows + an audit row (methods/audit must drop).
  await seed('client-a', 'query', 3);
  await seed('client-a', 'search', 2);
  await seed('client-a', 'tools/list', 5);
  await seed('client-a', 'initialize', 1);
  await seed('client-a', 'surface_change', 1);

  // client-b: legacy bearer transport rows.
  await seed('client-b', 'tools/call:query', 2);
  await seed('client-b', 'tools/call:', 1); // empty op name → dropped
  // Prefixed method/audit rows must drop too (the stripped name re-runs hygiene).
  await seed('client-b', 'tools/call:tools/list', 2);
  await seed('client-b', 'tools/call:surface_change', 1);

  // client-c: automation-shaped (19 boundary calls of 20 total = 0.95).
  await seed('client-c', 'context_pack', 15);
  await seed('client-c', 'delta', 4);
  await seed('client-c', 'query', 1);

  // client-old: outside the default 30d window, inside 90d.
  await seed('client-old', 'query', 1, 40);

  // NULL token_name rows never attribute to a client.
  await seed(null, 'query', 1);

  // client-denied: denial/error traffic must not count as usage — a client
  // bouncing off a gated op can't "use" its way into starter derivation.
  await seed('client-denied', 'advisor', 20, 0, 'denied_after_list');
  await seed('client-denied', 'query', 3, 0, 'error');
  // warn-mode successes DO count.
  await seed('client-a', 'query', 1, 0, 'success_with_warnings');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('normalizeLoggedOperation (hygiene rules, single source)', () => {
  test('plain op names pass through', () => {
    expect(normalizeLoggedOperation('query')).toBe('query');
    expect(normalizeLoggedOperation('put_page')).toBe('put_page');
  });
  test('JSON-RPC method rows drop', () => {
    expect(normalizeLoggedOperation('tools/list')).toBeNull();
    expect(normalizeLoggedOperation('initialize')).toBeNull();
    expect(normalizeLoggedOperation('notifications/initialized')).toBeNull();
    expect(normalizeLoggedOperation('ping')).toBeNull();
  });
  test('surface_change audit rows drop (ENG-8)', () => {
    expect(normalizeLoggedOperation('surface_change')).toBeNull();
  });
  test('legacy tools/call: prefix strips to the op name', () => {
    expect(normalizeLoggedOperation('tools/call:query')).toBe('query');
    expect(normalizeLoggedOperation('tools/call:')).toBeNull();
  });
  test('stripped names re-run the hygiene check — prefixed method/audit rows drop', () => {
    expect(normalizeLoggedOperation('tools/call:tools/list')).toBeNull();
    expect(normalizeLoggedOperation('tools/call:surface_change')).toBeNull();
    expect(normalizeLoggedOperation('tools/call:initialize')).toBeNull();
    expect(normalizeLoggedOperation('tools/call:notifications/initialized')).toBeNull();
    expect(normalizeLoggedOperation('tools/call:ping')).toBeNull();
  });
});

describe('readClientOpUsage', () => {
  test('default 30d window: hygiene applied, per-client counts + distinct ops', async () => {
    const usage = await readClientOpUsage(engine);
    const a = usage.find((u) => u.token_name === 'client-a');
    expect(a).toBeDefined();
    // 3 plain successes + 1 success_with_warnings (warn-mode successes count).
    expect(a!.ops).toEqual({ query: 4, search: 2 });
    expect(a!.total_calls).toBe(6);
    expect(a!.distinct_ops).toEqual(['query', 'search']);
    expect(a!.likely_automation).toBe(false);
    expect(new Date(a!.last_seen).getTime()).toBeGreaterThan(0);
  });

  test('legacy prefix rows merge into the plain op name', async () => {
    const usage = await readClientOpUsage(engine);
    const b = usage.find((u) => u.token_name === 'client-b');
    expect(b).toBeDefined();
    // 'tools/call:' (empty name) and the prefixed method/audit rows
    // ('tools/call:tools/list', 'tools/call:surface_change') all dropped.
    expect(b!.ops).toEqual({ query: 2 });
    expect(b!.total_calls).toBe(2);
  });

  test('automation classification (D12): >90% boundary calls flags the client', async () => {
    const usage = await readClientOpUsage(engine);
    const c = usage.find((u) => u.token_name === 'client-c')!;
    expect(c.automation_fraction).toBeCloseTo(0.95, 5);
    expect(c.automation_fraction).toBeGreaterThan(AUTOMATION_FRACTION_THRESHOLD);
    expect(c.likely_automation).toBe(true);
  });

  test('denied and errored rows are not usage — only success statuses count', async () => {
    const usage = await readClientOpUsage(engine);
    // client-denied has ONLY denied_after_list + error rows → no usage entry.
    expect(usage.find((u) => u.token_name === 'client-denied')).toBeUndefined();
  });

  test('window excludes old rows by default; wider window includes them', async () => {
    const usage30 = await readClientOpUsage(engine, { days: MCP_USAGE_DEFAULT_WINDOW_DAYS });
    expect(usage30.find((u) => u.token_name === 'client-old')).toBeUndefined();
    const usage90 = await readClientOpUsage(engine, { days: 90 });
    const old = usage90.find((u) => u.token_name === 'client-old');
    expect(old).toBeDefined();
    expect(old!.ops).toEqual({ query: 1 });
  });

  test('NULL token_name rows are never attributed', async () => {
    const usage = await readClientOpUsage(engine);
    // Every returned entry has a real token_name; the anonymous row is gone.
    for (const u of usage) expect(u.token_name.length).toBeGreaterThan(0);
  });

  test('sorted by total_calls descending', async () => {
    const usage = await readClientOpUsage(engine);
    const totals = usage.map((u) => u.total_calls);
    expect(totals).toEqual([...totals].sort((x, y) => y - x));
  });

  test('rejects invalid day windows loudly', async () => {
    await expect(readClientOpUsage(engine, { days: 0 })).rejects.toThrow(/days must be an integer/);
    await expect(readClientOpUsage(engine, { days: 1.5 })).rejects.toThrow(/days must be an integer/);
    await expect(readClientOpUsage(engine, { days: 10_000 })).rejects.toThrow(/days must be an integer/);
  });
});
