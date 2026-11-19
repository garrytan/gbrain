/**
 * BrainEngine parity: the terminal write failure reads of engine-sql/doctor-terminal.ts, which `gbrain doctor`'s
 * persistence_terminal_failures check and `gbrain sources writer failures` ran through `engine.executeRaw`, and which a
 * Rust brain refused ("does not support executeRaw yet").
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: over the same failed, conflicted and cancelled receipts, the grouped aggregate and the drill-down batch
 *    answer the same rows on every engine arm: the classification columns (knock-on, routed message, build, schema-aware
 *    reason), the resolved flag, the counts and the per-source totals row, and for each receipt the later request that made
 *    it moot. The open-pass blocker reads answer empty on a brain no pass has written to.
 *  - Regression: a Rust brain that refuses (or answers `[]`) leaves doctor's terminal check at "Could not read terminal write
 *    failures" while PGLite counts the unresolved receipts and names their categories.
 *  - Why existing coverage misses it: test/terminal-failures-6650.test.ts runs the reader on PGLite and Postgres only.
 *  - Seam: none. Typed methods only (no executeRaw beyond the harness's archive fixture). Time-dependent columns (the oldest
 *    age, the timestamps, the sequence) are compared by shape; the rest exactly.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MANAGED_SYNC_PASS_OP } from '../../src/core/persistence/sync-pass-row.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const KEY = 'principal:local_cli:parity-writer';
const KEYS = [KEY, 'brain'];
const rid = (n: number) => `b0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = (n: number) => String(n).repeat(64).slice(0, 64);

async function admit(engine: BrainEngine, n: number, sourceId: string, slug: string, operation: string, opts: { intent?: Record<string, unknown>; digest?: number; build?: string } = {}): Promise<string> {
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'parity-writer', requestId: rid(n), operation, sourceId,
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: digest(opts.digest ?? n), intent: opts.intent ?? {}, authority: {}, intentBytes: 10, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: opts.build ?? 'v-test', admitterHostId: null, counterKeys: KEYS, clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  });
  return row.id;
}

async function settle(engine: BrainEngine, id: string, state: 'committed' | 'conflict' | 'failed' | 'cancelled', fields: { code?: string; message?: string; detail?: unknown } = {}): Promise<void> {
  await engine.completeWriteRow({
    id, state, outcome: null, errorCode: fields.code ?? null, errorMessage: fields.message ?? null,
    consumerVersion: 'v-consumer', consumerHostId: null, errorDetail: fields.detail ?? null, resultBytes: 100,
    counterKeys: KEYS, intentBytes: 10, retainedBytes: 512, terminalReservation: 4096, probePurges: false,
  });
}

async function fail(engine: BrainEngine, n: number, source: string, slug: string, operation: string, state: 'conflict' | 'failed' | 'cancelled', fields: { code?: string; message?: string; detail?: unknown } = {}, opts: { intent?: Record<string, unknown>; digest?: number; build?: string } = {}): Promise<void> {
  await settle(engine, await admit(engine, n, source, slug, operation, opts), state, fields);
}

/** A row's columns except the ones that depend on the clock, which come as shapes. */
function stable(row: Record<string, unknown>): Record<string, unknown> {
  const { oldest, oldest_age, sequence, ended_at, admitted_at, ...rest } = row as Record<string, unknown> & { oldest?: unknown; oldest_age?: unknown; sequence?: unknown; ended_at?: unknown; admitted_at?: unknown };
  return { ...rest, ...(oldest !== undefined ? { oldest: typeof oldest === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(oldest) ? 'stamp' : oldest, oldest_age: oldest_age === null ? null : Number.isFinite(Number(oldest_age)) ? 'seconds' : oldest_age } : {}),
    ...(sequence !== undefined ? { sequence: /^\d+$/.test(String(sequence)) ? 'bigint' : sequence } : {}),
    ...(ended_at !== undefined ? { ended_at: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(ended_at)) ? 'stamp' : ended_at, admitted_at: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(admitted_at)) ? 'stamp' : admitted_at } : {}) };
}

/** Counts come as numbers on every engine (`::int`), but compare them as numbers anyway. */
function numbered(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['set', 'rows', 'in_window', 'n_24h', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'distinct_slugs', 'distinct_intents']) if (key in out && out[key] !== null) out[key] = Number(out[key]);
  return out;
}

const byKey = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a).localeCompare(JSON.stringify(b));

describe('doctor terminal write failure reads', () => {
  parityTest(
    'the open-pass blocker reads answer empty on a brain no pass has written to, and the aggregate and batch read nothing on an empty journal',
    { methods: ['readTerminalFailureGroups', 'listTerminalFailureBatch', 'listOpenPassCheckpointBlockers', 'listWorktreeBlockerRequests'] },
    async (engine) => {
      const empty = {
        groups: await engine.readTerminalFailureGroups({ spanDays: 8, windowDays: 7, sourceIds: null }),
        batch: await engine.listTerminalFailureBatch({ sourceId: 'default', windowDays: 7, before: null, limit: 200 }),
        passes: await engine.listOpenPassCheckpointBlockers(MANAGED_SYNC_PASS_OP, null),
        blockers: await engine.listWorktreeBlockerRequests('e0000000-0000-4000-8000-0000000000e1', rid(1)),
      };
      expect(empty).toEqual({ groups: [], batch: [], passes: [], blockers: [] });
      return empty;
    },
  );

  parityTest(
    'the aggregate groups the receipts on the classifier columns, resolves superseded ones and totals each source; the batch pairs each receipt with its later request',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'completeWriteRow', 'readTerminalFailureGroups', 'listTerminalFailureBatch'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'wiki');
      await createSource(engine, backend, 'gone');
      const sync = { kind: 'managed_sync_import' };
      // Knock-ons: the typed marker (a current build and one older than the fix), the legacy refusal text, and a pass checkpoint.
      await fail(engine, 1, 'default', 'sync/a', 'put_page', 'cancelled', { code: 'cancelled', message: 'c', detail: { origin: 'sync_knock_on' } }, { intent: sync, build: '0.60.300.0' });
      await fail(engine, 2, 'default', 'sync/b', 'put_page', 'cancelled', { code: 'cancelled', message: 'c', detail: { origin: 'sync_knock_on' } }, { intent: sync, build: '0.60.100.0' });
      await fail(engine, 3, 'default', 'sync/c', 'put_page', 'conflict', { code: 'revision_conflict', message: 'An earlier page of this sync did not commit.' }, { intent: sync });
      await fail(engine, 4, 'default', '__managed_sync_checkpoint__', 'submit_job', 'cancelled', { code: 'sync_pass_superseded', message: 'ended' });
      // Routed messages: a drifted file (message kept), a legacy publication refusal, a lost connection, and a schema-aware reason.
      await fail(engine, 5, 'default', 'notes/drift', 'put_page', 'conflict', { code: 'source_changed', message: 'x'.repeat(600) });
      await fail(engine, 6, 'default', 'notes/legacy', 'put_page', 'failed', { code: 'storage_error', message: 'Publication failed (P0001): guard' });
      await fail(engine, 7, 'default', 'notes/conn', 'remember', 'failed', { code: 'storage_error', message: 'read ECONNRESET by peer' });
      await fail(engine, 8, 'default', 'notes/schema', 'remember', 'failed', { code: 'storage_error', message: 'relation missing', detail: { origin: 'owner_exception', errno: '42P01', attempt: { consumer_version: '0.60.250.0' } } });
      await fail(engine, 9, 'default', 'notes/why', 'remember', 'failed', { code: 'fence_unrenderable', message: 'm', detail: { reason: 'because', cause: 'c1' } }, { build: '0.60.200.0' });
      // Superseded: a later same-digest commit, a later removal, a later put_page of a put_page, a later failed caller put_page.
      await fail(engine, 10, 'default', 'notes/same', 'remember', 'failed', { code: 'storage_error', message: 'x' }, { digest: 1 });
      await settle(engine, await admit(engine, 11, 'default', 'notes/same', 'remember', { digest: 1 }), 'committed');
      await fail(engine, 12, 'default', 'notes/gone', 'remember', 'failed', { code: 'storage_error', message: 'x' });
      await settle(engine, await admit(engine, 13, 'default', 'notes/gone', 'delete_page'), 'committed');
      await fail(engine, 14, 'default', 'notes/newer', 'put_page', 'failed', { code: 'storage_error', message: 'x' });
      await fail(engine, 15, 'default', 'notes/newer', 'put_page', 'failed', { code: 'storage_error', message: 'y' });
      // A second source, and an archived one that no read includes.
      await fail(engine, 16, 'wiki', 'notes/w', 'remember', 'failed', { code: 'storage_error', message: 'x' });
      await fail(engine, 17, 'gone', 'notes/z', 'remember', 'failed', { code: 'storage_error', message: 'x' });
      await archiveSource(engine, backend, 'gone');

      const rows = (await engine.readTerminalFailureGroups({ spanDays: 8, windowDays: 7, sourceIds: null })).map(r => stable(numbered(r as unknown as Record<string, unknown>))).sort(byKey);
      const scoped = (await engine.readTerminalFailureGroups({ spanDays: 8, windowDays: 7, sourceIds: ['wiki'] })).map(r => stable(numbered(r as unknown as Record<string, unknown>))).sort(byKey);
      const none = await engine.readTerminalFailureGroups({ spanDays: 8, windowDays: 7, sourceIds: ['nope'] });
      const narrow = (await engine.readTerminalFailureGroups({ spanDays: 8, windowDays: 1, sourceIds: ['default'] })).filter(r => Number(r.set) === 1).map(r => Number(r.rows));
      const batch = (await engine.listTerminalFailureBatch({ sourceId: 'default', windowDays: 7, before: null, limit: 200 })).map(r => stable(r as unknown as Record<string, unknown>));
      const all = await engine.listTerminalFailureBatch({ sourceId: 'default', windowDays: 7, before: null, limit: 200 });
      const page = (await engine.listTerminalFailureBatch({ sourceId: 'default', windowDays: 7, before: all[2]!.sequence, limit: 2 })).map(r => r.request_id);
      const other = (await engine.listTerminalFailureBatch({ sourceId: 'wiki', windowDays: 7, before: null, limit: 5 })).map(r => r.slug);
      expect(rows.length).toBeGreaterThan(10);
      expect(none).toEqual([]);
      expect(all.map(r => r.request_id)).toEqual(all.map(r => r.request_id).slice().sort().reverse());
      expect(page).toEqual(all.slice(3, 5).map(r => r.request_id));
      expect(other).toEqual(['notes/w']);
      expect(rows.some(r => r.source_id === 'gone')).toBe(false);
      return { rows, scoped, none, narrow, batch, page, other };
    },
  );
});
