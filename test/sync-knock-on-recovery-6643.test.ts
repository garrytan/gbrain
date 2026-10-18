/**
 * #6643: managed sync recovers from its own knock-ons; #6712 (one page, one fate) retired every producer.
 *
 * Protects: a legacy knock-on receipt an older build wrote (a page cancelled or refused only because another page of
 * the same sync did not commit) is re-frozen in place under a fresh request by the run itself, even under
 * `sync.holds=fail` and without `--retry-failed`; an operator's cancel is never re-frozen; the re-freeze is bounded per
 * entry (`STOPS_PER_ENTRY`, no config key) and past it the failure is recorded as a retryable page fault; the retired
 * `knock_on_exhausted` code renders superseded; the pre-#6643 producer messages are recognised, nothing else is; and
 * the checkpoint waits on every receipt the cursor did not settle (no knock-on exemption).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync, STOPS_PER_ENTRY } from '../src/core/persistence/sync-run.ts';
import { __setManagedCursorKeyForTests } from '../src/core/persistence/sync-cursor-key.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { laneFaultCancelMessage, WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { BULK_GROUP_CANCEL_MESSAGE, EARLIER_PAGE_REFUSAL_MESSAGE, isSyncKnockOn, knockOnDetail, LEGACY_KNOCK_ON_CANCEL_MESSAGES, legacyKnockOnMessage,
  syncKnockOnSql } from '../src/core/persistence/sync-knock-on.ts';
import { CODES } from '../src/core/error-registry.ts';
import { addSettledRange, findIncompleteSyncReceipt } from '../src/core/persistence/checkpoint-validation.ts';
import { publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { cursorFenceRefusal } from '../src/core/persistence/sync-prepare.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6643-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
const page = (kind: string) => ({ kind });

async function fixture(files: Record<string, string>) {
  const id = `ko-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}

/**
 * A managed run stopped on its second page (a.md committed, b.md refused because it changed after the freeze), with
 * b.md then restored to its committed bytes. Returns the stopped request and the committed request of a.md.
 */
async function stoppedRun() {
  const f = await fixture({ 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
  commit(f.root, 'version two');
  writeFileSync(join(f.root, 'b.md'), note('Beta, uncommitted.'));
  await engine.setConfig('sync.holds', 'fail');
  expect((await performManagedSync(engine, f.opts)).status).toBe('blocked_by_failures');
  git(f.root, 'checkout', '--', 'b.md');
  const [failure] = await readManagedSyncFailures(engine, [f.id]);
  const stopped = failure!.request_id!;
  const [root] = await engine.executeRaw<{ request_id: string }>(
    "SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND slug='a' AND state='committed' ORDER BY sequence DESC LIMIT 1", [f.id]);
  return { ...f, stopped, rootRequest: root!.request_id };
}
/** Rewrites the stopped request into the receipt a knock-on producer writes, as first observed (no ledger row yet). */
async function asKnockOn(requestId: string, message: string, detail: unknown, state = 'cancelled', code = 'cancelled') {
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'request_id'=$1", [requestId]);
  await engine.executeRaw(`UPDATE persistence_requests SET state=$2, error_code=$3, error_message=$4, error_detail=$5::jsonb, recovery=NULL, publication_started=false
    WHERE request_id=$1::uuid`, [requestId, state, code, message, detail == null ? null : JSON.stringify(detail)]);
}
const clearConfig = () => engine.executeRaw("DELETE FROM config WHERE key='sync.holds'");

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the pre-#6643 producer messages are the only untyped knock-ons; an operator cancel never is', () => {
  expect(LEGACY_KNOCK_ON_CANCEL_MESSAGES).toContain(WINDOW_CANCEL_MESSAGE);
  expect(LEGACY_KNOCK_ON_CANCEL_MESSAGES).toContain(laneFaultCancelMessage('lock_timeout'));
  expect(LEGACY_KNOCK_ON_CANCEL_MESSAGES).toContain(laneFaultCancelMessage('statement_timeout'));
  const base = { recovery: null, publication_started: false, error_detail: null, intent: page('managed_sync_import') } as const;
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE } as never)).toBe(true);
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: BULK_GROUP_CANCEL_MESSAGE } as never)).toBe(true);
  expect(isSyncKnockOn({ ...base, state: 'conflict', error_code: 'revision_conflict', error_message: EARLIER_PAGE_REFUSAL_MESSAGE } as never)).toBe(true);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', 'Its predecessor request 1 was never admitted; this page was not published and is re-frozen on the next sync pass.')).toBe(true);
  // An operator's cancel, a compacted receipt with no message, a published or recovering row, and a non-sync request are not knock-ons.
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: 'Cancelled before publication.' } as never)).toBe(false);
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: null } as never)).toBe(false);
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE, publication_started: true } as never)).toBe(false);
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE, recovery: {} } as never)).toBe(false);
  expect(isSyncKnockOn({ ...base, state: 'cancelled', error_code: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE, intent: page('put_page') } as never)).toBe(false);
  // The typed marker survives compaction (no intent, no message).
  expect(isSyncKnockOn({ ...base, intent: null, state: 'cancelled', error_code: 'cancelled', error_message: null, error_detail: knockOnDetail('bulk_group', null) } as never)).toBe(true);
  // #6712: the retired stop renders superseded: a retryable page fault a plain sync resumes, never a human page.
  expect(classifySyncFault({ code: 'knock_on_exhausted' })).toEqual({ class: 'page', safe_actions: ['retry'], needs_human: false });
  expect(CODES.knock_on_exhausted).toMatchObject({ retired_in: '0.60.255.0' });
});

test('the SQL predicate agrees with isSyncKnockOn row by row', async () => {
  const rows: Array<[string, string | null, string | null, unknown, boolean]> = [
    ['cancelled', 'cancelled', WINDOW_CANCEL_MESSAGE, null, true],
    ['cancelled', 'cancelled', 'Cancelled before publication.', null, false],
    ['conflict', 'revision_conflict', EARLIER_PAGE_REFUSAL_MESSAGE, null, true],
    ['failed', 'revision_conflict', 'The page changed.', null, false],
    ['cancelled', 'cancelled', null, knockOnDetail('window_dropped', randomUUID()), true],
    ['committed', null, null, knockOnDetail('window_dropped', null), false],
  ];
  for (const [state, code, message, detail, expected] of rows) {
    const [hit] = await engine.executeRaw<{ hit: boolean }>(`SELECT ${syncKnockOnSql('r')} AS hit FROM (SELECT $1::text AS state, $2::text AS error_code, $3::text AS error_message,
      $4::jsonb AS error_detail, NULL::jsonb AS recovery, false AS publication_started) r`, [state, code, message, detail == null ? null : JSON.stringify(detail)]);
    expect(hit!.hit).toBe(expected);
    expect(isSyncKnockOn({ state, error_code: code, error_message: message, error_detail: detail, recovery: null, publication_started: false, intent: page('managed_sync_import') } as never)).toBe(expected);
  }
});

test('a knock-on is re-frozen by the plain sync under sync.holds=fail, and the run finishes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    await asKnockOn(f.stopped, WINDOW_CANCEL_MESSAGE, knockOnDetail('window_predecessor', f.rootRequest));
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed.status).not.toBe('blocked_by_failures');
    const status = await readSyncStatus(engine, f.id);
    expect(status.cursor?.done).toBe(true);
    // The stopped receipt is immutable; the page committed under a fresh request.
    const [old] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [f.stopped]);
    expect(old!.state).toBe('cancelled');
    const [b] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug='b' AND state='committed'", [f.id]);
    expect(b!.n).toBe(2);
  } finally { await clearConfig(); }
}), 120_000);

test('a pre-#6643 untyped knock-on is recovered the same way', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    await asKnockOn(f.stopped, EARLIER_PAGE_REFUSAL_MESSAGE, null, 'conflict', 'revision_conflict');
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed.status).not.toBe('blocked_by_failures');
    expect((await readSyncStatus(engine, f.id)).cursor?.done).toBe(true);
  } finally { await clearConfig(); }
}), 120_000);

test('an operator cancel is never re-frozen', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    await asKnockOn(f.stopped, 'Cancelled before publication.', null);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed.status).toBe('blocked_by_failures');
    expect(resumed.failureCodes).toEqual([{ code: 'cancelled', count: 1 }]);
  } finally { await clearConfig(); }
}), 120_000);

test('a legacy knock-on is re-frozen at most STOPS_PER_ENTRY times in a row; past that the failure is recorded as a retryable page fault', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    await asKnockOn(f.stopped, WINDOW_CANCEL_MESSAGE, knockOnDetail('window_predecessor', f.rootRequest));
    // The entry was already re-frozen STOPS_PER_ENTRY times in a row.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,pending,stops}',to_jsonb($2::int))
      WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [f.id, STOPS_PER_ENTRY]);
    const resumed = await performManagedSync(engine, f.opts);
    expect(resumed.status).toBe('blocked_by_failures');
    expect(resumed.failureCodes).toEqual([{ code: 'cancelled', count: 1 }]);
    const status = await readSyncStatus(engine, f.id);
    expect(status.last_error).toMatchObject({ code: 'cancelled', class: 'page', safe_actions: ['retry'], needs_human: false });
    expect(status.needs_human).toBe(false);
    // The printed retry finishes the sync.
    const again = await performManagedSync(engine, { ...f.opts, retryFailed: true });
    expect(again.status).not.toBe('blocked_by_failures');
    expect((await readSyncStatus(engine, f.id)).cursor?.done).toBe(true);
  } finally { await clearConfig(); }
}), 180_000);

test('the checkpoint waits on every receipt the cursor did not settle, a legacy knock-on included (#6712), and skips the indexes a cursor settled', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    const [row] = await engine.executeRaw<{ worktree_id: string; run_id: string; idx: number }>(
      "SELECT worktree_id::text AS worktree_id, intent->>'runId' AS run_id, (intent->>'index')::int AS idx FROM persistence_requests WHERE request_id=$1::uuid", [f.stopped]);
    const check = (settled: Parameters<typeof findIncompleteSyncReceipt>[4]) => findIncompleteSyncReceipt(engine, row!.worktree_id, row!.run_id, [], settled);
    // A real failure (no knock-on marker, no matching message) blocks under every cursor shape.
    expect(await check(null)).toBe(f.stopped);
    expect(await check({ from: 0, ranges: [] })).toBe(f.stopped);
    await asKnockOn(f.stopped, WINDOW_CANCEL_MESSAGE, knockOnDetail('window_predecessor', f.rootRequest));
    // #6712: no knock-on exemption: a legacy knock-on blocks unless the cursor settled its index or converted it.
    expect(await check(null)).toBe(f.stopped);
    expect(await findIncompleteSyncReceipt(engine, row!.worktree_id, row!.run_id, [f.stopped], null)).toBeNull();
    expect(await check({ from: 0, ranges: [] })).toBe(f.stopped);
    expect(await check({ from: 0, ranges: [[row!.idx, row!.idx]] })).toBeNull();
    expect(addSettledRange(addSettledRange({ from: 0, ranges: [] }, 1, 2), 3, 4)).toEqual({ from: 0, ranges: [[1, 4]] });
    expect(addSettledRange({ from: 0, ranges: [[1, 2]] }, 5, 5)).toEqual({ from: 0, ranges: [[1, 2], [5, 5]] });
  } finally { await clearConfig(); }
}), 120_000);

// #6712 PR 3 (L7): --retry-failed is a deprecated alias of the plain sync, so both rediscover the run and finish.
for (const retryFailed of [false, true]) test(`#6712: a checkpoint a legacy knock-on still blocks is rediscovered by the next ${retryFailed ? '--retry-failed (plain sync alias)' : 'plain'} sync and finishes`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    // The pre-#6643 shape: the cursor passed the stopped page (no settled ranges recorded) and froze its checkpoint.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys #- '{0,pending}' #- '{0,settled}', '{0,index}', completed_keys->0->'total')
      WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [f.id]);
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1", [f.id]);
    const refused = await performManagedSync(engine, f.opts);
    expect(refused.status).toBe('blocked_by_failures');
    expect(refused.failures?.[0]).toMatchObject({ code: 'recovery_required', phase: 'checkpoint', root_cause: { request_id: f.stopped } });
    expect((await readSyncStatus(engine, f.id)).checkpoint_blockers).toEqual([expect.objectContaining({ request_id: f.stopped, slug: 'b', knock_on: false })]);
    // The receipt that refused it was a knock-on (a pre-#6643 producer's message): it still blocks, and status says what it is.
    await asKnockOn(f.stopped, WINDOW_CANCEL_MESSAGE, null);
    expect((await readSyncStatus(engine, f.id)).checkpoint_blockers).toEqual([expect.objectContaining({ request_id: f.stopped, slug: 'b', knock_on: true })]);
    const resumed = await performManagedSync(engine, { ...f.opts, retryFailed });
    expect(resumed.status).not.toBe('blocked_by_failures');
    expect((await readSyncStatus(engine, f.id)).cursor).toMatchObject({ done: true });
    const [source] = await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]);
    expect(source!.last_commit).toBe(git(f.root, 'rev-parse', 'HEAD'));
  } finally { await clearConfig(); }
}), 120_000);

test('a stop on an outside_fence refusal is a root that needs a person in sync status, not a retryable revision_conflict', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  expect(publicFailureDetail({ origin: 'sync_cursor_fence', cause: 'outside_fence', fence: { index: 3 } })).toMatchObject({ cause: 'outside_fence' });
  expect(publicFailureDetail({ origin: 'sync_cursor_fence', cause: 'anything else' })).not.toHaveProperty('cause');
  try {
    const f = await stoppedRun();
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(jsonb_set(completed_keys,'{0,code}','"revision_conflict"'),'{0,write_error_detail}',$1::jsonb)
      WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$2`, [JSON.stringify({ origin: 'sync_cursor_fence', cause: 'outside_fence' }), f.id]);
    const status = await readSyncStatus(engine, f.id);
    expect(status.last_error).toMatchObject({ code: 'revision_conflict', detail: 'outside_fence', class: 'systemic', needs_human: true });
    expect(status.needs_human).toBe(true);
    expect(status.next?.argv).not.toContain('--retry-failed');
    expect(status.cursors).toHaveLength(1);
    expect(status.cursors[0]).toMatchObject({ run_id: status.run_id, shown: true, done: false, pending: { request_id: f.stopped } });
  } finally { await clearConfig(); }
}), 120_000);

test('#6712: the cursor fence has two causes; a request the cursor does not hold is outside_fence, even one an older cursor recorded dropping', () => {
  const run = randomUUID(), root = randomUUID(), member = randomUUID(), now = randomUUID();
  const row = (id: string) => ({ request_id: id, source_id: 'default' }) as never;
  const intent = { kind: 'managed_sync_import', runId: run, index: 7 } as never;
  const fence = { run_id: run, request_id: now, group: null, index: 3, dropped: [{ requestId: member, root }] };
  const detail = (id: string, f: typeof fence) => cursorFenceRefusal(row(id), intent, f).syncRefusal as Record<string, unknown>;
  expect(detail(member, fence)).toMatchObject({ cause: 'outside_fence', origin: 'sync_cursor_fence' });
  expect(detail(member, fence)).not.toHaveProperty('root_request_id');
  expect(detail(member, { ...fence, run_id: randomUUID() })).toMatchObject({ cause: 'run_replaced' });
});

test('with two cursors, sync status shows the one its recorded failure belongs to and lists both', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  try {
    const f = await stoppedRun();
    const blockedRun = (await readSyncStatus(engine, f.id)).run_id!;
    await clearConfig();
    // A newer cursor of the same source, selected by different options, runs to the end. #6712 PR 1: one key per source,
    // so a second cursor is one an older gbrain left under its own key; it ran while the blocked cursor did not exist for it.
    const blockedKey = (await engine.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]))[0]!.fingerprint;
    await engine.executeRaw("UPDATE op_checkpoints SET op='managed-sync-parked' WHERE op='managed-sync' AND fingerprint=$1", [blockedKey]);
    __setManagedCursorKeyForTests(() => `${f.id}-older-key`);
    let other: Awaited<ReturnType<typeof performManagedSync>>;
    try { other = await performManagedSync(engine, { ...f.opts, exclude: ['nothing-matches/**'] }); }
    finally {
      __setManagedCursorKeyForTests(null);
      await engine.executeRaw("UPDATE op_checkpoints SET op='managed-sync' WHERE op='managed-sync-parked' AND fingerprint=$1", [blockedKey]);
    }
    expect(other.status).not.toBe('blocked_by_failures');
    const status = await readSyncStatus(engine, f.id);
    expect(status.run_id).toBe(blockedRun);
    expect(status.cursor?.done).toBe(false);
    expect(status.last_error?.code).toBe('source_changed');
    expect(status.next?.argv).not.toContain('--exclude');
    expect(status.cursors).toHaveLength(2);
    expect(status.cursors.filter(cursor => cursor.shown).map(cursor => cursor.run_id)).toEqual([blockedRun]);
    expect(status.cursors.find(cursor => !cursor.shown)).toMatchObject({ done: true, last_error_code: null });
    expect(status.cursors.find(cursor => !cursor.shown)!.resume_argv).toContain('--exclude');
  } finally { await clearConfig(); }
}), 120_000);

test('the never-admitted legacy patterns match only with text where their ids stood', () => {
  const id = randomUUID(), other = randomUUID();
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `Its predecessor request ${id} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(true);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', 'Its predecessor request  was never admitted; this page was not published and is re-frozen on the next sync pass.'.replace('  ', ' '))).toBe(false);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `The first page of its group (request ${id}) was cancelled because its predecessor request ${other} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(true);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `The first page of its group (request ${id}) was cancelled because its predecessor request ${other} was never admitted; and more.`)).toBe(false);
  expect(legacyKnockOnMessage('cancelled', 'storage_error', `Its predecessor request ${id} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(false);
});
