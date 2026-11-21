/**
 * Before/after parity for the decide statements that changed text when they moved behind BrainEngine members
 * (src/core/engine-sql/decide-proposals.ts and decide-store.ts, from src/core/ai/decide/*.ts at 1f8d079d13).
 *
 * Each case runs master's exact statement text (copied below, with master's run-time text building reproduced where
 * master built text at run time) on one fresh fixture, and the new engine member on a second fixture, in lockstep.
 * After every step the two tables must hold the same rows in every column, and a member that answers a row count must
 * answer the number of rows the step really changed (read from the table, not from the statement).
 *
 * 1. Protects: the five statements that gained `RETURNING` (applyDecideReviewQueue enqueue/clear/defer,
 *    applyDecideSweepDeferred defer/clear), setDecideCalibrationRetired (one `CASE WHEN $2::boolean` statement where
 *    master spliced `now()` or `NULL` into the text), and insertDecideSpend / insertDecideReceipts (constant text where
 *    master's `insertRows` built it) write the same rows as before, on the insert, conflict and zero-match paths.
 * 2. Fails when: the new text changes a predicate, a conflict rule, an arithmetic term, a CASE branch, a cast or a
 *    column position; or a member's returned count stops matching the rows it changed. A disk-level difference is
 *    caught one step at a time, so the step that breaks is the failing line.
 * 3. Existing coverage: test/engine-parity/decide-proposals.test.ts and decide-store.test.ts compare the engines with
 *    each other through the typed members; neither compares a new statement with the statement master ran, and a
 *    Rust engine has no raw SQL to run master's text.
 * 4. Seam: none. Real engines, the typed members as the "after", `executeRaw` with master's text as the "before".
 *    Timestamps: a creation or retire stamp is compared as null or not null; `next_attempt_at` as whole minutes from
 *    now (the back-off arithmetic), which the test run cannot move by a minute.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply: master's text is SQL, and test/engine-parity/ owns the cross-engine answers of these members.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// ---------------------------------------------------------------- master's statements, verbatim from 1f8d079d13

/** src/core/ai/decide/review-lane.ts:103 (enqueueReviewCandidate). */
const MASTER_QUEUE_ENQUEUE = `INSERT INTO decide_review_queue(kind,source_id,a_ref,b_ref,evidence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`;
/** src/core/ai/decide/review-lane.ts:148 (clearQueue). */
const MASTER_QUEUE_CLEAR = 'DELETE FROM decide_review_queue WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4';
/** src/core/ai/decide/review-lane.ts:152 (deferQueue). */
const MASTER_QUEUE_DEFER = `UPDATE decide_review_queue SET attempts = attempts + 1, reason = $5,
      next_attempt_at = now() + ((attempts + 1) * interval '10 minutes')
    WHERE kind=$1 AND source_id=$2 AND a_ref=$3 AND b_ref=$4`;
/** src/core/ai/decide/proposals-store.ts:126 (deferFact); `$4` is DEFERRED_BACKOFF_MINUTES. */
const MASTER_DEFERRED_DEFER = `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at)
     VALUES ($1, $2, 'conflict', $3, 1, now() + ($4::int * interval '1 minute'))
     ON CONFLICT (slot, source_id, fact_id) DO UPDATE SET reason = EXCLUDED.reason,
       attempts = decide_sweep_deferred.attempts + 1,
       next_attempt_at = now() + ($4::int * (decide_sweep_deferred.attempts + 1) * interval '1 minute')`;
const MASTER_BACKOFF_MINUTES = 30;
/** src/core/ai/decide/proposals-store.ts:152 (clearDeferred). */
const MASTER_DEFERRED_CLEAR = `DELETE FROM decide_sweep_deferred WHERE slot = 'conflict' AND source_id = $1 AND fact_id = $2`;

/** src/core/ai/decide/review-lane.ts:377 (listReviewProposals), the text and the row mapping master used. */
const MASTER_REVIEW_LIST = `SELECT id, kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, status,
            created_at::text, decided_at::text, receipt
       FROM decide_review_proposals WHERE ($1 = 'all' OR status = $1) ORDER BY id`;

/** src/core/ai/decide/store.ts:375 (setCalibrationRetired): the text master sent for retire (true) and restore (false). */
function masterRetireSql(retired: boolean): string {
  return `UPDATE decide_calibrations SET retired_at = ${retired ? 'now()' : 'NULL'} WHERE id = $1 RETURNING id`;
}

/** src/core/ai/decide/store.ts:64-77, the column lists master's two writers passed to `insertRows`. */
const MASTER_RECEIPT_COLUMNS = [
  ['decision_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['mode', 'text'], ['provider', 'text'],
  ['model_alias', 'text'], ['model_resolved', 'text'], ['question_kind', 'text'], ['state_hash', 'text'],
  ['question_hash', 'text'], ['answer_value', 'real'], ['answer_choice', 'text'], ['confidence', 'real'],
  ['threshold', 'real'], ['outcome', 'text'], ['subject_ref', 'text'], ['call_site', 'text'], ['lane', 'text'],
  ['policy_fingerprint', 'text'], ['calibration_ref', 'text'], ['latency_ms', 'int'], ['input_tokens', 'int'],
  ['error_reason', 'text'], ['protected', 'boolean'], ['min_keep', 'int'], ['rank', 'int'], ['k_used', 'int'],
  ['remote', 'boolean'], ['run_meta', 'text'],
] as const;
const MASTER_SPEND_COLUMNS = [
  ['request_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['provider', 'text'], ['model_resolved', 'text'],
  ['lane', 'text'], ['remote', 'boolean'], ['input_tokens', 'int'], ['cost_usd', 'float8'], ['outcome', 'text'],
] as const;

/** src/core/ai/decide/store.ts:90-103 (insertRows), unchanged: it builds the statement text at run time. */
async function masterInsertRows(engine: BrainEngine, table: string, columns: readonly (readonly [string, string])[], rows: readonly object[], conflict = ''): Promise<void> {
  if (rows.length === 0) return;
  const defaults: Record<string, unknown> = { protected: false, remote: false };
  const params = columns.map(([name]) => rows.map((r) => {
    const v = (r as Record<string, unknown>)[name];
    const value = v === undefined ? (defaults[name] ?? null) : v;
    return value === null ? null : String(value);
  }));
  const names = columns.map(([name]) => name).join(', ');
  const casts = columns.map(([, type], i) => (type === 'text' ? `$${i + 1}::text[]` : `$${i + 1}::text[]::${type}[]`)).join(', ');
  await engine.executeRaw(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${casts}) ${conflict}`, params);
}

// ---------------------------------------------------------------- fixtures

interface Fixture { before: BrainEngine; after: BrainEngine }

const TABLES = ['decide_review_proposals', 'decide_review_queue', 'decide_sweep_deferred', 'decide_spend', 'decision_receipts', 'decide_calibrations'] as const;
type Table = typeof TABLES[number];
const KEYS: Record<Table, string[]> = {
  decide_review_proposals: ['id'],
  decide_review_queue: ['kind', 'source_id', 'a_ref', 'b_ref'],
  decide_sweep_deferred: ['slot', 'source_id', 'fact_id'],
  decide_spend: ['request_id'],
  decision_receipts: ['id'],
  decide_calibrations: ['id'],
};

/** Every column of `table`, in table order, as comparable values (see the header for the timestamp rule). */
async function normalized(engine: BrainEngine, table: Table): Promise<Array<Record<string, unknown>>> {
  const cols = await engine.executeRaw<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
  expect(cols.length).toBeGreaterThan(0);
  const select = cols.map(({ column_name: c, data_type: t }) => {
    if (t !== 'timestamp with time zone') return `${c}::text AS ${c}`;
    if (c === 'next_attempt_at') return `round(extract(epoch FROM (${c} - now())) / 60)::int AS ${c}_minutes_from_now`;
    return `(${c} IS NOT NULL) AS ${c}_set`;
  });
  return engine.executeRaw(`SELECT ${select.join(', ')} FROM ${table} ORDER BY ${KEYS[table].join(', ')}`);
}

/** Whole rows, timestamps included, keyed by primary key: what a step really changed is read from these. */
async function wholeRows(engine: BrainEngine, table: Table): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ k: string; j: unknown }>(
    `SELECT ${KEYS[table].map((c) => `${c}::text`).join(` || '|' || `)} AS k, to_jsonb(t) AS j FROM ${table} t`);
  return new Map(rows.map((r) => [r.k, JSON.stringify(r.j)]));
}

/** Rows inserted, deleted or modified between two snapshots. */
function changedRows(a: Map<string, string>, b: Map<string, string>): number {
  let n = 0;
  for (const [k, v] of b) if (a.get(k) !== v) n++;
  for (const k of a.keys()) if (!b.has(k)) n++;
  return n;
}

interface Step<B, A> { before: B; after: A; changed: number }

/**
 * One lockstep step: run `before` (master's text) on the before fixture and `after` (the member) on the after fixture,
 * then require the two tables to hold the same rows, and the same number of changed rows.
 */
async function step<B, A>(f: Fixture, table: Table, before: (e: BrainEngine) => Promise<B>, after: (e: BrainEngine) => Promise<A>): Promise<Step<B, A>> {
  const [b0, a0] = [await wholeRows(f.before, table), await wholeRows(f.after, table)];
  const b = await before(f.before);
  const a = await after(f.after);
  const changedBefore = changedRows(b0, await wholeRows(f.before, table));
  const changedAfter = changedRows(a0, await wholeRows(f.after, table));
  expect(await normalized(f.after, table)).toEqual(await normalized(f.before, table));
  expect(changedAfter).toBe(changedBefore);
  return { before: b, after: a, changed: changedAfter };
}

/** Run a step that must be refused on both fixtures (a NOT NULL column, say) with no row left behind on either. */
async function refusedStep(f: Fixture, table: Table, before: (e: BrainEngine) => Promise<unknown>, after: (e: BrainEngine) => Promise<unknown>): Promise<void> {
  const [b0, a0] = [await wholeRows(f.before, table), await wholeRows(f.after, table)];
  await expect(before(f.before)).rejects.toThrow();
  await expect(after(f.after)).rejects.toThrow();
  expect(await wholeRows(f.before, table)).toEqual(b0);
  expect(await wholeRows(f.after, table)).toEqual(a0);
  expect(await normalized(f.after, table)).toEqual(await normalized(f.before, table));
}

/** Seed both fixtures with the same plain INSERTs (never a member under test). */
async function seed(f: Fixture, sql: string, params: unknown[] = []): Promise<void> {
  await f.before.executeRaw(sql, params);
  await f.after.executeRaw(sql, params);
}

async function reset(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
}

// ---------------------------------------------------------------- cases

for (const kind of testBackends()) {
  describe(`decide statements before and after the move (${kind})`, () => {
    let f: Fixture;
    const closers: Array<() => Promise<void>> = [];

    beforeAll(async () => {
      const engines: BrainEngine[] = [];
      for (let i = 0; i < 2; i++) { // two identical fresh brains: master's statements run on the first, the members on the second
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
          engines.push(pg.engine);
          closers.push(pg.close);
        } else {
          const engine = new PGLiteEngine();
          await engine.connect({ engine: 'pglite' } as never);
          await engine.initSchema();
          engines.push(engine);
          closers.push(() => engine.disconnect());
        }
      }
      f = { before: engines[0]!, after: engines[1]! };
    }, 120_000);
    afterAll(async () => { for (const close of closers) await close(); });
    beforeEach(async () => { await reset(f.before); await reset(f.after); });

    // -------- decide-proposals.ts:279 applyDecideReviewQueue enqueue
    test('queue enqueue: a new pair is queued once, a duplicate changes nothing, and the count says so', async () => {
      const enqueue = (kind_: string, source: string, a: string, b: string, evidence: string | null) => step(f, 'decide_review_queue',
        (e) => e.executeRaw(MASTER_QUEUE_ENQUEUE, [kind_, source, a, b, evidence]),
        (e) => e.applyDecideReviewQueue({ op: 'enqueue', kind: kind_, source_id: source, a_ref: a, b_ref: b, evidence }));
      const first = await enqueue('duplicate_page', 'default', 'a', 'b', 'cosine 0.86');
      expect(first.after).toBe(1);
      expect(first.changed).toBe(1);
      // The same pair again with other evidence: ON CONFLICT DO NOTHING keeps the first row and answers 0.
      const duplicate = await enqueue('duplicate_page', 'default', 'a', 'b', 'cosine 0.99');
      expect(duplicate.after).toBe(0);
      expect(duplicate.changed).toBe(0);
      // Each key part separates a row: kind, source, a_ref, b_ref; null evidence stays null.
      for (const [k, s, a, b, ev] of [['duplicate_entity', 'default', 'a', 'b', null], ['duplicate_page', 'other', 'a', 'b', 'x'],
        ['duplicate_page', 'default', 'a2', 'b', 'x'], ['duplicate_page', 'default', 'a', 'b2', null]] as const) {
        const added = await enqueue(k, s, a, b, ev);
        expect(added.after).toBe(1);
        expect(added.changed).toBe(1);
      }
      const [{ n }] = await f.after.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM decide_review_queue');
      expect(Number(n)).toBe(5);
      const kept = await f.after.executeRaw<{ evidence: string | null }>(`SELECT evidence FROM decide_review_queue WHERE kind = 'duplicate_page' AND source_id = 'default' AND a_ref = 'a' AND b_ref = 'b'`);
      expect(kept).toEqual([{ evidence: 'cosine 0.86' }]);
    });

    // -------- decide-proposals.ts:284 applyDecideReviewQueue clear
    test('queue clear: the row with all four key parts goes, a near miss deletes nothing, and the count matches', async () => {
      for (const [k, s, a, b] of [['duplicate_page', 'default', 'a', 'b'], ['duplicate_entity', 'default', 'a', 'b'], ['duplicate_page', 'other', 'a', 'b'],
        ['duplicate_page', 'default', 'a2', 'b'], ['duplicate_page', 'default', 'a', 'b2']]) {
        await seed(f, `INSERT INTO decide_review_queue (kind, source_id, a_ref, b_ref, evidence) VALUES ($1, $2, $3, $4, 'seed')`, [k, s, a, b]);
      }
      const clear = (k: string, s: string, a: string, b: string) => step(f, 'decide_review_queue',
        (e) => e.executeRaw(MASTER_QUEUE_CLEAR, [k, s, a, b]),
        (e) => e.applyDecideReviewQueue({ op: 'clear', kind: k, source_id: s, a_ref: a, b_ref: b }));
      for (const miss of [['duplicate_page', 'default', 'a', 'zz'], ['duplicate_page', 'default', 'zz', 'b'], ['duplicate_page', 'nope', 'a', 'b'], ['nope', 'default', 'a', 'b']] as const) {
        const none = await clear(miss[0], miss[1], miss[2], miss[3]);
        expect(none.after).toBe(0);
        expect(none.changed).toBe(0);
      }
      const hit = await clear('duplicate_page', 'default', 'a', 'b');
      expect(hit.after).toBe(1);
      expect(hit.changed).toBe(1);
      const again = await clear('duplicate_page', 'default', 'a', 'b');
      expect(again.after).toBe(0);
      expect(again.changed).toBe(0);
      const [{ n }] = await f.after.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM decide_review_queue');
      expect(Number(n)).toBe(4);
    });

    // -------- decide-proposals.ts:287 applyDecideReviewQueue defer
    test('queue defer: attempts, reason and the 10-minute back-off move on the matching row only; a miss changes nothing', async () => {
      for (const [k, s, a, b] of [['duplicate_page', 'default', 'a', 'b'], ['duplicate_page', 'default', 'a', 'b2'], ['duplicate_entity', 'default', 'a', 'b'], ['duplicate_page', 'other', 'a', 'b']]) {
        await seed(f, `INSERT INTO decide_review_queue (kind, source_id, a_ref, b_ref, evidence) VALUES ($1, $2, $3, $4, 'seed')`, [k, s, a, b]);
      }
      const defer = (k: string, s: string, a: string, b: string, reason: string) => step(f, 'decide_review_queue',
        (e) => e.executeRaw(MASTER_QUEUE_DEFER, [k, s, a, b, reason]),
        (e) => e.applyDecideReviewQueue({ op: 'defer', kind: k, source_id: s, a_ref: a, b_ref: b, reason }));
      const one = await defer('duplicate_page', 'default', 'a', 'b', 'provider timeout');
      expect(one.after).toBe(1);
      expect(one.changed).toBe(1);
      const two = await defer('duplicate_page', 'default', 'a', 'b', 'provider timeout again');
      expect(two.after).toBe(1);
      expect(two.changed).toBe(1);
      const rows = await normalized(f.after, 'decide_review_queue');
      const hit = rows.find((r) => r.kind === 'duplicate_page' && r.source_id === 'default' && r.a_ref === 'a' && r.b_ref === 'b')!;
      expect(hit).toMatchObject({ attempts: '2', reason: 'provider timeout again', next_attempt_at_minutes_from_now: 20 });
      expect(rows.filter((r) => r.attempts === '0')).toHaveLength(3);
      for (const miss of [['duplicate_page', 'default', 'a', 'zz'], ['duplicate_page', 'nope', 'a', 'b'], ['nope', 'default', 'a', 'b']] as const) {
        const none = await defer(miss[0], miss[1], miss[2], miss[3], 'no such row');
        expect(none.after).toBe(0);
        expect(none.changed).toBe(0);
      }
    });

    // -------- decide-proposals.ts:323 applyDecideSweepDeferred defer
    test('sweep defer: a new fact backs off 30 minutes, a repeat adds an attempt and multiplies the back-off, and the count matches', async () => {
      const defer = (source: string, fact: number, reason: string) => step(f, 'decide_sweep_deferred',
        (e) => e.executeRaw(MASTER_DEFERRED_DEFER, [source, fact, reason, MASTER_BACKOFF_MINUTES]),
        (e) => e.applyDecideSweepDeferred(source, { op: 'defer', fact_id: fact, reason }));
      // A row handed over by a relink (attempts 0, due now) is the other way a row exists before the first defer.
      await seed(f, `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts, next_attempt_at) VALUES ('default', 9, 'conflict', 'relinked', 0, now())`);
      for (const [attempt, minutes] of [[1, 30], [2, 60], [3, 90], [4, 120]] as const) {
        const r = await defer('default', 7, `retry ${attempt}`);
        expect(r.after).toBe(1);
        expect(r.changed).toBe(1);
        const row = (await normalized(f.after, 'decide_sweep_deferred')).find((x) => x.fact_id === '7')!;
        expect(row).toMatchObject({ attempts: String(attempt), reason: `retry ${attempt}`, next_attempt_at_minutes_from_now: minutes });
      }
      const relinked = await defer('default', 9, 'transient');
      expect(relinked.after).toBe(1);
      expect(relinked.changed).toBe(1);
      expect((await normalized(f.after, 'decide_sweep_deferred')).find((x) => x.fact_id === '9')).toMatchObject({ attempts: '1', reason: 'transient', next_attempt_at_minutes_from_now: 30 });
      // Another source's fact with the same id is its own row, and the first one is untouched.
      const other = await defer('other', 7, 'other source');
      expect(other.after).toBe(1);
      expect(other.changed).toBe(1);
      const rows = await normalized(f.after, 'decide_sweep_deferred');
      expect(rows.filter((r) => r.fact_id === '7').map((r) => [r.source_id, r.attempts])).toEqual([['default', '4'], ['other', '1']]);
    });

    // -------- decide-proposals.ts:342 applyDecideSweepDeferred clear
    test('sweep clear: only the conflict row of that source and fact goes; another slot, source or fact stays; a miss counts 0', async () => {
      for (const [slot, source, fact] of [['conflict', 'default', 7], ['conflict', 'default', 8], ['conflict', 'other', 7], ['other_slot', 'default', 7]] as const) {
        await seed(f, `INSERT INTO decide_sweep_deferred (source_id, fact_id, slot, reason, attempts) VALUES ($1, $2, $3, 'seed', 2)`, [source, fact, slot]);
      }
      const clear = (source: string, fact: number) => step(f, 'decide_sweep_deferred',
        (e) => e.executeRaw(MASTER_DEFERRED_CLEAR, [source, fact]),
        (e) => e.applyDecideSweepDeferred(source, { op: 'clear', fact_id: fact }));
      const hit = await clear('default', 7);
      expect(hit.after).toBe(1);
      expect(hit.changed).toBe(1);
      for (const miss of [['default', 7], ['default', 99], ['nobody', 7]] as const) {
        const none = await clear(miss[0], miss[1]);
        expect(none.after).toBe(0);
        expect(none.changed).toBe(0);
      }
      const left = await f.after.executeRaw<{ slot: string; source_id: string; fact_id: number | string }>('SELECT slot, source_id, fact_id FROM decide_sweep_deferred ORDER BY slot, source_id, fact_id');
      expect(left.map((r) => [r.slot, r.source_id, Number(r.fact_id)])).toEqual([['conflict', 'default', 8], ['conflict', 'other', 7], ['other_slot', 'default', 7]]);
    });

    // -------- decide-proposals.ts:158 listDecideReviewProposals (the `all` / `status = $1` split)
    test('review proposal listing: each status, `all` and an unknown status return the rows master\'s one filter returned, in id order', async () => {
      const statuses = ['accepted', 'pending', 'rejected', 'pending', 'stale', 'accepting', 'accepted_no_action', 'pending', 'accepted'];
      for (const [i, status] of statuses.entries()) {
        await seed(f, `INSERT INTO decide_review_proposals (kind, source_id, sweep_id, a_ref, b_ref, subject, visibility, p_action, threshold, model_resolved, question_version, receipt, status, created_at, decided_at)
          VALUES ($1, 'default', 'sweep', $2, 'b', '*', $3, $4, $5, 'm', '1', $6, $7, '2026-06-18 09:00:00.5+00', $8)`,
        [i % 2 ? 'duplicate_entity' : 'duplicate_page', `a${i}`, i % 3 ? null : 'private', 0.1 + i / 10, i % 4 ? 0.6 : null, i % 2 ? '{"k":1}' : null, status, status === 'pending' ? null : '2026-06-19 10:00:00+00']);
      }
      const master = async (e: BrainEngine, status: string) => (await e.executeRaw<Record<string, any>>(MASTER_REVIEW_LIST, [status]))
        .map((r) => ({ ...r, id: Number(r.id), p_action: Number(r.p_action), threshold: r.threshold === null ? null : Number(r.threshold) }));
      const seen: Record<string, number> = {};
      for (const status of ['pending', 'accepting', 'accepted', 'rejected', 'stale', 'accepted_no_action', 'all', 'withdrawn', '', 'ALL']) {
        const before = await master(f.before, status);
        const after = await f.after.listDecideReviewProposals(status);
        expect(after).toEqual(before as never);
        expect(after.map((r) => r.id)).toEqual([...after.map((r) => r.id)].sort((a, b) => a - b));
        seen[status] = after.length;
      }
      expect(seen).toEqual({ pending: 3, accepting: 1, accepted: 2, rejected: 1, stale: 1, accepted_no_action: 1, all: 9, withdrawn: 0, '': 0, ALL: 0 });
    });

    // -------- decide-store.ts:460 setDecideCalibrationRetired
    test('calibration retire and restore: retired_at is stamped or cleared on the one row, and the answer says whether the row exists', async () => {
      for (let i = 0; i < 3; i++) {
        await seed(f, `INSERT INTO decide_calibrations (slot, call_site, provider, model_resolved, threshold, metric, n, pack_shape, notes)
          VALUES ('conflict', $1, 'p', 'm', 0.5, 'f1', 10, 'shape', $2)`, [`site-${i}`, `note ${i}`]);
      }
      const toggle = (id: number, retired: boolean) => step(f, 'decide_calibrations',
        async (e) => (await e.executeRaw(masterRetireSql(retired), [id])).length > 0,
        (e) => e.setDecideCalibrationRetired(id, retired));
      const retire2 = await toggle(2, true);
      expect(retire2.after).toBe(true);
      expect(retire2.before).toBe(true);
      expect((await normalized(f.after, 'decide_calibrations')).map((r) => [r.id, r.retired_at_set])).toEqual([['1', false], ['2', true], ['3', false]]);
      // Retiring again keeps it retired; restoring clears it; restoring a live row is a no-op that still finds the row.
      expect((await toggle(2, true)).after).toBe(true);
      expect((await normalized(f.after, 'decide_calibrations')).map((r) => r.retired_at_set)).toEqual([false, true, false]);
      expect((await toggle(2, false)).after).toBe(true);
      expect((await normalized(f.after, 'decide_calibrations')).map((r) => r.retired_at_set)).toEqual([false, false, false]);
      expect((await toggle(2, false)).after).toBe(true);
      expect((await toggle(1, true)).after).toBe(true);
      expect((await toggle(3, true)).after).toBe(true);
      expect((await normalized(f.after, 'decide_calibrations')).map((r) => r.retired_at_set)).toEqual([true, false, true]);
      // A missing id answers false for both directions and changes nothing.
      for (const retired of [true, false]) {
        const none = await toggle(99, retired);
        expect(none.before).toBe(false);
        expect(none.after).toBe(false);
        expect(none.changed).toBe(0);
      }
      expect((await normalized(f.after, 'decide_calibrations')).map((r) => r.retired_at_set)).toEqual([true, false, true]);
    });

    // -------- decide-store.ts:95 insertDecideSpend
    test('spend insert: the same rows, casts and conflict rule as master\'s run-time text, an unset boolean is false, a refused batch records none', async () => {
      const insert = (rows: Array<Record<string, unknown>>) => step(f, 'decide_spend',
        (e) => masterInsertRows(e, 'decide_spend', MASTER_SPEND_COLUMNS, rows, 'ON CONFLICT (request_id) DO NOTHING'),
        (e) => e.insertDecideSpend(rows as never));
      expect((await insert([])).changed).toBe(0);
      const first = await insert([
        { request_id: 'r1', source_id: 'default', slot: 'conflict', provider: 'typesafe:a', model_resolved: 'm1', lane: 'sweep', remote: true, input_tokens: 120, cost_usd: 0.1234567890123, outcome: 'ok' },
        { request_id: 'r2', slot: 'review', provider: 'typesafe:b', lane: 'review', input_tokens: 0, cost_usd: 0, outcome: 'failed' },
        { request_id: 'r3', source_id: null, slot: 'conflict', provider: 'p', model_resolved: null, lane: 'sweep', remote: false, input_tokens: 2147483647, cost_usd: 1e-9, outcome: 'timeout' },
      ]);
      expect(first.changed).toBe(3);
      // A request id already recorded keeps its first row, in this batch and in a later one; the new id goes in.
      const repeat = await insert([
        { request_id: 'r1', source_id: 'other', slot: 'review', provider: 'zzz', lane: 'x', remote: false, input_tokens: 1, cost_usd: 9, outcome: 'ok' },
        { request_id: 'r4', slot: 'conflict', provider: 'p', lane: 'sweep', input_tokens: 5, cost_usd: 0.5, outcome: 'ok' },
        { request_id: 'r4', slot: 'conflict', provider: 'q', lane: 'sweep', input_tokens: 6, cost_usd: 0.6, outcome: 'ok' },
      ]);
      expect(repeat.changed).toBe(1);
      const rows = await normalized(f.after, 'decide_spend');
      expect(rows.map((r) => [r.request_id, r.remote, r.input_tokens, r.cost_usd, r.source_id, r.model_resolved])).toEqual([
        ['r1', 'true', '120', '0.1234567890123', 'default', 'm1'],
        ['r2', 'false', '0', '0', null, null],
        ['r3', 'false', '2147483647', '1e-09', null, null],
        ['r4', 'false', '5', '0.5', null, null],
      ]);
      // A missing NOT NULL column (outcome, then input_tokens) refuses the whole batch on both sides.
      await refusedStep(f, 'decide_spend',
        (e) => masterInsertRows(e, 'decide_spend', MASTER_SPEND_COLUMNS, [{ request_id: 'ok', slot: 's', provider: 'p', lane: 'l', input_tokens: 1, cost_usd: 1, outcome: 'ok' }, { request_id: 'bad', slot: 's', provider: 'p', lane: 'l', input_tokens: 1, cost_usd: 1 }], 'ON CONFLICT (request_id) DO NOTHING'),
        (e) => e.insertDecideSpend([{ request_id: 'ok', slot: 's', provider: 'p', lane: 'l', input_tokens: 1, cost_usd: 1, outcome: 'ok' }, { request_id: 'bad', slot: 's', provider: 'p', lane: 'l', input_tokens: 1, cost_usd: 1 } as never]));
      await refusedStep(f, 'decide_spend',
        (e) => masterInsertRows(e, 'decide_spend', MASTER_SPEND_COLUMNS, [{ request_id: 'bad', slot: 's', provider: 'p', lane: 'l', cost_usd: 1, outcome: 'ok' }], 'ON CONFLICT (request_id) DO NOTHING'),
        (e) => e.insertDecideSpend([{ request_id: 'bad', slot: 's', provider: 'p', lane: 'l', cost_usd: 1, outcome: 'ok' }]));
    });

    // -------- decide-store.ts:189 insertDecideReceipts
    test('receipt insert: the same rows, casts, column order and ids as master\'s run-time text; unset booleans are false; a refused batch records none', async () => {
      const full = (n: number): Record<string, unknown> => ({
        decision_id: `d${n}`, source_id: 'default', slot: 'conflict', mode: 'act', provider: 'typesafe:a', model_alias: 'fast', model_resolved: 'm1',
        question_kind: 'pair', state_hash: `s${n}`, question_hash: `q${n}`, answer_value: 0.1 + n / 100, answer_choice: 'yes', confidence: 0.87654321 - n / 1000,
        threshold: 0.75, outcome: 'ok', subject_ref: `fact:${n}`, call_site: 'sweep', lane: 'sweep', policy_fingerprint: 'fp', calibration_ref: 'cal:1',
        latency_ms: 150 + n, input_tokens: 2000, error_reason: null, protected: true, min_keep: 3, rank: n, k_used: 5, remote: true, run_meta: '{"a":1,"b":[2,3]}',
      });
      const minimal = (n: number): Record<string, unknown> => ({ decision_id: `m${n}`, slot: 'review', mode: 'shadow', provider: 'p', outcome: 'failed', call_site: 'review', lane: 'review' });
      const insert = (rows: Array<Record<string, unknown>>) => step(f, 'decision_receipts',
        (e) => masterInsertRows(e, 'decision_receipts', MASTER_RECEIPT_COLUMNS, rows),
        (e) => e.insertDecideReceipts(rows as never));
      expect((await insert([])).changed).toBe(0);
      expect((await insert([full(1), minimal(1), full(2)])).changed).toBe(3);
      // The same decision id again is a second row (no conflict rule), in order after the first batch.
      expect((await insert([minimal(1), { ...full(3), answer_value: null, confidence: null, threshold: null, latency_ms: null, protected: false, remote: false }])).changed).toBe(2);
      const rows = await normalized(f.after, 'decision_receipts');
      expect(rows.map((r) => r.decision_id)).toEqual(['d1', 'm1', 'd2', 'm1', 'd3']);
      expect(rows.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
      expect(rows[0]).toMatchObject({ answer_value: '0.11', confidence: '0.87554324', threshold: '0.75', latency_ms: '151', protected: 'true', remote: 'true', min_keep: '3', rank: '1', run_meta: '{"a":1,"b":[2,3]}' });
      expect(rows[1]).toMatchObject({ protected: 'false', remote: 'false', answer_value: null, min_keep: null, source_id: null });
      // A row missing a NOT NULL column (slot) refuses the whole batch on both sides.
      const { slot: _slot, ...noSlot } = minimal(9);
      await refusedStep(f, 'decision_receipts',
        (e) => masterInsertRows(e, 'decision_receipts', MASTER_RECEIPT_COLUMNS, [full(8), noSlot]),
        (e) => e.insertDecideReceipts([full(8), noSlot] as never));
    });
  });
}
