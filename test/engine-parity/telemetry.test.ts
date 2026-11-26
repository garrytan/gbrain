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
 *  - Seam: the first fixtures below seed the request log and its tally with harness-only SQL behind the backend
 *    switch (as `createSource` does); the Rust arm, which runs no SQL, seeds them through the typed writers
 *    (logMcpRequest with a back-dated `created_at`, then one prune batch for a tally row). Clock values are mapped to
 *    booleans or day offsets.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchTelemetryBucket } from '../../src/core/engine-sql/telemetry.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { RUST_ENGINE_MEMBERS } from '../../src/core/rust-engine/members.ts';
import { CAPABILITY_REQUIRES, HELD_FOR_CALLERS, servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
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

/** Fixture: one request log row `ageDays` old. Harness-only SQL; the Rust arm writes it through logMcpRequest. */
async function seedRequest(engine: BrainEngine, backend: ParityBackend, row: { token: string | null; op: string; status: string; ageDays: number }) {
  switch (backend) {
    case 'rust':
      await engine.logMcpRequest({
        token_name: row.token, agent_name: 'agent-fork', operation: row.op, latency_ms: 5, status: row.status,
        created_at: new Date(Date.now() - row.ageDays * DAY_MS),
      });
      return;
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

/**
 * Fixture: one request log tally row whose pruned window ends `ageDays` ago. Harness-only SQL, as above; the Rust arm
 * logs one request `ageDays` old and prunes everything older than a day into the tally.
 */
async function seedRollup(engine: BrainEngine, backend: ParityBackend, token: string, ageDays: number) {
  switch (backend) {
    case 'rust':
      await seedRequest(engine, backend, { token, op: 'search', status: 'success', ageDays });
      await engine.pruneMcpRequestLogBatch(new Date(Date.now() - DAY_MS).toISOString(), [], 100);
      return;
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

  parityTest(
    'logChatUsage appends ledger rows and readChatUsage sums the window per model and phase in cost order',
    { methods: ['logChatUsage', 'readChatUsage'] },
    async (engine) => {
      const empty = await engine.readChatUsage(30);
      expect(empty).toEqual({ rows: [], logged_since: null });
      const log = (model: string, phase: string | null, cost: number | null, ageDays: number, tokens = 1) =>
        engine.logChatUsage({
          model, provider: model.split(':')[0]!, phase, input_tokens: tokens, output_tokens: 2 * tokens,
          cache_read_tokens: tokens > 1 ? 1 : 0, cache_write_tokens: 0, cost_usd: cost,
          created_at: new Date(Date.now() - ageDays * DAY_MS),
        });
      await log('acme:model-b', 'job:dream', 0.5, 1, 10);
      await log('acme:model-b', 'job:dream', 0.25, 2, 4);
      await log('acme:model-b', 'job:dream', null, 3);
      await log('acme:model-a', null, 0.625, 1, 3);
      // Equal sums: the tie breaks on model, then phase, in byte order (a null phase first).
      await log('acme:model-c', 'job:z', 0.25, 1);
      await log('acme:model-c', 'job:A', 0.25, 1);
      await log('acme:model-c', null, 0.25, 1);
      await log('acme:Model-c', 'job:z', 0.25, 1);
      // Unpriced groups sort after every priced one.
      await log('acme:unpriced', 'job:dream', null, 1);
      await log('acme:unpriced', null, null, 1, 7);
      // Outside a week, inside a month.
      await log('acme:model-old', 'job:dream', 4, 20, 100);
      const week = await engine.readChatUsage(7);
      const month = await engine.readChatUsage(30);
      const since = (text: string | null) => {
        expect(text).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/);
        return Math.round((Date.now() - Date.parse(text!.replace(' ', 'T').replace(/\+00$/, 'Z'))) / DAY_MS);
      };
      const order = (rows: typeof week.rows) => rows.map((r) => `${r.model}/${r.phase ?? '-'}`);
      expect(order(week.rows)).toEqual([
        'acme:model-b/job:dream', 'acme:model-a/-', 'acme:Model-c/job:z', 'acme:model-c/-', 'acme:model-c/job:A',
        'acme:model-c/job:z', 'acme:unpriced/-', 'acme:unpriced/job:dream',
      ]);
      expect(week.rows[0]).toEqual({
        model: 'acme:model-b', phase: 'job:dream', calls: 3, input_tokens: 15, output_tokens: 30, cache_read_tokens: 2,
        cache_write_tokens: 0, cost_usd: 0.75, unpriced_calls: 1,
      });
      expect(week.rows.find((r) => r.model === 'acme:unpriced' && r.phase === null)).toEqual({
        model: 'acme:unpriced', phase: null, calls: 1, input_tokens: 7, output_tokens: 14, cache_read_tokens: 1,
        cache_write_tokens: 0, cost_usd: null, unpriced_calls: 1,
      });
      expect(order(month.rows)[0]).toBe('acme:model-old/job:dream');
      expect(since(week.logged_since)).toBe(20);
      expect(week.logged_since).toBe(month.logged_since);
      return { empty, week: week.rows, month: month.rows, since: since(month.logged_since) };
    },
  );

  parityTest(
    'logChatUsage stamps the database clock when no time is given and refuses a null model',
    { methods: ['logChatUsage', 'readChatUsage'] },
    async (engine) => {
      await engine.logChatUsage({
        model: 'acme:model-a', provider: null, phase: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_write_tokens: 0, cost_usd: 0,
      });
      let refusal: string | null = null;
      try {
        await engine.logChatUsage({
          model: null as unknown as string, provider: null, phase: null, input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null,
        });
      } catch (e) {
        refusal = /null value in column "model"/.test(String((e as Error).message)) ? 'not_null' : String((e as Error).message);
      }
      const day = await engine.readChatUsage(1);
      const result = { refusal, rows: day.rows, hasSince: day.logged_since !== null };
      expect(result).toEqual({
        refusal: 'not_null', hasSince: true,
        rows: [{ model: 'acme:model-a', phase: null, calls: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
          cache_write_tokens: 0, cost_usd: 0, unpriced_calls: 0 }],
      });
      return result;
    },
  );

  // The Rust arm reports `telemetry` only once the store serves every member of it; serving some of them must leave the
  // reported capability list exactly as it was.
  test('the Rust capability list gains telemetry only when every telemetry member is served', () => {
    const members = Object.entries(RUST_ENGINE_MEMBERS).filter(([, cls]) => cls === 'telemetry').map(([m]) => m).sort();
    expect(members).toEqual([
      'applyRetrievalRatings', 'chronicleStore', 'countMcpRequestLogRows', 'countMcpRequestsLastDay',
      'countMcpRequestsLastDayByToken', 'countRecentChronicleReservations', 'deleteVolunteerEventsOlderThan', 'hasMcpLogRowsPastWindow',
      'hasPendingAutoChronicleRow', 'insertAccessReadLogRows', 'insertRetrievalEvents', 'insertVolunteerEvents',
      'listAccessReadPageRefs', 'logChatUsage', 'logMcpRequest', 'pruneAccessReadLog', 'pruneChronicleReservations',
      'pruneMcpRequestLogBatch', 'readAccessReadLog', 'readAccessReadsOfPages', 'readChatUsage', 'readChronicleRow',
      'readClientOpUsage', 'readMcpLifetimeUsage', 'readMcpLogPruneCutoff', 'readMcpRequestLogBytes',
      'readMcpRequestLogPage', 'readMcpRollupPrunedBefore', 'readPendingWriteHealth', 'readRetrievalEvent',
      'readSearchStats', 'readVolunteerUsage', 'recordSearchTelemetry', 'reserveChronicleJudgeSlot',
      'tallyAccessReadsOfPages', 'upsertChronicleRow',
    ]);
    const served = members.filter((m) => m in STORE_MEMBERS);
    const reported = servedCapabilities();
    expect({ allServed: served.length === members.length, reported: reported.has('telemetry') })
      .toEqual({ allServed: served.length === members.length, reported: served.length === members.length });
    // Every other capability is reported as it would be with no telemetry member at all.
    const withoutTelemetry = new Set<string>();
    const refusing = new Set<string>();
    for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS)) {
      if (cls === 'implemented' || cls === 'telemetry') continue;
      withoutTelemetry.add(cls);
      if (!(member in STORE_MEMBERS) || cls in HELD_FOR_CALLERS) refusing.add(cls);
    }
    const servedWithout = new Set([...withoutTelemetry].filter((c) => !refusing.has(c)));
    // A capability that needs another one (CAPABILITY_REQUIRES) is withheld until that one is served.
    for (const [cap, needs] of Object.entries(CAPABILITY_REQUIRES)) {
      if (needs!.some((need) => !servedWithout.has(need))) servedWithout.delete(cap);
    }
    const expected = [...servedWithout].sort();
    expect([...reported].filter((c) => c !== 'telemetry').map(String).sort()).toEqual(expected);
    // The store serves every telemetry member, so the Rust arm reports the capability.
    expect(served).toEqual(members);
    expect(reported.has('telemetry')).toBe(true);
  });

  parityTest(
    'readSearchStats keeps a row dated on the cutoff, matches nothing on a null cutoff, and takes the earliest first_seen and latest last_seen as UTC text',
    { methods: ['recordSearchTelemetry', 'readSearchStats'] },
    async (engine) => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
      const older = isoDay(-3);
      const newer = isoDay(-1);
      await engine.recordSearchTelemetry(bucket(older, 'balanced', 'entity', { count: 2 }));
      await pause();
      await engine.recordSearchTelemetry(bucket(newer, 'balanced', 'entity', { count: 5 }));
      await pause();
      await engine.recordSearchTelemetry(bucket(newer, 'balanced', 'entity', { count: 1 }));
      const onCutoff = await engine.readSearchStats(older);
      const newerOnly = await engine.readSearchStats(newer);
      const nullCutoff = await engine.readSearchStats(null as unknown as string);
      // Timestamp text is `YYYY-MM-DD HH:MM:SS[.fraction]+00`; compare instants in microseconds, never the text.
      const micros = (text: string) => {
        const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?\+00$/.exec(text);
        expect(m).not.toBeNull();
        return Date.parse(`${m![1]}T${m![2]}Z`) * 1000 + Number((m![3] ?? '').padEnd(6, '0'));
      };
      const [group] = onCutoff;
      const [newRow] = newerOnly;
      const result = {
        counts: { onCutoff: onCutoff.map((r) => r.count), newerOnly: newerOnly.map((r) => r.count) },
        nullCutoff,
        newerRowUpdated: micros(newRow!.first_seen) < micros(newRow!.last_seen),
        groupFirstIsOlderRow: micros(group!.first_seen) < micros(newRow!.first_seen),
        groupLastIsNewerRow: micros(group!.last_seen) === micros(newRow!.last_seen),
      };
      expect(result).toEqual({
        counts: { onCutoff: [8], newerOnly: [6] }, nullCutoff: [],
        newerRowUpdated: true, groupFirstIsOlderRow: true, groupLastIsNewerRow: true,
      });
      return result;
    },
  );

  parityTest(
    'recordSearchTelemetry refuses a null column in column order and writes nothing',
    { methods: ['recordSearchTelemetry', 'readSearchStats'] },
    async (engine) => {
      const today = isoDay(0);
      const refusal = async (b: SearchTelemetryBucket) => {
        try {
          await engine.recordSearchTelemetry(b);
          return null;
        } catch (e) {
          const message = (e as Error).message;
          return { problem: (e as { problem?: string }).problem ?? null, column: /column "(\w+)"/.exec(message)?.[1] ?? null };
        }
      };
      const nul = null as unknown as number;
      const result = {
        // sum_rank1_score comes before count_rank1 in the table, so it is named first.
        scoreBeforeRank1: await refusal(bucket(today, 'balanced', 'entity', { sum_rank1_score: nul, count_rank1: nul })),
        countBeforeScore: await refusal(bucket(today, 'balanced', 'entity', { count: nul, sum_rank1_score: nul })),
        rank1High: await refusal(bucket(today, 'balanced', 'entity', { rank1_high: nul })),
        written: await engine.readSearchStats(isoDay(-7)),
      };
      expect(result).toEqual({
        scoreBeforeRank1: { problem: null, column: 'sum_rank1_score' },
        countBeforeScore: { problem: null, column: 'count' },
        rank1High: { problem: null, column: 'rank1_high' },
        written: [],
      });
      return result;
    },
  );

  parityTest(
    'logMcpRequest appends rows and pruneMcpRequestLogBatch moves the oldest past the cutoff into the tally, keeping audit rows',
    { methods: ['logMcpRequest', 'readMcpLogPruneCutoff', 'pruneMcpRequestLogBatch', 'readClientOpUsage', 'readMcpRollupPrunedBefore'] },
    async (engine) => {
      const log = (token: string | null, operation: string, ageDays: number, extra: { params?: unknown; status?: string } = {}) =>
        engine.logMcpRequest({
          token_name: token, agent_name: 'agent-fork', operation, latency_ms: 7, status: extra.status ?? 'success',
          error_message: null, params: extra.params ?? null, created_at: new Date(Date.now() - ageDays * DAY_MS),
        });
      // Logged out of time order, so a prune that takes rows in insert order picks other rows.
      await log('token-a', 'search', 35, { params: { query: 'q', nested: { n: 1 } } });
      await log('token-b', 'get_page', 31);
      await log('token-a', 'surface_change', 50, { params: { via: 'cli' } });
      await log(null, 'search', 33);
      await log('token-a', 'search', 40);
      await log('token-b', 'get_page', 1);
      await engine.logMcpRequest({ token_name: 'token-c', agent_name: null, operation: 'tools/list', latency_ms: null, status: 'success' });
      const probe = await engine.readMcpLogPruneCutoff(30);
      expect(probe.rollup_present).toBe(true);
      expect(probe.cutoff).toBeInstanceOf(Date);
      const cutoff = (probe.cutoff as Date).toISOString();
      const keep = ['surface_change'];
      const age = (v: unknown) => (v === null ? null : dayOffset(v, new Date()));
      const first = await engine.pruneMcpRequestLogBatch(cutoff, keep, 2);
      const second = await engine.pruneMcpRequestLogBatch(cutoff, keep, 100);
      const third = await engine.pruneMcpRequestLogBatch(cutoff, keep, 100);
      const pruned = await engine.readMcpRollupPrunedBefore();
      const usage = sorted(await engine.readClientOpUsage(365), r => `${r.token_name}/${r.operation}`)
        .map(r => ({ token_name: r.token_name, operation: r.operation, n: r.n, age: age(r.last_seen) }));
      const result = {
        cutoffAge: age(probe.cutoff),
        batches: [first, second, third].map(b => ({ deleted: b.deleted, newest: age(b.newest) })),
        prunedBefore: dayOffset(pruned.pruned_before, pruned.now),
        usage,
      };
      expect(result).toEqual({
        cutoffAge: 30,
        batches: [{ deleted: 2, newest: 35 }, { deleted: 2, newest: 31 }, { deleted: 0, newest: null }],
        prunedBefore: 31,
        usage: [
          { token_name: 'token-a', operation: 'surface_change', n: 1, age: 50 },
          { token_name: 'token-b', operation: 'get_page', n: 1, age: 1 },
          { token_name: 'token-c', operation: 'tools/list', n: 1, age: 0 },
        ],
      });
      return result;
    },
  );

  parityTest(
    'logMcpRequest refuses a null operation or status and pruneMcpRequestLogBatch takes nothing past an empty window',
    { methods: ['logMcpRequest', 'pruneMcpRequestLogBatch', 'readClientOpUsage', 'readMcpRollupPrunedBefore'] },
    async (engine) => {
      const refusal = async (row: Parameters<BrainEngine['logMcpRequest']>[0]) => {
        try {
          await engine.logMcpRequest(row);
          return null;
        } catch (e) {
          return /column "(\w+)" of relation "(\w+)"/.exec((e as Error).message)?.slice(1) ?? (e as Error).message;
        }
      };
      const nul = null as unknown as string;
      const base = { token_name: 'token-a', agent_name: null, latency_ms: 1 };
      const result = {
        operation: await refusal({ ...base, operation: nul, status: 'success' }),
        status: await refusal({ ...base, operation: 'search', status: nul }),
        // Nothing is older than a cutoff 400 days back; an operation on the keep list is never taken.
        none: await engine.pruneMcpRequestLogBatch(new Date(Date.now() - 400 * DAY_MS).toISOString(), [], 100),
        kept: null as unknown,
        usage: [] as unknown[],
        prunedBefore: null as unknown,
      };
      await engine.logMcpRequest({ ...base, operation: 'search', status: 'success', created_at: new Date(Date.now() - 5 * DAY_MS) });
      result.kept = await engine.pruneMcpRequestLogBatch(new Date().toISOString(), ['search'], 100);
      result.usage = (await engine.readClientOpUsage(30)).map(r => ({ token_name: r.token_name, operation: r.operation, n: r.n }));
      result.prunedBefore = (await engine.readMcpRollupPrunedBefore()).pruned_before;
      expect(result).toEqual({
        operation: ['operation', 'mcp_request_log'],
        status: ['status', 'mcp_request_log'],
        none: { deleted: 0, newest: null },
        kept: { deleted: 0, newest: null },
        usage: [{ token_name: 'token-a', operation: 'search', n: 1 }],
        prunedBefore: null,
      });
      return result;
    },
  );

  parityTest(
    'readMcpLifetimeUsage counts kept requests plus the pruned tally per asked token, in token byte order',
    { methods: ['logMcpRequest', 'pruneMcpRequestLogBatch', 'readMcpLifetimeUsage'] },
    async (engine) => {
      const log = (token: string | null, operation: string, ageDays: number, status = 'success') =>
        engine.logMcpRequest({
          token_name: token, agent_name: null, operation, latency_ms: 3, status,
          created_at: new Date(Date.now() - ageDays * DAY_MS),
        });
      // Every status and operation counts, as the dashboard's total_requests does.
      await log('token-a', 'query', 40);
      await log('token-a', 'search', 35, 'error');
      await log('token-a', 'tools/list', 2, 'denied_after_list');
      await log('token-b', 'get_page', 50);
      await log(null, 'tools/list', 45, 'auth_failed');
      await log('Zed', 'query', 3);
      await log('token-c', 'query', 1);
      // Never asked: neither its kept row nor, after the prune, its tally row may show.
      await log('token-d', 'query', 60);
      // The legacy HTTP transport's row: no agent, no time, no params.
      await engine.logMcpRequest({ token_name: null, agent_name: null, operation: 'tools/list', latency_ms: 4, status: 'auth_failed' });
      // A null and a repeated name match nothing extra; 'unknown' was never logged; '' is the null-token tally key.
      const ask = ['token-b', 'token-a', null as unknown as string, 'unknown', 'Zed', '', 'token-a'];
      const shape = async () => (await engine.readMcpLifetimeUsage(ask)).map(r => ({
        token_name: r.token_name, requests: r.requests, age: r.last_used_at === null ? null : dayOffset(r.last_used_at, new Date()),
      }));
      const before = await shape();
      const pruned = await engine.pruneMcpRequestLogBatch(new Date(Date.now() - 30 * DAY_MS).toISOString(), [], 100);
      const result = { before, prunedRows: pruned.deleted, after: await shape(), empty: await engine.readMcpLifetimeUsage([]) };
      expect(result).toEqual({
        before: [
          { token_name: 'Zed', requests: 1, age: 3 },
          { token_name: 'token-a', requests: 3, age: 2 },
          { token_name: 'token-b', requests: 1, age: 50 },
        ],
        prunedRows: 5,
        // token-b now lives only in the tally; the pruned null-token row counts under ''.
        after: [
          { token_name: '', requests: 1, age: 45 },
          { token_name: 'Zed', requests: 1, age: 3 },
          { token_name: 'token-a', requests: 3, age: 2 },
          { token_name: 'token-b', requests: 1, age: 50 },
        ],
        empty: [],
      });
      return result;
    },
  );
});
