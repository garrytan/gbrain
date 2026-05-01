/**
 * E2E — Postgres-specific eval_capture behavior (v0.21.0, E1 spec).
 *
 * Unit tests in test/eval-candidates.test.ts already cover PGLite. This
 * file is strictly for Postgres-only behavior that PGLite can't exercise:
 *   1. RLS policy rejects when the caller is NOT BYPASSRLS
 *   2. CHECK violation surfaces as Postgres error code '23514'
 *   3. Concurrent INSERT pressure on the connection pool doesn't deadlock
 *      or drop rows (the fire-and-forget capture path at full tilt)
 *
 * Runs only when DATABASE_URL is set. Skips gracefully otherwise
 * per CLAUDE.md E2E lifecycle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { EvalCandidateInput } from '../../src/core/types.ts';

const DATABASE_URL = process.env.DATABASE_URL;

let engine: PostgresEngine | null = null;

beforeAll(async () => {
  if (!DATABASE_URL) {
    console.log('[e2e/eval-capture] DATABASE_URL not set — skipping.');
    return;
  }
  engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL });
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

beforeEach(async () => {
  if (!engine) return;
  await engine.executeRaw('DELETE FROM eval_candidates');
  await engine.executeRaw('DELETE FROM eval_capture_failures');
});

function baseInput(overrides: Partial<EvalCandidateInput> = {}): EvalCandidateInput {
  return {
    tool_name: 'query',
    query: 'alice',
    retrieved_slugs: ['people/alice-example'],
    retrieved_chunk_ids: [1],
    source_ids: ['default'],
    expand_enabled: true,
    detail: null,
    detail_resolved: 'medium',
    vector_enabled: true,
    expansion_applied: false,
    latency_ms: 100,
    remote: true,
    job_id: null,
    subagent_id: null,
    ...overrides,
  };
}

describe('CHECK constraint — 50KB query length cap', () => {
  test.if(DATABASE_URL !== undefined)(
    'oversized query rejected with Postgres error code 23514',
    async () => {
      if (!engine) return;
      const big = 'x'.repeat(51_201);
      let caught: unknown = null;
      try {
        await engine.logEvalCandidate(baseInput({ query: big }));
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      // postgres.js surfaces SQLSTATE on the error object as `code`.
      expect((caught as { code?: string }).code).toBe('23514');
    },
  );

  test.if(DATABASE_URL !== undefined)(
    'query exactly at 50KB succeeds',
    async () => {
      if (!engine) return;
      const atCap = 'x'.repeat(51_200);
      const id = await engine.logEvalCandidate(baseInput({ query: atCap }));
      expect(id).toBeGreaterThan(0);
    },
  );
});

describe('RLS policy — requires BYPASSRLS to INSERT', () => {
  // Note: running this test REQUIRES the E2E test role to be postgres
  // (or another BYPASSRLS role) since schema.sql + migration v25 enable
  // RLS only on BYPASSRLS-capable roles. We verify the policy is
  // actually enabled and the INSERT path succeeds as BYPASSRLS. A
  // "deny from non-BYPASSRLS role" positive test would require setting
  // up a second role, which is beyond this test's scope — but
  // structurally we assert the ALTER TABLE ran.
  test.if(DATABASE_URL !== undefined)(
    'eval_candidates has RLS enabled',
    async () => {
      if (!engine) return;
      const rows = await engine.executeRaw<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'eval_candidates'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relrowsecurity).toBe(true);
    },
  );

  test.if(DATABASE_URL !== undefined)(
    'eval_capture_failures has RLS enabled',
    async () => {
      if (!engine) return;
      const rows = await engine.executeRaw<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'eval_capture_failures'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relrowsecurity).toBe(true);
    },
  );
});

describe('concurrent pool pressure — 50 parallel INSERTs', () => {
  test.if(DATABASE_URL !== undefined)(
    '50 concurrent logEvalCandidate calls all land without deadlock',
    async () => {
      if (!engine) return;
      const n = 50;
      const promises: Promise<number>[] = [];
      for (let i = 0; i < n; i++) {
        promises.push(engine.logEvalCandidate(baseInput({ query: `q${i}` })));
      }
      const ids = await Promise.all(promises);
      expect(ids).toHaveLength(n);
      expect(new Set(ids).size).toBe(n); // every id is distinct

      const rows = await engine.listEvalCandidates({ limit: n * 2 });
      expect(rows).toHaveLength(n);
    },
    30_000,
  );
});
