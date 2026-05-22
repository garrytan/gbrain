/**
 * Op-layer capture integration test (v0.21.0).
 *
 * The hook lives at the `query` and `search` op handlers in
 * src/core/operations.ts, not at the MCP dispatch site — this catches
 * MCP callers, CLI callers, and subagent tool-bridge callers all from
 * one code path.
 *
 * This test invokes the op handler directly with various
 * OperationContext shapes (remote MCP, local CLI, subagent with jobId)
 * and asserts that captured rows carry the expected origin metadata.
 *
 * Capture is fire-and-forget from the caller — but the INSERT fires on
 * the same tick, so awaiting a microtask boundary is enough to let the
 * row land before we assert.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY; // force keyword-only path so tests don't need live credentials
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page: PageInput = {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice Example for op-layer capture tests.',
  };
  await engine.putPage('people/alice-example', page);
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await engine.disconnect();
});

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_candidates');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_capture_failures');
});

function makeConfig(overrides: Partial<GBrainConfig['eval']> = {}): GBrainConfig {
  return {
    engine: 'pglite',
    eval: { capture: true, scrub_pii: true, ...overrides },
  };
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: makeConfig(),
    logger: console,
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

/** Tiny helper: wait for fire-and-forget INSERT to land. */
async function waitForCapture(): Promise<void> {
  // Two microtask cycles is plenty — the handler already awaited the op,
  // so the fire-and-forget INSERT is enqueued. One await resolves the
  // logEvalCandidate promise; one more for any follow-up.
  await new Promise(r => setTimeout(r, 10));
}

describe('op-layer capture — query', () => {
  const queryOp = operations.find(o => o.name === 'query')!;

  test('captures MCP query call with remote=true', async () => {
    const ctx = makeCtx({ remote: true });
    await queryOp.handler(ctx, { query: 'alice' });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tool_name).toBe('query');
    expect(row.query).toBe('alice');
    expect(row.remote).toBe(true);
    expect(row.expand_enabled).toBe(true); // default
    expect(row.vector_enabled).toBe(false); // OPENAI_API_KEY deleted
    expect(row.job_id).toBeNull();
    expect(row.subagent_id).toBeNull();
  });

  test('captures CLI query call with remote=false', async () => {
    const ctx = makeCtx({ remote: false });
    await queryOp.handler(ctx, { query: 'alice' });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows[0]!.remote).toBe(false);
  });

  test('captures subagent query call with jobId + subagentId', async () => {
    const ctx = makeCtx({ remote: true, jobId: 9001, subagentId: 42 });
    await queryOp.handler(ctx, { query: 'alice' });
    await waitForCapture();

    const row = (await engine.listEvalCandidates())[0]!;
    expect(row.job_id).toBe(9001);
    expect(row.subagent_id).toBe(42);
  });

  test('scrubs PII by default before insert', async () => {
    const ctx = makeCtx();
    await queryOp.handler(ctx, { query: 'email alice@example.com about it' });
    await waitForCapture();

    const row = (await engine.listEvalCandidates())[0]!;
    expect(row.query).not.toContain('alice@example.com');
    expect(row.query).toContain('[REDACTED]');
  });

  test('preserves PII when scrub_pii is disabled', async () => {
    const ctx = makeCtx({
      config: makeConfig({ scrub_pii: false }),
    });
    await queryOp.handler(ctx, { query: 'email alice@example.com' });
    await waitForCapture();

    const row = (await engine.listEvalCandidates())[0]!;
    expect(row.query).toBe('email alice@example.com');
  });

  test('does nothing when eval.capture is false (off-switch works)', async () => {
    const ctx = makeCtx({
      config: makeConfig({ capture: false }),
    });
    await queryOp.handler(ctx, { query: 'alice' });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(0);
  });
});

describe('op-layer capture — search', () => {
  const searchOp = operations.find(o => o.name === 'search')!;

  test('captures search call with tool_name="search" and vector_enabled=false', async () => {
    const ctx = makeCtx();
    await searchOp.handler(ctx, { query: 'alice' });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tool_name).toBe('search');
    expect(row.vector_enabled).toBe(false); // search never runs vector
    expect(row.expand_enabled).toBeNull(); // no expansion concept for search
    expect(row.detail_resolved).toBeNull();
  });

  test('respects eval.capture=false off-switch', async () => {
    const ctx = makeCtx({
      config: makeConfig({ capture: false }),
    });
    await searchOp.handler(ctx, { query: 'alice' });
    await waitForCapture();
    expect(await engine.listEvalCandidates()).toHaveLength(0);
  });
});

describe('op-layer capture — non-query/search ops are NOT captured', () => {
  test('list_pages does not insert into eval_candidates', async () => {
    const listPagesOp = operations.find(o => o.name === 'list_pages')!;
    const ctx = makeCtx();
    await listPagesOp.handler(ctx, { limit: 10 });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(0);
  });

  test('get_page does not insert into eval_candidates', async () => {
    const getPageOp = operations.find(o => o.name === 'get_page')!;
    const ctx = makeCtx();
    await getPageOp.handler(ctx, { slug: 'people/alice-example' });
    await waitForCapture();

    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(0);
  });
});

describe('op-layer capture — failure isolation (F1/F2)', () => {
  test('capture failures do not propagate to op response', async () => {
    // Disconnect-then-reconnect the engine to simulate an INSERT failure.
    // We can't easily inject a rejecting engine here since operations.ts
    // imports the real one, but we can break the table temporarily.
    // Drop the eval_candidates table, run the op, assert (a) op response
    // succeeds and (b) a failure row appears in eval_capture_failures.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.exec('DROP TABLE eval_candidates');
    const queryOp = operations.find(o => o.name === 'query')!;
    const ctx = makeCtx();
    // Op must still succeed and return results.
    const results = await queryOp.handler(ctx, { query: 'alice' });
    expect(Array.isArray(results)).toBe(true);

    await waitForCapture();
    // Failure should have landed in the companion table.
    const failures = await engine.listEvalCaptureFailures();
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(['db_down', 'other']).toContain(failures[0]!.reason);

    // Restore the table for subsequent tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.exec(`
      CREATE TABLE IF NOT EXISTS eval_candidates (
        id SERIAL PRIMARY KEY,
        tool_name TEXT NOT NULL CHECK (tool_name IN ('query', 'search')),
        query TEXT NOT NULL CHECK (length(query) <= 51200),
        retrieved_slugs TEXT[] NOT NULL DEFAULT '{}',
        retrieved_chunk_ids INTEGER[] NOT NULL DEFAULT '{}',
        source_ids TEXT[] NOT NULL DEFAULT '{}',
        expand_enabled BOOLEAN,
        detail TEXT,
        detail_resolved TEXT,
        vector_enabled BOOLEAN NOT NULL,
        expansion_applied BOOLEAN NOT NULL,
        latency_ms INTEGER NOT NULL,
        remote BOOLEAN NOT NULL,
        job_id INTEGER,
        subagent_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });
});
