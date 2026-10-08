/**
 * Pure trace analysis of scripts/bench/managed-sync-catchup-phases.ts on
 * synthetic SQL-trace records: transaction classification (lane group
 * publications, rolled-back groups, singles, waivers, recovery records), lane
 * turn waits and busy lanes, the feeder's idle vs producing split, foreground
 * spans and the steady-state rate. The bench itself never runs here.
 */
import { describe, expect, test } from 'bun:test';
import type { TraceRecord } from '../scripts/bench/managed-sync-catchup-lib.ts';
import {
  chainWaves, commitTimes, criticalPath, feederBreakdown, foregroundSpans, laneApply, publicationBreakdown, publishedPages, steadyRate, transactions,
} from '../scripts/bench/managed-sync-catchup-phases.ts';

const RTT = 60;
const DECLARE = "SELECT set_config('gbrain.persistence_protocol','2',true),set_config('synchronous_commit','on',true),\n    set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),(SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain";
const GUARD = 'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE';
const ATTRIBUTE = "SELECT set_config('gbrain.write_request',$1,true),set_config('gbrain.write_principal_kind',$2,true),set_config('gbrain.write_principal_id',$3,true)";
const INSERT_PAGE = 'INSERT INTO pages (source_id, slug, type, page_kind, title) VALUES ($1,$2,$3,$4,$5)';
const SAVE_CURSOR = 'INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys';
const TURN = 'SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid';
const ENSURE = 'INSERT INTO persistence_counters(key) SELECT k FROM unnest($1::text[]) WITH ORDINALITY AS u(k,n) ORDER BY n ON CONFLICT DO NOTHING';
const LOCK = 'SELECT * FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key COLLATE "C" FOR UPDATE';
const GROUP_DONE = "WITH m AS (\n SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::bigint[],$5::text[]) AS m(id,token,outcome,need,principal_key)\n ), done AS (\n UPDATE persistence_requests r SET state='committed',outcome=m.outcome::jsonb FROM m WHERE r.id=m.id RETURNING r.*\n ) SELECT * FROM done";
const SINGLE_DONE = 'WITH effects AS (SELECT 1 AS bytes), done AS (UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb WHERE id=$1::uuid RETURNING *) SELECT * FROM done';

/** One sequential statement chain on one connection, one RTT per statement. */
function chain(start: number, conn: number, sqls: string[], opts: { pid?: number; label?: string; ms?: number } = {}): TraceRecord[] {
  const ms = opts.ms ?? RTT;
  return sqls.map((sql, i) => ({ t: start + i * ms, ms, pid: opts.pid ?? 1, label: opts.label ?? 'cli-sync', pool: 'module', conn, backend: conn, kind: /^(begin|commit|rollback)$/.test(sql) ? 'simple' : 'execute', sql }));
}
const memberSql = [ATTRIBUTE, INSERT_PAGE, SAVE_CURSOR];
function groupTxn(start: number, conn: number, members: number, opts: { turnPolls?: number; complete?: boolean } = {}): TraceRecord[] {
  const body = [DECLARE, GUARD, ...Array.from({ length: members }, () => memberSql).flat(), ...Array.from({ length: opts.turnPolls ?? 0 }, () => TURN)];
  return chain(start, conn, ['begin', ...body, ...(opts.complete === false ? ['rollback'] : [ENSURE, LOCK, GROUP_DONE, 'commit'])]);
}

describe('transaction classification', () => {
  test('a lane group publication is a group publication, not a cursor save', () => {
    const records = groupTxn(0, 1, 4, { turnPolls: 2 });
    const [txn] = transactions(records).txns;
    expect(txn).toMatchObject({ type: 'publication', group: true, members: 4, committed: true });
    const cp = criticalPath(records, 4);
    const phase = (name: string) => (cp.phases as Array<{ phase: string; occurrences: number }>).find(p => p.phase === name)!.occurrences;
    expect(phase('publication (group)')).toBe(1);
    expect(phase('cursor')).toBe(0);
    expect(publishedPages(records)).toBe(4);
    expect((publicationBreakdown(records) as { committed: number }).committed).toBe(1);
  });

  test('a lane group rolled back before its completion is still a group publication', () => {
    const [txn] = transactions(groupTxn(0, 1, 2, { complete: false })).txns;
    expect(txn).toMatchObject({ type: 'publication', group: true, committed: false });
  });

  test('a group run by another process and connection classifies the same way', () => {
    const [txn] = transactions(groupTxn(0, 7, 3).map(r => ({ ...r, pid: 9, label: 'serve' }))).txns;
    expect(txn).toMatchObject({ type: 'publication', group: true, members: 3 });
  });

  test('single publication, waiver and recovery transactions', () => {
    const single = chain(0, 1, ['begin', DECLARE, GUARD, ENSURE, LOCK, INSERT_PAGE, SINGLE_DONE, 'commit']);
    const waiver = chain(1000, 2, ['begin', 'INSERT INTO page_write_guards(source_incarnation,slug) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING',
      'UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now() WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', 'commit']);
    const recovery = chain(2000, 3, ['begin', DECLARE, 'WITH recorded AS (UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4 WHERE id=$1::uuid RETURNING id) SELECT * FROM recorded', 'commit']);
    expect(transactions([...single, ...waiver, ...recovery]).txns.map(t => [t.type, t.group])).toEqual([['publication', false], ['waiver', false], ['recovery', false]]);
  });
});

describe('lanes', () => {
  test('turn wait is the last poll run before completion; busy lanes are time-weighted', () => {
    const records = [...groupTxn(0, 1, 2), ...groupTxn(0, 2, 2, { turnPolls: 3 })];
    const lanes = laneApply(records) as { group_txns: number; with_turn_wait: number; turn_wait_ms: { total: number }; lanes_busy: { mean: number; max: number; distribution_pct: Record<string, number> } };
    expect(lanes.group_txns).toBe(2);
    expect(lanes.with_turn_wait).toBe(1);
    expect(lanes.turn_wait_ms.total).toBe(3 * RTT);
    expect(lanes.lanes_busy.max).toBe(2);
    expect(lanes.lanes_busy.distribution_pct['2']).toBeGreaterThan(50);
    expect(lanes.lanes_busy.mean).toBeGreaterThan(1.5);
  });

  test('member validation sends the turn read too, but only the trailing run counts', () => {
    const records = chain(0, 1, ['begin', DECLARE, ATTRIBUTE, TURN, INSERT_PAGE, ATTRIBUTE, INSERT_PAGE, ENSURE, LOCK, GROUP_DONE, 'commit']);
    expect((laneApply(records) as { with_turn_wait: number }).with_turn_wait).toBe(0);
  });
});

describe('feeder', () => {
  test('the gap before a write-wait read is idle, gaps before cursor saves are producing', () => {
    const records = [
      ...chain(-100, 1, ['SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2']),
      ...chain(0, 1, ['SELECT id,slug,source_path FROM pages WHERE source_id=$1 AND source_path=ANY($2::text[])', 'WITH chosen AS ( SELECT p.* FROM pages p WHERE p.slug=$1 AND p.source_id=$2 )',
        'SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid']),
      ...chain(200, 1, ['begin', 'UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now() WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', 'commit']),
      ...chain(5000, 1, ['SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[])']),
    ];
    const feeder = feederBreakdown(records, 1) as { entries_frozen_est: number; time_ms: Record<string, number>; buckets: Record<string, { statements: number }> };
    expect(feeder.entries_frozen_est).toBe(1);
    expect(feeder.time_ms.idle_await_write).toBe(5000 - 380);
    expect(feeder.buckets.freeze!.statements).toBe(3);
    expect(feeder.buckets.cursor!.statements).toBe(4);
  });
});

describe('foreground spans', () => {
  test('a write published by the writer gets every span', () => {
    const records = [
      ...chain(100, 1, ['begin', 'INSERT INTO persistence_requests (principal_kind) VALUES ($1)', 'commit']),
      ...chain(500, 2, ['begin', "UPDATE persistence_requests SET state='running', execution_token=$2::uuid WHERE id=$1", 'commit']),
      ...chain(900, 3, ['begin', DECLARE, GUARD, ENSURE, LOCK, INSERT_PAGE, SINGLE_DONE, 'commit']),
    ].map(r => ({ ...r, label: 'foreground' }));
    const spans = foregroundSpans(records, [{ t: 1500, ms: 1500 }]) as { published_here: number; spans_ms: Record<string, { p50: number | null }> };
    expect(spans.published_here).toBe(1);
    expect(spans.spans_ms.pre_admission!.p50).toBe(100);
    expect(spans.spans_ms.preparation!.p50).toBe(900 - 680);
    expect(spans.spans_ms.publication!.p50).toBe(8 * RTT);
    expect(spans.spans_ms.visible!.p50).toBe(1500 - 1380);
  });
});

describe('rates and waves', () => {
  test('steady-state pages/min between the 10% and 90% commits', () => {
    const times = Array.from({ length: 11 }, (_, i) => 1000 + i * 6000);
    expect(steadyRate(times, 0)).toEqual({ committed: 11, pages_per_min_10_90: 10, window_s: 48, first_commit_ms: 1000 });
    expect(commitTimes(groupTxn(0, 1, 3))).toHaveLength(3);
  });

  test('overlapping records on different connections are one wave', () => {
    expect(chainWaves([...chain(0, 1, ['a']), ...chain(10, 2, ['b']), ...chain(200, 3, ['c'])]).count).toBe(2);
  });
});
