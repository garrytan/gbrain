/**
 * BrainEngine parity: the search telemetry and MCP usage statements of engine-sql/telemetry.ts, which the search
 * telemetry writer, `gbrain search stats`, the search tune advisor, `gbrain auth` usage, the writeback audience and
 * doctor (mcp_request_log, memory_writeback) used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts): the flush adds every counter of a bucket to its
 *    `(date, mode, intent)` row, the stats read sums the rows on or after the cutoff per `(mode, intent)` with integer
 *    and float sums, the usage read counts successful requests per token and operation inside the window, and the
 *    pruned-window probe answers the newest `pruned_through` (null on an empty tally).
 *  - Regression: an engine whose flush replaces a counter instead of adding it, whose stats read ignores the cutoff,
 *    or whose usage read counts denied, errored, anonymous or out-of-window requests gives a different search report,
 *    advisor finding, client usage table or doctor coverage note.
 *  - Why existing coverage misses it: the caller tests run these statements on PGLite only and never compare arms.
 *  - Seam: the request log and its tally have no typed writer, so the fixtures below seed them with harness-only SQL
 *    behind the backend switch (as `createSource` does). On the Rust arm the fixture stops on the engine's typed
 *    refusal until the store serves the request log. Clock values are mapped to booleans or day offsets.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchTelemetryBucket } from '../../src/core/engine-sql/telemetry.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms, sorted, type ParityBackend } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const DAY_MS = 86_400_000;

function bucket(date: string, mode: string, intent: string, extra: Partial<SearchTelemetryBucket> = {}): SearchTelemetryBucket {
  return {
    date, mode, intent, count: 1, sum_results: 0, sum_tokens: 0, sum_budget_dropped: 0, cache_hit: 0, cache_miss: 0,
    sum_rank1_score: 0, count_rank1: 0, rank1_lt_solid: 0, rank1_solid: 0, rank1_high: 0, ...extra,
  };
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** Fixture: one request log row `ageDays` old. Harness-only SQL; the Rust arm stops on the raw SQL refusal. */
async function seedRequest(engine: BrainEngine, backend: ParityBackend, row: { token: string | null; op: string; status: string; ageDays: number }) {
  switch (backend) {
    case 'rust':
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, created_at)
         VALUES ($1, 'agent-fork', $2, 5, $3, now() - ($4::float8 * interval '1 day'))`,
        [row.token, row.op, row.status, row.ageDays],
      );
      return;
  }
}

/** Fixture: one request log tally row whose pruned window ends `ageDays` ago. Harness-only SQL, as above. */
async function seedRollup(engine: BrainEngine, backend: ParityBackend, token: string, ageDays: number) {
  switch (backend) {
    case 'rust':
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(
        `INSERT INTO mcp_request_log_rollup (token_name, requests, last_used_at, pruned_through)
         VALUES ($1, 3, now(), now() - ($2::float8 * interval '1 day'))`,
        [token, ageDays],
      );
      return;
  }
}

function dayOffset(value: unknown, now: unknown): number {
  return Math.round((new Date(String(now instanceof Date ? now.toISOString() : now)).getTime()
    - new Date(String(value instanceof Date ? value.toISOString() : value)).getTime()) / DAY_MS);
}

describe('engine parity: telemetry', () => {
  parityTest(
    'recordSearchTelemetry adds each counter to its row and readSearchStats sums the rows on or after the cutoff',
    { methods: ['recordSearchTelemetry', 'readSearchStats'] },
    async (engine) => {
      const empty = await engine.readSearchStats(isoDay(-7));
      const today = isoDay(0);
      const old = isoDay(-30);
      await engine.recordSearchTelemetry(bucket(today, 'balanced', 'entity', {
        count: 2, sum_results: 10, sum_tokens: 300, sum_budget_dropped: 1, cache_hit: 1, cache_miss: 1,
        sum_rank1_score: 1.25, count_rank1: 2, rank1_lt_solid: 0, rank1_solid: 1, rank1_high: 1,
      }));
      await engine.recordSearchTelemetry(bucket(today, 'balanced', 'entity', {
        count: 3, sum_results: 4, sum_tokens: 50, cache_miss: 3, sum_rank1_score: 0.5, count_rank1: 1, rank1_lt_solid: 1,
      }));
      await engine.recordSearchTelemetry(bucket(isoDay(-1), 'balanced', 'entity', { count: 4, sum_rank1_score: 0.25, count_rank1: 1, rank1_lt_solid: 1 }));
      await engine.recordSearchTelemetry(bucket(today, 'tokenmax', 'general', { count: 1, sum_results: 7 }));
      await engine.recordSearchTelemetry(bucket(today, '_empty_result', 'no_match'));
      await engine.recordSearchTelemetry(bucket(old, 'balanced', 'entity', { count: 100, sum_results: 100 }));
      const week = await engine.readSearchStats(isoDay(-7));
      const all = await engine.readSearchStats(isoDay(-60));
      const future = await engine.readSearchStats(isoDay(1));
      const shape = (rows: typeof week) => sorted(rows, r => `${r.mode}/${r.intent}`).map(({ first_seen, last_seen, ...r }) => {
        expect(typeof first_seen).toBe('string');
        expect(typeof last_seen).toBe('string');
        expect(Number.isNaN(Date.parse(first_seen))).toBe(false);
        expect(Date.parse(last_seen) >= Date.parse(first_seen)).toBe(true);
        return r;
      });
      expect(empty).toEqual([]);
      expect(future).toEqual([]);
      const balanced = shape(week).find(r => r.mode === 'balanced');
      expect(balanced).toEqual({
        mode: 'balanced', intent: 'entity', count: 9, sum_results: 14, sum_tokens: 350, sum_budget_dropped: 1, cache_hit: 1,
        cache_miss: 4, sum_rank1_score: 2, count_rank1: 4, rank1_lt_solid: 2, rank1_solid: 1, rank1_high: 1,
      });
      expect(shape(all).find(r => r.mode === 'balanced')?.count).toBe(109);
      return { empty, week: shape(week), all: shape(all), future };
    },
  );

  parityTest(
    'readClientOpUsage counts successful requests per token and operation inside the window',
    { methods: ['readClientOpUsage'] },
    async (engine, backend) => {
      const empty = await engine.readClientOpUsage(30);
      await seedRequest(engine, backend, { token: 'token-a', op: 'search', status: 'success', ageDays: 1 });
      await seedRequest(engine, backend, { token: 'token-a', op: 'search', status: 'success_with_warnings', ageDays: 2 });
      await seedRequest(engine, backend, { token: 'token-a', op: 'put_page', status: 'accepted_pending', ageDays: 3 });
      await seedRequest(engine, backend, { token: 'token-a', op: 'put_page', status: 'denied', ageDays: 1 });
      await seedRequest(engine, backend, { token: 'token-a', op: 'search', status: 'error', ageDays: 1 });
      await seedRequest(engine, backend, { token: 'token-b', op: 'get_page', status: 'success', ageDays: 10 });
      await seedRequest(engine, backend, { token: 'token-b', op: 'get_page', status: 'success', ageDays: 40 });
      await seedRequest(engine, backend, { token: null, op: 'search', status: 'success', ageDays: 1 });
      const month = await engine.readClientOpUsage(30);
      const week = await engine.readClientOpUsage(7);
      const year = await engine.readClientOpUsage(365);
      const shape = (rows: typeof month) => sorted(rows, r => `${r.token_name}/${r.operation}`).map(r => {
        expect(r.last_seen).toBeInstanceOf(Date);
        return { token_name: r.token_name, operation: r.operation, n: r.n, age: dayOffset(r.last_seen, new Date()) };
      });
      expect(empty).toEqual([]);
      expect(shape(month)).toEqual([
        { token_name: 'token-a', operation: 'put_page', n: 1, age: 3 },
        { token_name: 'token-a', operation: 'search', n: 2, age: 1 },
        { token_name: 'token-b', operation: 'get_page', n: 1, age: 10 },
      ]);
      expect(shape(week).map(r => `${r.token_name}/${r.operation}`)).toEqual(['token-a/put_page', 'token-a/search']);
      expect(shape(year).find(r => r.token_name === 'token-b')?.n).toBe(2);
      return { empty, month: shape(month), week: shape(week), year: shape(year) };
    },
  );

  parityTest(
    'readMcpRollupPrunedBefore answers null on an empty tally and the newest pruned_through otherwise',
    { methods: ['readMcpRollupPrunedBefore'] },
    async (engine, backend) => {
      const empty = await engine.readMcpRollupPrunedBefore();
      expect(empty.pruned_before).toBeNull();
      expect(empty.now).toBeInstanceOf(Date);
      await seedRollup(engine, backend, 'token-a', 20);
      await seedRollup(engine, backend, 'token-b', 12);
      const after = await engine.readMcpRollupPrunedBefore();
      expect(after.pruned_before).toBeInstanceOf(Date);
      const age = dayOffset(after.pruned_before, after.now);
      expect(age).toBe(12);
      return { empty: empty.pruned_before, age };
    },
  );
});
