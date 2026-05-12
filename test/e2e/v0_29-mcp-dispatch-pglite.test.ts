/**
 * v0.29 E2E — MCP dispatch path for the three new ops.
 *
 * Existing v0.29 e2e tests call engine methods directly. This file goes
 * through the full `dispatchToolCall` pipeline — same code path that
 * stdio MCP and HTTP MCP use — so we get coverage for:
 *
 *   1. validateParams (params shape contract per op definition)
 *   2. buildOperationContext (ctx.remote, ctx.engine, ctx.config wiring)
 *   3. handler invocation + JSON serialization (ToolResult shape)
 *   4. Error path: OperationError → isError + JSON envelope
 *   5. Trust gate: ctx.remote === true on get_recent_transcripts must
 *      reach the handler and produce a permission_denied error.
 *
 * Runs against PGLite in-memory. No DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Seed enough fixture for the salience + anomalies ops to return non-empty
  // rows. 5 wedding pages (today), 5 random-tag pages backdated 14 days.
  for (let i = 0; i < 5; i++) {
    const slug = `personal/wedding/photo-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Wedding photo ${i}`,
      compiled_truth: `Photos from the day, batch ${i}.`,
    });
    await engine.addTag(slug, 'wedding');
  }
  for (let i = 0; i < 5; i++) {
    const slug = `notes/bg-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Background ${i}`,
      compiled_truth: `Body ${i}.`,
    });
    await engine.addTag(slug, 'product');
  }
  await engine.executeRaw(
    `UPDATE pages SET updated_at = now() - interval '14 days'
      WHERE slug LIKE 'notes/bg-%'`,
  );

  // Populate emotional_weight so the salience query produces an ordering.
  const inputs = await engine.batchLoadEmotionalInputs();
  const { computeEmotionalWeight } = await import(
    '../../src/core/cycle/emotional-weight.ts'
  );
  const rows = inputs.map(r => ({
    slug: r.slug,
    source_id: r.source_id,
    weight: computeEmotionalWeight({ tags: r.tags, takes: r.takes }),
  }));
  await engine.setEmotionalWeightBatch(rows);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 E2E — dispatchToolCall for the three new ops', () => {
  test('get_recent_salience returns ranked rows via the MCP dispatch path', async () => {
    const result = await dispatchToolCall(engine, 'get_recent_salience', {
      days: 7,
      limit: 10,
    }, { remote: true });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe('text');

    const rows = JSON.parse(result.content[0].text);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Wedding pages should be at or near the top (max tag-emotion boost).
    expect(rows[0].slug).toMatch(/^personal\/wedding\//);
  });

  test('find_anomalies returns cohort outliers via the MCP dispatch path', async () => {
    const result = await dispatchToolCall(engine, 'find_anomalies', {
      lookback_days: 30,
      sigma: 1.5, // lower threshold so the small fixture tips the cohort
    }, { remote: true });

    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(result.content[0].text);
    expect(Array.isArray(rows)).toBe(true);
    // Schema check on one cohort if anything fired (small fixture may not
    // always trip 1.5σ; this is a smoke contract for the response shape).
    if (rows.length > 0) {
      const row = rows[0];
      expect(row).toHaveProperty('cohort_kind');
      expect(row).toHaveProperty('cohort_value');
      expect(row).toHaveProperty('count');
      expect(row).toHaveProperty('baseline_mean');
      expect(row).toHaveProperty('baseline_stddev');
      expect(row).toHaveProperty('sigma_observed');
      expect(Array.isArray(row.page_slugs)).toBe(true);
    }
  });

  test('get_recent_transcripts rejects with permission_denied when ctx.remote === true', async () => {
    // Defense-in-depth: even though serve-http filters localOnly: true ops
    // out of the MCP tool list, the in-handler ctx.remote check is the
    // last line. dispatchToolCall defaults remote=true, which is what
    // every MCP transport sets, so the reject must fire here.
    const result = await dispatchToolCall(engine, 'get_recent_transcripts', {
      days: 7,
    }, { remote: true });

    expect(result.isError).toBe(true);
    const err = JSON.parse(result.content[0].text);
    // OperationError.toJSON() serializes the code as `error:`, not `code:`.
    expect(err.error).toBe('permission_denied');
    expect(err.message.toLowerCase()).toContain('local-only');
  });

  test('get_recent_transcripts succeeds when ctx.remote === false (CLI path)', async () => {
    // The local-CLI path explicitly sets remote: false. Op should run
    // (returning [] is fine — no corpus dir is configured in this test
    // fixture; the test just asserts the trust gate didn't reject).
    const result = await dispatchToolCall(engine, 'get_recent_transcripts', {
      days: 7,
    }, { remote: false });

    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(result.content[0].text);
    expect(Array.isArray(rows)).toBe(true);
    // No corpus_dir configured for this test brain → empty array, not error.
    expect(rows).toEqual([]);
  });

  test('unknown tool returns Unknown tool error envelope (regression guard)', async () => {
    // Generic dispatch shape contract — protects against typos in op
    // names accidentally short-circuiting elsewhere in the dispatcher.
    const result = await dispatchToolCall(engine, 'get_recent_definitely_not_a_real_op', {}, { remote: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });
});
