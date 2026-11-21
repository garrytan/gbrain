/**
 * Before/after parity for the SELECTs that moved behind BrainEngine members in N5 (the minion job counts and last-run
 * reads of the status surfaces; the vector-column catalog reads of the embedding commands; the held fence results
 * read; and the config reads that switched to the typed keyed read): the callers' `executeRaw` statements at the N5
 * base (7969eaabc5, test/helpers/n5-master-sql.ts) against the members in
 * src/core/engine-sql/{jobs-status,embedding-catalog,fence-holds}.ts and `readConfigValue` / `readConfigMap`
 * (src/core/config-values.ts).
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with the run-time text building and row mapping
 * its call site had) on the first and the member on the second, and requires the same rows in every column. Every site
 * the move check lists as a removed caller statement is named once in ALL_SITES by its master path:line; the last case
 * fails when a site has no case.
 *
 * 1. Protects: the 28 moved read sites answer the same rows on the same data: which statuses and names a count
 *    includes, which jobs a time window keeps, the `_` of a LIKE pattern, how a job's scope falls back from `sourceId`
 *    to `source_id`, which pages a drain estimate averages (a private page and a soft-deleted page included, as before),
 *    the NULL and empty answers, the catalog widths, and which held rows of which fence kinds a fence read lists.
 * 2. Fails when: a member's text or mapping changes a predicate, a join, a cast, a window, a LIMIT or an ORDER BY the
 *    caller read in. Each member has a mutation that this file kills (n5-logs/mut/results.tsv in the report).
 * 3. Existing coverage: test/engine-parity/jobs-status.test.ts and embedding-catalog.test.ts compare the engines with
 *    each other; no test compared any member with the statement master ran, and the Rust engine has no raw SQL to run
 *    master's text.
 * 4. Seam: none. Real engines; rows go in through typed members where one exists and by plain INSERT for the tables no
 *    member writes (jobs, held fence rows). Every time is an absolute instant from one reference both brains share, so
 *    a window or an age reads the same on both. A tie master left open (no ORDER BY, or a tie in it) is not compared with
 *    master: it is asserted on the member alone, in the order the member now fixes.
 *
 * Privacy and visibility: no moved statement carries a visibility filter (the job, config, catalog and fence-hold reads
 * join no page; the drain estimate and the coverage ratio join `pages` and count every row, as before). The seed holds a
 * `visibility: private` page and a soft-deleted page that both sides must count identically; the engine members take no
 * caller identity, so there is no world-only caller case at this layer.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply to master's text (SQL); the Rust-served members are compared on the Rust arm by
 * test/engine-parity/jobs-status.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { TTL_REASON_PREFIX } from '../src/core/minions/admission.ts';
import { readConfigMap, readConfigValue } from '../src/core/config-values.ts';
import { PRIMARY_EMBEDDING_TABLES } from '../src/core/engine-sql/embedding-catalog.ts';
import { FACTS_DRAIN_JOB, FACTS_DRAIN_QUEUE } from '../src/core/facts/drain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { basisEmbedding, createSource } from './engine-parity/harness.ts';
import { makePair } from './helpers/n4-seed.ts';
import * as M from './helpers/n5-master-sql.ts';

/** Every removed caller statement the move check lists for N5, by master path:line (7969eaabc5). */
const ALL_SITES = [
  'src/commands/status.ts:254', 'src/commands/status.ts:266', 'src/commands/status.ts:320', 'src/commands/status.ts:348', 'src/commands/status.ts:397',
  'src/commands/jobs/stats.ts:36', 'src/commands/jobs/stats.ts:212', 'src/commands/jobs/stats.ts:254', 'src/commands/jobs/stats.ts:279',
  'src/core/facts/drain.ts:125', 'src/core/facts/drain.ts:191', 'src/core/source-health.ts:423', 'src/core/sync-status-report.ts:188',
  'src/core/embedding-dim-check.ts:141', 'src/core/embedding-dim-check.ts:155',
  'src/core/stored-embedding-identity.ts:8', 'src/core/stored-embedding-identity.ts:19', 'src/core/stored-embedding-identity.ts:28',
  'src/commands/embeddings.ts:96', 'src/commands/init.ts:1072', 'src/commands/doctor/checks/embedding-plane.ts:25', 'src/commands/init-embedding-plane.ts:24',
  'src/commands/doctor/checks/data-integrity.ts:245', 'src/core/generations/fence.ts:181',
  'src/commands/doctor/checks/embedding-identity.ts:39', 'src/core/eligibility/scan.ts:78', 'src/core/trust/claim-state.ts:69', 'src/core/search/embedding-column.ts:702',
] as const;

// ---------------------------------------------------------------- comparison

interface Fixture { before: BrainEngine; after: BrainEngine; backend: 'pglite' | 'postgres' }
interface Opts { ordered?: boolean; nonEmpty?: boolean }

/** One canonical form for both sides: bigint and digit text to number, dates to ISO, JSON text parsed, keys sorted. */
function canon(v: unknown, ordered: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    if (/^-?\d{1,15}$/.test(v)) return Number(v);
    if (/^[[{]/.test(v)) { try { return canon(JSON.parse(v), ordered); } catch { return v; } }
    return v;
  }
  if (Array.isArray(v)) {
    const items = v.map(x => canon(x, ordered));
    return ordered ? items : items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x, ordered)]));
  return v;
}

/** Does the answer carry data: a non-empty list, a non-zero count, a true flag, or any such field. */
function hasData(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return true;
  if (v instanceof Date) return true;
  if (typeof v === 'object') return Object.values(v as object).some(hasData);
  return true;
}

/** The sites each case has proved; the last case compares it with ALL_SITES. */
let covered: Set<string>;

/** Run master's text on the before brain and the member on the after brain; require the same rows. */
async function site(f: Fixture, keys: string | string[], before: (e: BrainEngine) => Promise<unknown>, after: (e: BrainEngine) => Promise<unknown>, o: Opts = {}): Promise<unknown> {
  const b = await before(f.before);
  const a = await after(f.after);
  expect(canon(a, o.ordered ?? false)).toEqual(canon(b, o.ordered ?? false));
  if (o.nonEmpty !== false) expect(hasData(b)).toBe(true);
  for (const k of Array.isArray(keys) ? keys : [keys]) covered.add(k);
  return b;
}

const rowsOf = (v: unknown) => v as Array<Record<string, unknown>>;
const raw = (e: BrainEngine, sql: string, params?: unknown[]) => e.executeRaw<Record<string, unknown>>(sql, params);
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- seeds (identical on both brains, in the same order)

interface Job {
  name: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'dead' | 'cancelled' | 'waiting-children';
  queue?: string;
  /** Minutes from the shared reference instant (negative = before it). */
  created?: number;
  started?: number;
  finished?: number;
  updated?: number;
  lockUntil?: number;
  data?: Record<string, unknown>;
  error?: string | null;
  result?: Record<string, unknown>;
}

/** Insert one job row; every time is `ref` plus minutes, so both brains hold the same instants. */
async function job(e: BrainEngine, ref: number, j: Job): Promise<number> {
  const at = (min: number | undefined) => (min === undefined ? null : new Date(ref + min * 60_000).toISOString());
  const created = j.created ?? -1000;
  const [row] = await raw(e,
    `INSERT INTO minion_jobs (name, queue, status, data, error_text, result, created_at, started_at, finished_at, updated_at, lock_until, lock_token, submission_authority)
     VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12, '{"kind":"application"}'::jsonb)
     RETURNING id`,
    [j.name, j.queue ?? 'default', j.status, JSON.stringify(j.data ?? {}), j.error ?? null, j.result ? JSON.stringify(j.result) : null,
      at(created), at(j.started), at(j.finished), at(j.updated ?? j.finished ?? created), at(j.lockUntil),
      j.status === 'active' ? `tok-${j.name}-${created}-${j.started ?? 0}` : null]);
  return Number(row!.id);
}

interface Ids { liveScope: number; lapsedScope: number; unscopedScope: number }

const chunk = (index: number, text: string, extra: Partial<ChunkInput> = {}): ChunkInput => ({ chunk_index: index, chunk_text: text, chunk_source: 'compiled_truth', ...extra });

const UNIT_1024 = `[${['1', ...new Array(1023).fill('0')].join(',')}]`;

async function seedWorld(e: BrainEngine, backend: 'pglite' | 'postgres', ref: number): Promise<Ids> {
  await createSource(e, backend, 'other');
  await createSource(e, backend, 'third');
  await e.setConfig('embedding_dimensions', '1536');
  await e.setConfig('embedding_model', ' model-a ');
  await e.setConfig('search_embedding_column', 'embedding_image');
  await e.setConfig('embedding_columns', '{"embedding_image":{"dims":1024}}');
  await e.setConfig('eligibility.scan_baseline', '2026-01-02T03:04:05.000Z');
  await e.setConfig('empty_value_key', '');

  // Pages the drain estimate points at: a short one, a long one in another source (capped), a private one, a soft-deleted one.
  await e.putPage('notes/p1', { type: 'note', title: 'P1', compiled_truth: 'a'.repeat(50) });
  await e.putPage('notes/p2', { type: 'note', title: 'P2', compiled_truth: 'b'.repeat(300) }, { sourceId: 'other' });
  await e.putPage('notes/p3', { type: 'note', title: 'P3 private', compiled_truth: 'c'.repeat(70), frontmatter: { visibility: 'private' } });
  await e.putPage('notes/p4', { type: 'note', title: 'P4 gone', compiled_truth: 'd'.repeat(90) });

  // Chunks: vectors in the primary column of one page, a multimodal vector in two sources, a chunk of the deleted page.
  await e.upsertChunks('notes/p1', [chunk(0, 'p1 zero', { embedding: basisEmbedding(1), model: 'model-a' }), chunk(1, 'p1 one')]);
  await e.upsertChunks('notes/p2', [chunk(0, 'p2 zero'), chunk(1, 'p2 one'), chunk(2, 'p2 two')], { sourceId: 'other' });
  await e.upsertChunks('notes/p3', [chunk(0, 'p3 zero')]);
  await e.upsertChunks('notes/p4', [chunk(0, 'p4 zero')]);
  await e.softDeletePage('notes/p4');
  await raw(e, `UPDATE content_chunks SET embedding_multimodal = $1::vector WHERE chunk_text IN ('p1 zero', 'p2 one', 'p4 zero')`, [UNIT_1024]);

  // Jobs. Autopilot runs: two full cycles (the newer wins), a failed and an unfinished one, a targeted run newer than both.
  await job(e, ref, { name: 'autopilot-cycle', status: 'completed', finished: -300, result: { report: { totals: { n: 1 } } } });
  await job(e, ref, { name: 'autopilot-cycle', status: 'completed', started: -125, finished: -120, result: { report: { totals: { n: 2 } } } });
  await job(e, ref, { name: 'autopilot-cycle', status: 'failed', finished: -10, error: 'cycle failed' });
  await job(e, ref, { name: 'autopilot-cycle', status: 'completed', created: -400, started: -399, result: { report: { totals: { n: 9 } } } });
  await job(e, ref, { name: 'autopilot-sync', status: 'completed', started: -61, finished: -60, result: { report: { totals: { n: 3 } } } });
  await job(e, ref, { name: 'autopilot-extract', status: 'dead', finished: -5, error: 'dead run' });
  await job(e, ref, { name: 'my-autopilot-cycle', status: 'completed', finished: -2 });
  // Waiting depth: default 3, q3 2, q2 1, q4 1 (a tie with q2).
  for (const created of [-180, -120, -60]) await job(e, ref, { name: 'work', status: 'waiting', created });
  await job(e, ref, { name: 'work', status: 'waiting', queue: 'q2', created: -30 });
  for (const created of [-90, -45]) await job(e, ref, { name: 'work', status: 'waiting', queue: 'q3', created });
  await job(e, ref, { name: 'work', status: 'waiting', queue: 'q4', created: -20 });
  // The embed-backfill scope of a live job: two waiting in 'src-a', one under the `source_id` key, one elsewhere, one without a scope.
  const liveScope = await job(e, ref, { name: 'embed-backfill', status: 'active', created: -100, started: -90.5, lockUntil: 10, data: { sourceId: 'src-a' } });
  const lapsedScope = await job(e, ref, { name: 'embed-backfill', status: 'active', created: -100, started: -80, lockUntil: -10, data: { sourceId: 'other' } });
  const unscopedScope = await job(e, ref, { name: 'embed-backfill', status: 'active', created: -100, started: -10, lockUntil: 10 });
  for (const created of [-70, -69]) await job(e, ref, { name: 'embed-backfill', status: 'waiting', created, data: { sourceId: 'src-a' } });
  await job(e, ref, { name: 'embed-backfill', status: 'waiting', created: -68, data: { source_id: 'src-a' } });
  await job(e, ref, { name: 'embed-backfill', status: 'waiting', created: -67, data: { sourceId: 'src-b' } });
  await job(e, ref, { name: 'embed-backfill', status: 'waiting', created: -66 });
  await job(e, ref, { name: 'embed-backfill', status: 'waiting-children', created: -65, data: { sourceId: 'default' } });
  await job(e, ref, { name: 'embed-backfill', status: 'completed', created: -300, finished: -200, data: { sourceId: 'other' } });
  await job(e, ref, { name: 'embed-backfill', status: 'completed', created: -300, finished: -100, data: { sourceId: 'other' } });
  await job(e, ref, { name: 'embed-backfill', status: 'failed', created: -60, finished: -50, data: { sourceId: 'other' }, error: 'backfill failed' });
  // Source jobs: a failure inside and one outside the 24 hours, a queued sync, a sync without a source.
  await job(e, ref, { name: 'sync', status: 'failed', created: -120, finished: -110, data: { sourceId: 'default' }, error: 'sync failed' });
  await job(e, ref, { name: 'sync', status: 'dead', created: -1800, finished: -1790, data: { sourceId: 'default' }, error: 'old' });
  await job(e, ref, { name: 'sync', status: 'waiting', created: -30, data: { sourceId: 'default' } });
  await job(e, ref, { name: 'sync', status: 'delayed', created: -29, data: { sourceId: 'third' } });
  await job(e, ref, { name: 'sync', status: 'waiting', created: -28 });
  // Recent completions of 'subagent' (two inside the hour, one outside) and of another name.
  for (const finished of [-30, -20, -90]) await job(e, ref, { name: 'subagent', status: 'completed', created: -200, finished });
  await job(e, ref, { name: 'other-name', status: 'completed', created: -200, finished: -30 });
  // Failures: a failed and a null-text failed job inside the 24 hours, a dead one at 23 hours, a failed one at 26 hours.
  await job(e, ref, { name: 'x', status: 'failed', created: -1700, finished: -30, updated: -30, error: 'boom' });
  await job(e, ref, { name: 'x', status: 'failed', created: -1700, finished: -10, updated: -10 });
  await job(e, ref, { name: 'x', status: 'dead', created: -1700, finished: -1380, updated: -1380, error: 'dead1' });
  await job(e, ref, { name: 'x', status: 'failed', created: -1700, finished: -1560, updated: -1560, error: 'stale' });
  // Waiting-TTL cancellations: three 'subagent', one 'embed-backfill', one 'x' (a tie), the pattern's `_` matching any one character,
  // one outside the window, one with another reason.
  for (let i = 0; i < 2; i++) await job(e, ref, { name: 'subagent', status: 'cancelled', created: -300, finished: -60, error: `${TTL_REASON_PREFIX}: waited 3h` });
  await job(e, ref, { name: 'subagent', status: 'cancelled', created: -300, finished: -61, error: 'waitingXttlYexpired' });
  await job(e, ref, { name: 'embed-backfill', status: 'cancelled', created: -300, finished: -62, error: `${TTL_REASON_PREFIX}: waited 5h` });
  await job(e, ref, { name: 'x', status: 'cancelled', created: -300, finished: -63, error: `${TTL_REASON_PREFIX}: waited 1h` });
  await job(e, ref, { name: 'subagent', status: 'cancelled', created: -3000, finished: -1560, error: `${TTL_REASON_PREFIX}: old` });
  await job(e, ref, { name: 'subagent', status: 'cancelled', created: -300, finished: -64, error: 'cancelled by an operator' });
  // The facts drain: waiting jobs for a short page, a long page of another source, a private page, a deleted page, a missing page, none;
  // a delayed and an active one; and a waiting one on another queue.
  const drain = { name: FACTS_DRAIN_JOB, queue: FACTS_DRAIN_QUEUE };
  await job(e, ref, { ...drain, status: 'waiting', created: -50, data: { slug: 'notes/p1' } });
  await job(e, ref, { ...drain, status: 'delayed', created: -49, data: { slug: 'notes/p1' } });
  await job(e, ref, { ...drain, status: 'waiting', created: -48, data: { slug: 'notes/p2', sourceId: 'other' } });
  await job(e, ref, { ...drain, status: 'waiting', created: -47, data: { slug: 'notes/p3' } });
  await job(e, ref, { ...drain, status: 'waiting', created: -46, data: { slug: 'notes/p4' } });
  await job(e, ref, { ...drain, status: 'waiting', created: -45, data: { slug: 'notes/missing' } });
  await job(e, ref, { ...drain, status: 'waiting', created: -44 });
  await job(e, ref, { ...drain, status: 'active', created: -43, started: -42, lockUntil: 10, data: { slug: 'notes/p1' } });
  await job(e, ref, { ...drain, status: 'waiting', queue: 'other-queue', created: -41, data: { slug: 'notes/p1' } });

  // Held fence rows: oldest first, two sources, both kinds; a live, a superseded and an unrelated kind are left out; another source is not asked for.
  const gen = (source: string, kind: string, owner: string, state: string, reason: string | null, ctx: Record<string, unknown> | null, createdMin: number) => raw(e,
    `INSERT INTO derived_generations (source_id, kind, owner_key, state, operation_id, item_set_hash, held_reason, held_context, created_at)
     VALUES ($1, $2, $3, $4, 'op-' || $3 || $2 || $4, 'hash', $5, $6::text::jsonb, $7::timestamptz)`,
    [source, kind, owner, state, reason, ctx === null ? null : JSON.stringify(ctx), new Date(ref + createdMin * 60_000).toISOString()]);
  await gen('default', 'fact_fence', 'page:notes/a', 'held', 'fence_absent', { read: 'absent', rows: 3 }, -50);
  await gen('default', 'take_fence', 'page:notes/a', 'held', 'no_proof', { read: 'unreadable', rows: 1, writer: 'sync' }, -40);
  await gen('other', 'fact_fence', 'page:notes/b', 'held', 'shrunk', null, -60);
  await gen('default', 'fact_fence', 'page:notes/p3', 'held', 'fence_absent', { read: 'absent', rows: 2 }, -50); // a private page: listed like any other
  await gen('third', 'fact_fence', 'page:notes/a', 'held', 'fence_absent', { read: 'absent', rows: 4 }, -70);
  await gen('default', 'fact_fence', 'page:notes/live', 'live', null, null, -80);
  await gen('default', 'fact_fence', 'page:notes/old', 'superseded', null, null, -90);
  await gen('default', 'other_kind', 'page:notes/a', 'held', 'shrunk', { read: 'x', rows: 1 }, -100);
  return { liveScope, lapsedScope, unscopedScope };
}

/** A tolerance-free age: whole minutes, so two reads a few milliseconds apart agree. */
const minutes = (seconds: unknown) => (seconds === null || seconds === undefined ? null : Math.round(Number(seconds) / 60));

for (const kind of testBackends()) {
  describe(`N5 read statements before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    let ids: Ids;
    beforeAll(async () => {
      covered = new Set();
      const ref = Date.now();
      const engines = await makePair(kind, closers);
      const seeded: Ids[] = [];
      for (const e of engines) seeded.push(await seedWorld(e, kind, ref));
      expect(seeded[1]).toEqual(seeded[0]!);
      ids = seeded[0]!;
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- status.ts:254 and :266
    test('last autopilot runs: the newest completed autopilot-cycle, and the newest completed autopilot-* job', async () => {
      const full = await site(f, 'src/commands/status.ts:254', async e => (await raw(e, M.CYCLE_FULL))[0] ?? null, async e => (await e.readLastAutopilotCycles()).full);
      const targeted = await site(f, 'src/commands/status.ts:266', async e => (await raw(e, M.CYCLE_TARGETED))[0] ?? null, async e => (await e.readLastAutopilotCycles()).targeted);
      // The newer full cycle wins; one that never finished sorts last; a failed one and a name that only ends like it are no cycle.
      expect((rowsOf([full])[0]!.result as { report: { totals: { n: number } } }).report.totals.n).toBe(2);
      expect(rowsOf([targeted])[0]!.name).toBe('autopilot-sync'); // newer than the full cycle; 'my-autopilot-cycle' only ends like one
      expect((await f.after.readLastAutopilotCycles()).full!.finished_at).toBeInstanceOf(Date);
    });

    // -------- status.ts:320 and drain.ts:125
    test('job counts by status over every job, and over one name and queue within three statuses', async () => {
      const all = await site(f, 'src/commands/status.ts:320', async e => rowsOf(await raw(e, M.QUEUE_COUNTS)), async e => await e.countJobsByStatus());
      expect(rowsOf(all).map(r => String(r.status)).sort(bytewise)).toContain('waiting-children');
      const drain = await site(f, 'src/core/facts/drain.ts:125',
        async e => rowsOf(await raw(e, M.DRAIN_COUNTS, [FACTS_DRAIN_JOB, FACTS_DRAIN_QUEUE])).map(r => ({ status: r.status, count: Number(r.n) })),
        async e => await e.countJobsByStatus({ name: FACTS_DRAIN_JOB, queue: FACTS_DRAIN_QUEUE, statuses: ['waiting', 'delayed', 'active'] }));
      expect(Object.fromEntries(rowsOf(drain).map(r => [r.status, r.count]))).toEqual({ waiting: 6, delayed: 1, active: 1 });
    });

    test('job counts: status order, and the filters master had no use for (member only)', async () => {
      const statuses = (await f.after.countJobsByStatus()).map(r => r.status);
      expect(statuses).toEqual([...statuses].sort(bytewise));
      expect(await f.after.countJobsByStatus({ name: FACTS_DRAIN_JOB, queue: 'nowhere' })).toEqual([]);
      expect(await f.after.countJobsByStatus({ statuses: [] })).toEqual([]); // an empty status list matches no status
      expect((await f.after.countJobsByStatus({ statuses: ['waiting'] })).map(r => r.status)).toEqual(['waiting']);
      expect((await f.after.countJobsByStatus({ queue: 'other-queue' })).map(r => r.count)).toEqual([1]);
    });

    // -------- status.ts:348
    test('waiting depth per queue with the age of the oldest, deepest first', async () => {
      const depths = await site(f, 'src/commands/status.ts:348',
        async e => rowsOf(await raw(e, M.QUEUE_DEPTHS)).map(r => ({ queue: r.queue, depth: Number(r.depth), age: minutes(r.oldest_waiting_age_seconds) })),
        async e => (await e.readWaitingQueueDepths()).map(r => ({ queue: r.queue, depth: r.depth, age: minutes(r.oldest_waiting_age_seconds) })));
      expect(rowsOf(depths).find(r => r.queue === 'default')!.depth).toBeGreaterThanOrEqual(3);
      // Member only: a tie in depth lists the queues by name (master left it open).
      const order = (await f.after.readWaitingQueueDepths()).map(r => `${r.depth}:${r.queue}`);
      expect(order).toEqual([...order].sort((a, b) => Number(b.split(':')[0]) - Number(a.split(':')[0]) || bytewise(a.split(':')[1]!, b.split(':')[1]!)));
    });

    // -------- status.ts:397
    test('the freshest update of a completed job', async () => {
      const at = await site(f, 'src/commands/status.ts:397', async e => (await raw(e, M.LAST_COMPLETED))[0]!.last_completed, async e => await e.readLastCompletedJobAt());
      expect(at).toBeInstanceOf(Date);
    });

    // -------- stats.ts:36
    test('waiting-TTL cancellations by name inside the window, `_` of the pattern matching any one character', async () => {
      const ttl = await site(f, 'src/commands/jobs/stats.ts:36',
        async e => rowsOf(await raw(e, M.TTL_CANCELLED, [`${TTL_REASON_PREFIX}%`])).map(r => ({ name: r.name, count: Number(r.count) })),
        async e => await e.countTtlCancelledByName(`${TTL_REASON_PREFIX}%`, 86_400));
      expect(Object.fromEntries(rowsOf(ttl).map(r => [r.name, r.count]))).toEqual({ subagent: 3, 'embed-backfill': 1, x: 1 });
      // Member only: most first, ties by name; and a window of an hour keeps only the jobs finished inside it.
      expect((await f.after.countTtlCancelledByName(`${TTL_REASON_PREFIX}%`, 86_400)).map(r => r.name)).toEqual(['subagent', 'embed-backfill', 'x']);
      expect(await f.after.countTtlCancelledByName(`${TTL_REASON_PREFIX}%`, 3_600)).toEqual([]); // every one finished more than an hour ago
      expect((await f.after.countTtlCancelledByName(`${TTL_REASON_PREFIX}%`, 100 * 60)).map(r => r.count)).toEqual([3, 1, 1]);
    });

    // -------- stats.ts:212
    test('the scope behind a returned job: waiting jobs of its source, and its id and age only while its lease is live', async () => {
      const spec = (jobId: number, name = 'embed-backfill', queue = 'default') => ({ name, queue, jobId });
      const master = (s: ReturnType<typeof spec>) => async (e: BrainEngine) => {
        const [r] = rowsOf(await raw(e, M.WAITING_SCOPE, [s.name, s.queue, s.jobId]));
        return { waiting: Number(r!.waiting), live_id: r!.live_id == null ? null : Number(r!.live_id), age_min: r!.age_min == null ? null : Number(r!.age_min) };
      };
      const live = await site(f, 'src/commands/jobs/stats.ts:212', master(spec(ids.liveScope)), async e => await e.readWaitingScopeState(spec(ids.liveScope)));
      expect(live).toMatchObject({ waiting: 3, live_id: ids.liveScope }); // two `sourceId` and one `source_id`
      expect(typeof (live as { age_min: unknown }).age_min).toBe('number');
      const lapsed = await site(f, 'src/commands/jobs/stats.ts:212', master(spec(ids.lapsedScope)), async e => await e.readWaitingScopeState(spec(ids.lapsedScope)), { nonEmpty: false });
      expect(lapsed).toEqual({ waiting: 0, live_id: null, age_min: null }); // a lapsed lease is no live job
      const unscoped = await site(f, 'src/commands/jobs/stats.ts:212', master(spec(ids.unscopedScope)), async e => await e.readWaitingScopeState(spec(ids.unscopedScope)));
      expect(unscoped).toMatchObject({ waiting: 1, live_id: ids.unscopedScope }); // no scope matches the waiting jobs without one
      for (const miss of [spec(999_999), spec(ids.liveScope, 'sync'), spec(ids.liveScope, 'embed-backfill', 'q2')]) {
        expect(await site(f, 'src/commands/jobs/stats.ts:212', master(miss), async e => await e.readWaitingScopeState(miss), { nonEmpty: false })).toEqual({ waiting: 0, live_id: null, age_min: null });
      }
    });

    // -------- stats.ts:254 and :279
    test('subagent jobs completed inside the hour, and dead or failed jobs updated inside 24 hours', async () => {
      const done = await site(f, 'src/commands/jobs/stats.ts:254', async e => Number((await raw(e, M.RECENT_COMPLETED))[0]!.count), async e => await e.countRecentCompletedJobs('subagent', 3_600));
      expect(done).toBe(2);
      const failed = await site(f, 'src/commands/jobs/stats.ts:279',
        async e => rowsOf(await raw(e, M.RECENT_FAILED)).map(r => ({ id: Number(r.id), last_error: r.last_error })),
        async e => await e.listRecentFailedJobErrors(86_400));
      expect(rowsOf(failed).map(r => String(r.last_error)).sort()).toEqual(['backfill failed', 'boom', 'cycle failed', 'dead run', 'dead1', 'null', 'sync failed']); // every failed or dead job updated inside 24 hours
      const ids2 = (await f.after.listRecentFailedJobErrors(86_400)).map(r => r.id);
      expect(ids2).toEqual([...ids2].sort((a, b) => a - b)); // member only: by id
    });

    // -------- drain.ts:191
    test('the average text length of the pages queued drain jobs name, capped; a private and a deleted page count', async () => {
      for (const cap of [100, 1000]) {
        const chars = await site(f, 'src/core/facts/drain.ts:191',
          async e => Number((await raw(e, M.DRAIN_CHARS, [FACTS_DRAIN_JOB, FACTS_DRAIN_QUEUE, cap]))[0]!.chars),
          async e => await e.readQueuedPageChars({ name: FACTS_DRAIN_JOB, queue: FACTS_DRAIN_QUEUE, maxChars: cap }));
        // Waiting and delayed jobs of a 50-char page (twice), a long page (capped), a 70-char private page, a 90-char deleted page.
        expect(chars).toBe(cap === 100 ? (50 + 50 + 100 + 70 + 90) / 5 : (50 + 50 + 300 + 70 + 90) / 5);
      }
      const none = await site(f, 'src/core/facts/drain.ts:191',
        async e => ((await raw(e, M.DRAIN_CHARS, ['no-such-job', FACTS_DRAIN_QUEUE, 100]))[0]!.chars ?? null),
        async e => await e.readQueuedPageChars({ name: 'no-such-job', queue: FACTS_DRAIN_QUEUE, maxChars: 100 }), { nonEmpty: false });
      expect(none).toBeNull();
    });

    // -------- source-health.ts:423 and sync-status-report.ts:188
    test('per-source job counts of sync and embed-backfill jobs, and the embed-backfill state of named sources', async () => {
      const counts = await site(f, 'src/core/source-health.ts:423',
        async e => rowsOf(await raw(e, M.SOURCE_JOBS)).map(r => ({ source_id: r.source_id, failed_24h: Number(r.failed_24h), queue_depth: Number(r.queue_depth), backfill_active: Number(r.backfill_active), backfill_queued: Number(r.backfill_queued) })),
        async e => await e.readSourceJobCounts(86_400));
      expect(rowsOf(counts).find(r => r.source_id === 'default')).toMatchObject({ failed_24h: 1, queue_depth: 1, backfill_queued: 1 });
      expect((await f.after.readSourceJobCounts(86_400)).map(r => r.source_id)).toEqual(['default', 'other', 'src-a', 'src-b', 'third']); // member only: by source id
      const named = ['default', 'other', 'src-a', 'nobody'];
      const backfill = await site(f, 'src/core/sync-status-report.ts:188',
        async e => rowsOf(await raw(e, M.EMBED_BACKFILL, [named])).map(r => ({ source_id: r.source_id, queued: Number(r.queued), active: Number(r.active), last_completed_at: r.last_completed_at ?? null })),
        async e => await e.readEmbedBackfillBySource(named));
      expect(rowsOf(backfill).find(r => r.source_id === 'other')!.last_completed_at).toBeInstanceOf(Date);
      expect((await f.after.readEmbedBackfillBySource(named)).map(r => r.source_id)).toEqual(['default', 'other', 'src-a']);
      expect(await f.after.readEmbedBackfillBySource([])).toEqual([]);
    });

    // -------- embedding-dim-check.ts:141 and :155
    test('the declared width of a content_chunks vector column, and no column it lacks', async () => {
      // Master's caller: probe the column, read its formatted type, take the width out of `vector(N)` / `halfvec(N)`.
      const master = (column: string) => async (e: BrainEngine) => {
        const exists = await raw(e, M.DIM_EXISTS, [column]);
        if (!exists?.[0]?.exists) return { exists: false, dims: null };
        const formatted = (await raw(e, M.DIM_FORMAT, [column]))?.[0]?.formatted as string | null ?? null;
        if (!formatted) return { exists: true, dims: null };
        const m = formatted.match(/(?:vector|halfvec)\((\d+)\)/i);
        return { exists: true, dims: m ? parseInt(m[1]!, 10) : null };
      };
      for (const [column, expected] of [['embedding', { exists: true, dims: 1536 }], ['embedding_image', { exists: true, dims: 1024 }], ['embedding_multimodal', { exists: true, dims: 1024 }],
        ['chunk_text', { exists: true, dims: null }]] as const) {
        expect(await site(f, ['src/core/embedding-dim-check.ts:141', 'src/core/embedding-dim-check.ts:155'], master(column), async e => await e.readChunkVectorColumn(column))).toEqual(expected);
      }
      expect(await site(f, ['src/core/embedding-dim-check.ts:141'], master('no_such_column'), async e => await e.readChunkVectorColumn('no_such_column'), { nonEmpty: false })).toEqual({ exists: false, dims: null });
    });

    // -------- stored-embedding-identity.ts:8, :19, :28
    test('the stored embedding identity (trimmed model, width) and the tables that carry an embedding column', async () => {
      const identity = await site(f, ['src/core/stored-embedding-identity.ts:19', 'src/core/stored-embedding-identity.ts:28'],
        async e => {
          const rows = await raw(e, M.IDENTITY_FORMAT) as Array<{ formatted: string | null }>;
          if (rows.length === 0) throw new Error('identity unavailable');
          const dimensions = Number(rows[0]!.formatted?.match(/^(?:halfvec|vector)\((\d+)\)$/)?.[1]);
          const model = await e.getConfig('embedding_model').catch(() => null);
          return { model: model?.trim() || null, dimensions };
        },
        async e => await e.readEmbeddingIdentity());
      expect(identity).toEqual({ model: 'model-a', dimensions: 1536 });
      // The table probe, answered on a brain whose content_chunks table is gone: no table is no identity; a table without the column throws.
      const pair = await makePair(kind, closers);
      for (const e of pair) await raw(e, 'DROP TABLE content_chunks CASCADE');
      const gone: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      expect(await site(gone, 'src/core/stored-embedding-identity.ts:28',
        async e => (await raw(e, M.IDENTITY_FORMAT)).length === 0 && (await raw(e, M.IDENTITY_TABLES))[0]!.present === false ? null : 'not-null',
        async e => await e.readEmbeddingIdentity(), { nonEmpty: false })).toBeNull();
      for (const e of pair) await raw(e, 'CREATE TABLE content_chunks (id SERIAL PRIMARY KEY, chunk_text TEXT)');
      for (const e of pair) await expect(e.readEmbeddingIdentity()).rejects.toThrow('Stored embedding column identity is unavailable');
      covered.add('src/core/stored-embedding-identity.ts:28');
      const stores = await site(f, 'src/core/stored-embedding-identity.ts:8',
        async e => { const rows = await raw(e, M.IDENTITY_STORES, [[...PRIMARY_EMBEDDING_TABLES]]); return PRIMARY_EMBEDDING_TABLES.filter(t => rows.some(r => r.table_name === t)); },
        async e => await e.listEmbeddingStores(), { ordered: true });
      expect(stores).toEqual(['content_chunks', 'facts', 'query_cache', 'takes']);
    }, 120_000);

    // -------- embeddings.ts:96, init.ts:1072, embedding-plane.ts:25, init-embedding-plane.ts:24
    test('whether any row of a store holds a vector, for each of the four stores', async () => {
      const state = await site(f, ['src/commands/embeddings.ts:96', 'src/commands/init.ts:1072', 'src/commands/doctor/checks/embedding-plane.ts:25', 'src/commands/init-embedding-plane.ts:24'],
        async e => { const out: Record<string, boolean> = {}; for (const t of PRIMARY_EMBEDDING_TABLES) out[t] = !!(await raw(e, M.storedVectorsSql(t)))[0]?.present; return out; },
        async e => { const out: Record<string, boolean> = {}; for (const t of PRIMARY_EMBEDDING_TABLES) out[t] = await e.hasStoredVectors(t); return out; });
      expect(state).toEqual({ content_chunks: true, facts: false, query_cache: false, takes: false });
      await expect(f.after.hasStoredVectors('pages' as never)).rejects.toThrow('is not an embedding store');
    });

    // -------- data-integrity.ts:245
    test('chunks and multimodal vectors per source, every generation and every page counted', async () => {
      const coverage = await site(f, 'src/commands/doctor/checks/data-integrity.ts:245',
        async e => rowsOf(await raw(e, M.COVERAGE_MULTIMODAL)).map(r => ({ source_id: r.source_id || 'default', total: parseInt(String(r.total), 10), covered: parseInt(String(r.covered), 10) })),
        async e => await e.countChunkVectorCoverage('embedding_multimodal'));
      // default: p1 (2 chunks, 1 covered), the private p3 (1), the deleted p4 (1, covered); other: p2 (3, 1 covered).
      expect([...(coverage as Array<{ source_id: string; total: number; covered: number }>)].sort((a, b) => a.source_id.localeCompare(b.source_id))).toEqual([{ source_id: 'default', total: 4, covered: 2 }, { source_id: 'other', total: 3, covered: 1 }]); // master has no ORDER BY
      expect((await f.after.countChunkVectorCoverage('embedding_multimodal')).map(r => r.source_id)).toEqual(['default', 'other']); // member only: sorted in JS
      await expect(f.after.countChunkVectorCoverage('embedding_image' as never)).rejects.toThrow('is not a fixed vector column');
    });

    // -------- fence.ts:181
    test('held fence results of the asked sources and kinds, oldest first, for every owner or one', async () => {
      const kinds = ['fact_fence', 'take_fence'];
      const master = (slug: string | undefined, sources: string[]) => async (e: BrainEngine) =>
        rowsOf(await raw(e, M.fenceHoldsSql(slug), slug === undefined ? [sources, kinds] : [sources, kinds, `page:${slug}`]));
      const every = await site(f, 'src/core/generations/fence.ts:181', master(undefined, ['default', 'other']), async e => await e.listFenceHoldRows(['default', 'other'], kinds), { ordered: true });
      // Oldest first; the live, the superseded, the other kind and the source nobody asked for are left out; the private page's hold is listed like any other.
      expect(rowsOf(every).map(r => `${r.source_id}:${r.owner_key}`)).toEqual(['other:page:notes/b', 'default:page:notes/a', 'default:page:notes/p3', 'default:page:notes/a']);
      expect(rowsOf(every).map(r => r.kind)).toEqual(['fact_fence', 'fact_fence', 'fact_fence', 'take_fence']);
      expect(typeof rowsOf(every)[0]!.created_at).toBe('string');
      const one = await site(f, 'src/core/generations/fence.ts:181', master('notes/a', ['default', 'other', 'third']), async e => await e.listFenceHoldRows(['default', 'other', 'third'], kinds, 'page:notes/a'), { ordered: true });
      expect(rowsOf(one).map(r => `${r.source_id}:${r.kind}`)).toEqual(['third:fact_fence', 'default:fact_fence', 'default:take_fence']);
      await site(f, 'src/core/generations/fence.ts:181', master(undefined, ['nobody']), async e => await e.listFenceHoldRows(['nobody'], kinds), { ordered: true, nonEmpty: false });
      expect(await f.after.listFenceHoldRows([], kinds)).toEqual([]);
      expect(await f.after.listFenceHoldRows(['default'], [])).toEqual([]);
    });

    // -------- the config reads (embedding-identity.ts:39, scan.ts:78, claim-state.ts:69, embedding-column.ts:702)
    test('config reads through the typed keyed read: one key, a missing key, an empty value, two keys', async () => {
      const value = (key: string, sql: string) => [async (e: BrainEngine) => (await raw(e, sql, key === 'embedding_model' && sql === M.CONFIG_EMBEDDING_MODEL ? undefined : [key]))[0]?.value as string | undefined ?? null,
        async (e: BrainEngine) => (await readConfigValue(e, key)) ?? null] as const;
      const [mBefore, mAfter] = value('embedding_model', M.CONFIG_EMBEDDING_MODEL);
      expect(await site(f, 'src/commands/doctor/checks/embedding-identity.ts:39', mBefore, mAfter)).toBe(' model-a '); // not trimmed
      const [sBefore, sAfter] = value('eligibility.scan_baseline', M.CONFIG_SCAN_BASELINE);
      expect(await site(f, 'src/core/eligibility/scan.ts:78', sBefore, sAfter)).toBe('2026-01-02T03:04:05.000Z');
      const [cBefore, cAfter] = value('eligibility.scan_baseline', M.CONFIG_CLAIM_BASELINE);
      await site(f, 'src/core/trust/claim-state.ts:69', cBefore, cAfter);
      const [missB, missA] = value('no.such.key', M.CONFIG_CLAIM_BASELINE);
      expect(await site(f, 'src/core/trust/claim-state.ts:69', missB, missA, { nonEmpty: false })).toBeNull();
      const [emptyB, emptyA] = value('empty_value_key', M.CONFIG_SCAN_BASELINE);
      expect(await site(f, 'src/core/eligibility/scan.ts:78', emptyB, emptyA, { nonEmpty: false })).toBe('');
      const columns = await site(f, 'src/core/search/embedding-column.ts:702',
        async e => Object.fromEntries(rowsOf(await raw(e, M.CONFIG_EMBEDDING_COLUMNS)).map(r => [r.key, r.value])),
        async e => Object.fromEntries(await readConfigMap(e, ['search_embedding_column', 'embedding_columns'])));
      expect(columns).toEqual({ search_embedding_column: 'embedding_image', embedding_columns: '{"embedding_image":{"dims":1024}}' });
    });

    test('a finished-at tie between two autopilot runs goes to the newer job (member only: master left the tie open)', async () => {
      const pair = await makePair(kind, closers);
      const e = pair[0]!;
      const ref = Date.now();
      const first = await job(e, ref, { name: 'autopilot-cycle', status: 'completed', finished: -10, result: { which: 'first' } });
      const second = await job(e, ref, { name: 'autopilot-cycle', status: 'completed', finished: -10, result: { which: 'second' } });
      expect(second).toBeGreaterThan(first);
      const { full, targeted } = await e.readLastAutopilotCycles();
      expect(full!.result).toEqual({ which: 'second' });
      expect(targeted!.result).toEqual({ which: 'second' });
    }, 120_000);

    test('every moved read site has a case', () => {
      expect([...covered].sort()).toEqual([...ALL_SITES].sort());
    });
  });
}
