/**
 * #6650 (L3): writer terminal-state visibility.
 *
 * Protects: the read-time classifier routes heterogeneous codes by their recorded origin, survives receipt compaction,
 * names `diagnosis_required` instead of a guessed fix, and labels rows from builds older than the fixing release as
 * historical; its knock-on predicate agrees with the SQL twin the reader uses; the one aggregate reports active
 * blockers apart from history and skips archived sources; doctor `persistence_terminal_failures` warns on a blocker
 * or an unresolved defect class whatever the trend and on a spike only secondarily; the drill-down pages with a stable
 * cursor and groups on code + origin + category with an exact filter per group; a read past its deadline is
 * `unknown`, never an empty pile (on Postgres through a real statement_timeout behind a table lock). PGLite in-memory,
 * and an isolated Postgres database when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifyTerminal, terminalKnockOnSql, supersessionSql, type TerminalInput } from '../src/core/persistence/terminal-classify.ts';
import { isSyncKnockOn, knockOnDetail } from '../src/core/persistence/sync-knock-on.ts';
import { WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { readTerminalFailureSummary, readTerminalFailures, readTerminalThresholds, sevenDayMedian, validateTerminalConfigValue, TERMINAL_HISTORICAL_SQL,
  TERMINAL_STATEMENT_MS, TERMINAL_ACQUIRE_MS } from '../src/core/persistence/terminal-failures.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TERMINAL_FIXED_IN } from '../src/core/persistence/terminal-classify.ts';
import { terminalFailuresCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';

let engine: BrainEngine;

const base: TerminalInput = { source_id: 'src', slug: 'notes/a', operation: 'put_page', state: 'failed', error_code: null, error_detail: null, recovery: null,
  blocked_reason: null, compacted: false };

describe('classifyTerminal', () => {
  test('routes storage_error by origin, and an origin-less compacted one is diagnosis_required', () => {
    expect(classifyTerminal({ ...base, error_code: 'storage_error', error_detail: { origin: 'owner_exception', error_class: 'TypeError' } }))
      .toMatchObject({ category: 'owner_exception', defect: true, needs_human: true });
    expect(classifyTerminal({ ...base, error_code: 'storage_error', error_detail: { origin: 'database_trigger', sqlstate: '55000', raiser: 'gbrain_graduation_fence', reason: 'graduation_in_progress' } }))
      .toMatchObject({ category: 'transport', code: 'graduation_in_progress', class: 'connection', defect: false });
    expect(classifyTerminal({ ...base, error_code: 'storage_error', error_detail: { origin: 'database_trigger', reason: 'attribution_unclassified_table' } }))
      .toMatchObject({ category: 'database_refusal', defect: true });
    expect(classifyTerminal({ ...base, error_code: 'storage_error', error_message: 'write ECONNRESET' })).toMatchObject({ category: 'transport', code: 'connection_lost' });
    const opaque = classifyTerminal({ ...base, error_code: 'storage_error', compacted: true })!;
    expect(opaque).toMatchObject({ category: 'diagnosis_required', safe_actions: ['none'], needs_human: true, defect: false });
    expect(opaque.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'src', '--json']);
    expect(opaque.action.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'failures', 'src', '--json']);
  });

  test('routes source_changed by its recorded cause; without one it is diagnosis_required', () => {
    const drift = classifyTerminal({ ...base, state: 'conflict', error_code: 'source_changed', error_message: 'The canonical file contains an uncoordinated local edit.' })!;
    expect(drift).toMatchObject({ category: 'file_conflict', safe_actions: ['reconcile'], needs_human: true });
    // #6712 PR 2 (L4): two-sided drift routes to the scoped file-drift preview (the one exit), not the generic reconcile preview.
    expect(drift.action.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'src', '--slug', 'notes/a', '--prefer', 'database']);
    expect(classifyTerminal({ ...base, state: 'conflict', error_code: 'source_changed', error_message: 'The imported file changed after sync admission.' }))
      .toMatchObject({ category: 'sync_fault', safe_actions: ['retry'] });
    // Compaction nulls the message: the same row no longer says why, so nothing is guessed.
    expect(classifyTerminal({ ...base, state: 'conflict', error_code: 'source_changed', compacted: true })).toMatchObject({ category: 'diagnosis_required' });
  });

  test('a typed knock-on survives compaction; a recovery record outranks the code; a cancel is the operator\'s', () => {
    const detail = knockOnDetail('window_predecessor', randomUUID());
    const live = classifyTerminal({ ...base, operation: 'submit_job', state: 'cancelled', error_code: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE, intent_kind: 'managed_sync_import', error_detail: detail })!;
    const compacted = classifyTerminal({ ...base, operation: 'submit_job', state: 'cancelled', error_code: 'cancelled', compacted: true, error_detail: detail })!;
    expect(compacted).toMatchObject({ category: 'knock_on', code: 'knock_on', root_request_id: detail.root_request_id! });
    expect({ ...compacted, action: null }).toEqual({ ...live, action: null });
    expect(classifyTerminal({ ...base, state: 'committed', error_code: null, recovery: { version: 1 } })).toMatchObject({ category: 'recovery_pending', needs_human: false });
    expect(classifyTerminal({ ...base, state: 'failed', error_code: 'storage_error', recovery: { version: 1 }, blocked_reason: 'unexpected_file_bytes' }))
      .toMatchObject({ category: 'recovery_blocked', needs_human: true });
    expect(classifyTerminal({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: 'Cancelled before publication.' }))
      .toMatchObject({ category: 'operator_cancelled', needs_human: false, defect: false });
    expect(classifyTerminal({ ...base, state: 'committed' })).toBeNull();
  });

  test('a row from a build older than the release that fixed its class is historical; an unknown code is diagnosis_required', () => {
    const knock = { ...base, operation: 'submit_job', state: 'cancelled', error_code: 'cancelled', error_detail: knockOnDetail('lane_fault', null) };
    expect(classifyTerminal({ ...knock, build: '0.60.200.0' })).toMatchObject({ category: 'knock_on', fixed_in: '0.60.216.0', historical: true });
    expect(classifyTerminal({ ...knock, build: '0.60.216.0' })).toMatchObject({ historical: false });
    expect(classifyTerminal({ ...knock, error_detail: { ...knockOnDetail('lane_fault', null), attempt: { consumer_version: '0.60.100.0', consumer_host_id: null } } }))
      .toMatchObject({ historical: true });
    expect(classifyTerminal({ ...base, error_code: 'storage_error', error_message: 'Publication failed (P0001). Inspect owner diagnostics.' }))
      .toMatchObject({ category: 'legacy_publication_refusal', historical: true, defect: false });
    expect(classifyTerminal({ ...base, error_code: 'made_up_code' })).toMatchObject({ category: 'diagnosis_required' });
    expect(classifyTerminal({ ...base, error_code: 'writer_coordinator_required', error_detail: { origin: 'database_guard', sqlstate: 'P0001' } }))
      .toMatchObject({ category: 'writer_guard', defect: true });
  });
});

const SOURCE = 'tf-a';
const OTHER = 'tf-archived';
async function seed(o: { source?: string; slug: string; operation?: string; state: string; code?: string | null; message?: string | null; detail?: unknown; recovery?: unknown;
  compacted?: boolean; digest?: string; hoursAgo?: number; build?: string; kind?: string; blocked?: string }): Promise<string> {
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,error_code,error_message,error_detail,recovery,compacted,intent,completed_at,updated_at,admitter_version,blocked_reason)
    VALUES('local_cli','fixture',$1::uuid,$2,$3,(SELECT incarnation FROM sources WHERE id=$3),$4,$5,'{}'::jsonb,0,0,$6,$7,$8,$9::text::jsonb,$10::text::jsonb,$11,$12::text::jsonb,
      now()-($13::double precision*interval '1 hour'),now()-($13::double precision*interval '1 hour'),$14,$15)`,
  [requestId, o.operation ?? 'put_page', o.source ?? SOURCE, o.slug, o.digest ?? randomUUID(), o.state, o.code ?? null, o.compacted ? null : o.message ?? null,
    o.detail === undefined ? null : JSON.stringify(o.detail), o.recovery === undefined ? null : JSON.stringify(o.recovery), o.compacted === true,
    o.compacted ? null : JSON.stringify(o.kind ? { kind: o.kind } : { content: 'x' }), o.hoursAgo ?? 1, o.build ?? '0.60.216.0', o.blocked ?? null]);
  return requestId;
}

for (const kind of testBackends()) describe(`the aggregate, doctor and the drill-down (${kind})`, () => {
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM persistence_requests');
    await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[SOURCE, OTHER]]);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)", [SOURCE, OTHER]);
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [OTHER]);
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.terminal_failures.%' OR key='persistence.receipt_retention_days'");
  });

  test('the knock-on SQL twin agrees with isSyncKnockOn on every seeded receipt', async () => {
    const cases = [
      { slug: 'k1', operation: 'submit_job', state: 'cancelled', code: 'cancelled', message: WINDOW_CANCEL_MESSAGE, kind: 'managed_sync_import' },
      { slug: 'k2', operation: 'submit_job', state: 'cancelled', code: 'cancelled', message: WINDOW_CANCEL_MESSAGE, kind: 'facts_extract' },
      { slug: 'k3', operation: 'submit_job', state: 'cancelled', code: 'cancelled', compacted: true, detail: knockOnDetail('bulk_group', null) },
      { slug: 'k4', operation: 'submit_job', state: 'cancelled', code: 'cancelled', message: 'Cancelled before publication.', kind: 'managed_sync_import' },
      { slug: 'k5', operation: 'submit_job', state: 'cancelled', code: 'cancelled', compacted: true },
      { slug: 'k6', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knockOnDetail('lane_fault', null) },
      { slug: 'k7', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knockOnDetail('lane_fault', null), kind: 'facts_extract' },
      { slug: 'k8', operation: 'submit_job', state: 'cancelled', code: 'cancelled', message: WINDOW_CANCEL_MESSAGE },
    ];
    for (const c of cases) await seed(c);
    const rows = await engine.executeRaw<{ slug: string; sql: boolean; state: string; error_code: string; error_message: string | null; error_detail: unknown; intent: unknown }>(
      `SELECT slug, ${terminalKnockOnSql('r')} AS sql, state, error_code, error_message, error_detail, intent FROM persistence_requests r ORDER BY slug`);
    for (const row of rows) expect([row.slug, row.sql]).toEqual([row.slug, isSyncKnockOn({ ...row, recovery: null, publication_started: false } as never)]);
    expect(rows.filter(row => row.sql).map(row => row.slug)).toEqual(['k1', 'k3', 'k6']);
  });

  test('blockers, unresolved, historical and defects are reported apart; archived sources are skipped', async () => {
    const blocker = await seed({ slug: 'notes/held', state: 'committed', recovery: { version: 1, path: '/nonexistent/x.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' } });
    for (let i = 0; i < 3; i++) await seed({ slug: `sync/k${i}`, operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knockOnDetail('lane_fault', null), build: '0.60.200.0', hoursAgo: 30 });
    const digest = randomUUID();
    await seed({ slug: 'notes/drift', state: 'conflict', code: 'source_changed', message: 'The canonical file contains an uncoordinated local edit.', digest, hoursAgo: 50 });
    await seed({ slug: 'notes/drift', state: 'committed', digest: randomUUID(), hoursAgo: 40 });
    await seed({ slug: 'notes/drift2', state: 'conflict', code: 'source_changed', message: 'The canonical file contains an uncoordinated local edit.', hoursAgo: 60 });
    await seed({ slug: 'notes/opaque', state: 'failed', code: 'storage_error', compacted: true, hoursAgo: 2 });
    await seed({ source: OTHER, slug: 'notes/gone', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception' } });
    const summary = await readTerminalFailureSummary(engine);
    expect(summary.status).toBe('ok');
    if (summary.status !== 'ok') return;
    expect(summary.sources.map(s => s.source_id)).toEqual([SOURCE]);
    const s = summary.sources[0]!;
    expect(s.active_blockers).toEqual([expect.objectContaining({ kind: 'recovery', request_id: blocker, slug: 'notes/held', category: 'recovery_pending' })]);
    expect(s.active_blockers[0]!.action.argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull', '--json']);
    // Three old-build knock-ons and the drift a later put_page superseded are history; the other drift and the opaque row are not.
    expect(s.historical_rows).toBe(4);
    expect(s.unresolved).toMatchObject({ rows: 2, distinct_slugs: 2, distinct_intents: 2 });
    expect(s.unresolved.oldest_age_seconds).toBeGreaterThanOrEqual(59 * 3600);
    expect(s.defects).toEqual([]);
    expect(s.new_last_24h).toBe(1);

    const check = (await terminalFailuresCheck(engine))!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`recovery record ${blocker} (notes/held) on source ${SOURCE}`);
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull', '--json']);
    expect((check.fix as { verify: { argv: string[] } }).verify.argv).toEqual(['gbrain', 'doctor', '--only', 'persistence_terminal_failures', '--json']);
    expect(check.details).toMatchObject({ unresolved: { rows: 2 }, historical_rows: 4, new_last_24h: 1 });

    // With the recovery record gone, nothing blocks and no defect is open: the pile alone does not warn.
    await engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE request_id=$1::uuid', [blocker]);
    expect((await terminalFailuresCheck(engine))!.status).toBe('ok');
    // An owner exception is a gbrain defect: it warns whatever the trend, on an active source only.
    await seed({ slug: 'notes/boom', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception', error_class: 'TypeError' }, hoursAgo: 100 });
    const defect = (await terminalFailuresCheck(engine))!;
    expect(defect.status).toBe('warn');
    expect(defect.message).toContain('owner_exception/storage_error ×1');
  });

  test('a spike warns secondarily, against the zero-filled 7-day median, with its thresholds named as config keys', async () => {
    expect(sevenDayMedian([0, 0, 1])).toBe(0);
    await engine.setConfig('persistence.terminal_failures.spike_min', '3');
    for (let i = 0; i < 4; i++) await seed({ slug: `notes/c${i}`, state: 'conflict', code: 'revision_conflict', hoursAgo: 1 });
    const check = (await terminalFailuresCheck(engine))!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('above 3× the 7-day median (0/day');
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--group-by', 'category', '--json']);
    expect(check.details).toMatchObject({ config: { spike_min: { key: 'persistence.terminal_failures.spike_min', value: 3 }, spike_factor: { key: 'persistence.terminal_failures.spike_factor', value: 3 } } });
    expect(validateTerminalConfigValue('persistence.terminal_failures.window_days', '0')).toStartWith('persistence.terminal_failures.window_days must be a whole number');
    expect(validateTerminalConfigValue('persistence.terminal_failures.spike_factor', '2.5')).toBeNull();
  });

  test('a request parked recovering with its record (a blocked restore) is an active blocker everywhere, never a 24 h failure', async () => {
    const parked = await seed({ slug: 'notes/parked', state: 'recovering', code: 'storage_error', detail: { origin: 'owner_exception' },
      recovery: { version: 1, path: '/nonexistent/p.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' }, blocked: 'unexpected_file_bytes' });
    await seed({ slug: 'notes/flight', state: 'running', recovery: { version: 1, path: '/nonexistent/f.md', root: '/nonexistent', beforeHash: null, afterHash: 'b' } });
    const summary = await readTerminalFailureSummary(engine);
    if (summary.status !== 'ok') throw new Error('unknown');
    const s = summary.sources.find(x => x.source_id === SOURCE)!;
    // An in-flight claim's record is publication in progress, not a blocker.
    expect(s.active_blockers).toEqual([expect.objectContaining({ kind: 'recovery', request_id: parked, slug: 'notes/parked', category: 'recovery_blocked', needs_human: true })]);
    expect(s.new_last_24h).toBe(0);
    expect(s.unresolved.rows).toBe(0);
    const check = (await terminalFailuresCheck(engine))!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`recovery record ${parked} (notes/parked)`);
    const listing = await readTerminalFailures(engine, { sourceId: SOURCE });
    if (listing.status !== 'ok') throw new Error('unknown');
    expect(listing.rows!.map(r => [r.request_id, r.blocking, r.category])).toEqual([[parked, true, 'recovery_blocked']]);
  });

  test('a spike an older write owner drives says so and names its build, instead of reading as a new defect', async () => {
    await engine.setConfig('persistence.terminal_failures.spike_min', '3');
    for (let i = 0; i < 4; i++) await seed({ slug: `notes/k${i}`, operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knockOnDetail('window_predecessor', null), build: '0.60.200.0', hoursAgo: 1 });
    await seed({ slug: 'notes/c', state: 'conflict', code: 'revision_conflict', hoursAgo: 1 });
    const summary = await readTerminalFailureSummary(engine);
    if (summary.status !== 'ok') throw new Error('unknown');
    expect(summary.sources[0]!.new_last_24h_older_builds).toEqual({ rows: 4, builds: ['0.60.200.0'] });
    const check = (await terminalFailuresCheck(engine))!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('4 of them were written by gbrain 0.60.200.0, older than the release that fixed their class: an older write owner is still producing these; upgrade or restart it.');
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', SOURCE, '--json']);
    expect(check.details).toMatchObject({ spike: { spiking: true, older_builds: { rows: 4, builds: ['0.60.200.0'] } } });
    // The same spike from the current build stays the generic drill-down.
    await engine.executeRaw('DELETE FROM persistence_requests');
    for (let i = 0; i < 4; i++) await seed({ slug: `notes/k${i}`, operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knockOnDetail('window_predecessor', null), hoursAgo: 1 });
    const current = (await terminalFailuresCheck(engine))!;
    expect(current.message).not.toContain('older write owner');
    expect((current.fix as { argv: string[] }).argv.slice(0, 4)).toEqual(['gbrain', 'sources', 'writer', 'failures']);
  });

  test('the window is clamped to receipt retention', async () => {
    await engine.setConfig('persistence.receipt_retention_days', '3');
    expect(await readTerminalThresholds(engine, 7)).toMatchObject({ windowDays: 3, clamped: true, retentionDays: 3 });
    expect(await readTerminalThresholds(engine, 2)).toMatchObject({ windowDays: 2, clamped: false });
  });

  test('the drill-down pages newest first with a cursor and groups with an exact filter', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed({ slug: `notes/r${i}`, state: 'conflict', code: 'revision_conflict', hoursAgo: 10 - i }));
    const opaque = await seed({ slug: 'notes/opaque', state: 'failed', code: 'storage_error', compacted: true, hoursAgo: 1 });
    const first = await readTerminalFailures(engine, { sourceId: SOURCE, limit: 2 });
    if (first.status !== 'ok') throw new Error('unknown');
    expect(first.rows!.map(r => r.request_id)).toEqual([opaque, ids[4]]);
    expect(first.truncated).toBe(true);
    expect(first.next).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--limit', '2', '--before', first.next_cursor!, '--json']);
    expect(first.rows![0]!.inspect.argv).toEqual(['gbrain', 'write-request', opaque, '--json']);
    const second = await readTerminalFailures(engine, { sourceId: SOURCE, limit: 2, before: first.next_cursor! });
    if (second.status !== 'ok') throw new Error('unknown');
    expect(second.rows!.map(r => r.request_id)).toEqual([ids[3], ids[2]]);
    const last = await readTerminalFailures(engine, { sourceId: SOURCE, limit: 2, before: (await readTerminalFailures(engine, { sourceId: SOURCE, limit: 4 }) as { next_cursor: string }).next_cursor });
    if (last.status !== 'ok') throw new Error('unknown');
    expect(last.rows!.map(r => r.request_id)).toEqual([ids[1], ids[0]]);
    expect(last.truncated).toBe(false);

    const grouped = await readTerminalFailures(engine, { sourceId: SOURCE, groupBy: 'category' });
    if (grouped.status !== 'ok') throw new Error('unknown');
    expect(grouped.groups!.map(g => [g.category, g.code, g.origin, g.rows])).toEqual([['caller_conflict', 'revision_conflict', null, 5], ['diagnosis_required', 'storage_error', null, 1]]);
    const group = grouped.groups![1]!;
    expect(group.drill_down).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--category', 'diagnosis_required', '--code', 'storage_error', '--origin', 'none', '--json']);
    expect(group.samples[0]!.inspect.argv).toEqual(['gbrain', 'write-request', opaque, '--json']);
    const filtered = await readTerminalFailures(engine, { sourceId: SOURCE, category: 'diagnosis_required', code: 'storage_error', origin: 'none' });
    if (filtered.status !== 'ok') throw new Error('unknown');
    expect(filtered.rows!.map(r => r.request_id)).toEqual([opaque]);
  });

  test('a read past its statement deadline is unknown, and doctor says health is unknown', async () => {
    await seed({ slug: 'notes/x', state: 'failed', code: 'storage_error', compacted: true });
    const slow = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
        if (sql.includes('GROUPING SETS') || sql.includes('LEFT JOIN LATERAL')) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        return target.executeRaw(sql, params, opts as never);
      };
      return Reflect.get(target, key);
    } }) as BrainEngine;
    expect((await readTerminalFailureSummary(slow)).status).toBe('unknown');
    expect((await readTerminalFailures(slow, { sourceId: SOURCE })).status).toBe('unknown');
    const check = (await terminalFailuresCheck(slow))!;
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ health: 'unknown' });
  });

  if (kind === 'postgres') test('on Postgres the statement deadline is real: a read blocked behind a table lock is unknown, not empty', async () => {
    await seed({ slug: 'notes/x', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception' } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = engine.transaction(async tx => { await tx.executeRaw('LOCK TABLE persistence_requests IN ACCESS EXCLUSIVE MODE'); locked(); await held; });
    await acquired;
    try {
      const started = Date.now();
      expect((await readTerminalFailureSummary(engine)).status).toBe('unknown');
      expect(Date.now() - started).toBeLessThan(TERMINAL_STATEMENT_MS + TERMINAL_ACQUIRE_MS + 3_000);
      expect((await readTerminalFailures(engine, { sourceId: SOURCE })).status).toBe('unknown');
    } finally { release(); await holder; }
    const after = await readTerminalFailureSummary(engine);
    expect(after.status === 'ok' && after.sources[0]?.unresolved.rows).toBe(1);
  }, 60_000);

  test('the SQL twin of historical-by-build covers every fixed class and agrees with the classifier', async () => {
    expect(Object.keys(TERMINAL_HISTORICAL_SQL).sort()).toEqual(Object.keys(TERMINAL_FIXED_IN).sort());
    const knock = knockOnDetail('lane_fault', null);
    await seed({ slug: 'h1', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knock, build: '0.60.215.9' });
    await seed({ slug: 'h2', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knock, build: '0.60.216.0' });
    await seed({ slug: 'h3', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: { ...knock, attempt: { consumer_version: '0.59.1', consumer_host_id: null } }, build: '0.60.300.0' });
    await seed({ slug: 'h4', state: 'failed', code: 'storage_error', message: 'Publication failed (P0001). Inspect owner diagnostics.' });
    await seed({ slug: 'h5', state: 'failed', code: 'storage_error', message: 'Publication failed (P0001 in x: unknown). Inspect owner diagnostics.', detail: { origin: 'database_trigger', raiser: 'x' } });
    await seed({ slug: 'h6', operation: 'submit_job', state: 'cancelled', code: 'cancelled', detail: knock, build: 'dev-build' });
    await seed({ slug: 'h7', operation: 'submit_job', state: 'failed', code: 'fence_unrenderable', message: 'The adopted fence row does not render its legacy fact.', build: '0.60.217.0' });
    await seed({ slug: 'h8', operation: 'submit_job', state: 'failed', code: 'fence_unrenderable', message: 'The adopted fence row does not render its legacy fact.', build: '0.60.218.0' });
    const all = Object.values(TERMINAL_HISTORICAL_SQL).map(sql => sql('b')).join(' OR ');
    const rows = await engine.executeRaw<{ slug: string; flag: boolean; state: string; error_code: string; error_message: string | null; error_detail: Record<string, unknown> | null; operation: string;
      compacted: boolean; build: string | null }>(`SELECT b.*, (${all}) AS flag FROM (SELECT r.slug, r.state, r.error_code, r.error_message, r.error_detail, r.operation, r.compacted,
        r.error_detail->>'origin' AS origin, r.recovery IS NOT NULL AS has_recovery, ${terminalKnockOnSql('r')} AS knock_on,
        CASE WHEN r.error_detail IS NULL AND r.error_message LIKE 'Publication failed (P0001)%' THEN 'Publication failed (P0001)' END AS routed_message,
        COALESCE(r.error_detail->'attempt'->>'consumer_version', r.admitter_version) AS build FROM persistence_requests r) b ORDER BY b.slug`);
    const ts = rows.map(row => [row.slug, classifyTerminal({ ...base, ...row, recovery: null, blocked_reason: null })!.historical]);
    expect(rows.map(row => [row.slug, row.flag])).toEqual(ts as never);
    expect(ts).toEqual([['h1', true], ['h2', false], ['h3', true], ['h4', true], ['h5', false], ['h6', false], ['h7', true], ['h8', false]]);
  });

  test('the extracted supersession rule is the one failed-writes applies', async () => {
    const digest = randomUUID();
    await seed({ slug: 'notes/s', state: 'failed', code: 'writer_coordinator_required', digest, hoursAgo: 5 });
    await seed({ slug: 'notes/s', state: 'committed', digest, hoursAgo: 4 });
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests r JOIN persistence_requests c ON ${supersessionSql('r', 'c')} WHERE r.state='failed'`);
    expect(row!.n).toBe(1);
    expect(categorizeCheck('persistence_terminal_failures')).toBe('ops');
    expect(WAVE_CHECKS.find(spec => spec.id === 'persistence_terminal_failures')).toMatchObject({ resolution: 'operator', registration: 'doctor.ts' });
  });
});
