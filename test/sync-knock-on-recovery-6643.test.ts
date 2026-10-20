/**
 * #6643: managed sync recovers from its own knock-ons; #6712 (one page, one fate) retired every producer.
 *
 * Protects: the retired `knock_on_exhausted` code renders superseded; the pre-#6643 producer messages are recognised,
 * nothing else is; the checkpoint waits on every receipt the cursor did not settle (no knock-on exemption); the cursor
 * fence's two causes; the never-admitted legacy patterns.
 * #6712 PR 4b: a non-company source keeps no cursor to re-freeze, rediscover or show in sync status, so the cursor-run
 * tests went; a page that failed in one pass and is imported by the next plain sync (and its --retry-failed alias) is
 * covered by sync-pass-failure-retry-6712.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { laneFaultCancelMessage, WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { BULK_GROUP_CANCEL_MESSAGE, EARLIER_PAGE_REFUSAL_MESSAGE, isSyncKnockOn, knockOnDetail, LEGACY_KNOCK_ON_CANCEL_MESSAGES, legacyKnockOnMessage,
  syncKnockOnSql } from '../src/core/persistence/sync-knock-on.ts';
import { CODES } from '../src/core/error-registry.ts';
import { addSettledRange, findIncompleteSyncReceipt } from '../src/core/persistence/checkpoint-validation.ts';
import { cursorFenceRefusal } from '../src/core/persistence/sync-prepare.ts';
import { publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6643-'));
let engine: PGLiteEngine;
const page = (kind: string) => ({ kind });

/** A claimed source and one failed import receipt of a sync run (run `runId`, index 1) on its worktree. */
async function failedReceipt() {
  const id = `ko-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  const binding = await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const runId = randomUUID(), stopped = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,worktree_id,slug,digest,authority,intent_bytes,
      terminal_reservation,state,error_code,error_message,intent,completed_at,updated_at,admitter_version)
    VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,(SELECT incarnation FROM sources WHERE id=$2),$3::uuid,'b',$4,'{}'::jsonb,0,0,'failed','source_changed',
      'The file changed after it was frozen.',$5::text::jsonb,now(),now(),'0.60.262.0')`,
    [stopped, id, binding.worktree_id, randomUUID(), JSON.stringify({ kind: 'managed_sync_import', runId, index: 1 })]);
  return { worktreeId: binding.worktree_id, runId, stopped, rootRequest: randomUUID() };
}
/** Rewrites the stopped request into the receipt a knock-on producer writes. */
async function asKnockOn(requestId: string, message: string, detail: unknown, state = 'cancelled', code = 'cancelled') {
  await engine.executeRaw(`UPDATE persistence_requests SET state=$2, error_code=$3, error_message=$4, error_detail=$5::jsonb, recovery=NULL, publication_started=false
    WHERE request_id=$1::uuid`, [requestId, state, code, message, detail == null ? null : JSON.stringify(detail)]);
}

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

test('the checkpoint waits on every receipt the cursor did not settle, a legacy knock-on included (#6712), and skips the indexes a cursor settled', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const f = await failedReceipt();
  const check = (settled: Parameters<typeof findIncompleteSyncReceipt>[4]) => findIncompleteSyncReceipt(engine, f.worktreeId, f.runId, [], settled);
  // A real failure (no knock-on marker, no matching message) blocks under every cursor shape.
  expect(await check(null)).toBe(f.stopped);
  expect(await check({ from: 0, ranges: [] })).toBe(f.stopped);
  await asKnockOn(f.stopped, WINDOW_CANCEL_MESSAGE, knockOnDetail('window_predecessor', f.rootRequest));
  // #6712: no knock-on exemption: a legacy knock-on blocks unless the cursor settled its index or converted it.
  expect(await check(null)).toBe(f.stopped);
  expect(await findIncompleteSyncReceipt(engine, f.worktreeId, f.runId, [f.stopped], null)).toBeNull();
  expect(await check({ from: 0, ranges: [] })).toBe(f.stopped);
  expect(await check({ from: 0, ranges: [[1, 1]] })).toBeNull();
  expect(addSettledRange(addSettledRange({ from: 0, ranges: [] }, 1, 2), 3, 4)).toEqual({ from: 0, ranges: [[1, 4]] });
  expect(addSettledRange({ from: 0, ranges: [[1, 2]] }, 5, 5)).toEqual({ from: 0, ranges: [[1, 2], [5, 5]] });
}));

test('#6712: the cursor fence has two causes; a request the cursor does not hold is outside_fence, even one an older cursor recorded dropping', () => {
  expect(publicFailureDetail({ origin: 'sync_cursor_fence', cause: 'outside_fence', fence: { index: 3 } })).toMatchObject({ cause: 'outside_fence' });
  expect(publicFailureDetail({ origin: 'sync_cursor_fence', cause: 'anything else' })).not.toHaveProperty('cause');
  const run = randomUUID(), root = randomUUID(), member = randomUUID(), now = randomUUID();
  const row = (id: string) => ({ request_id: id, source_id: 'default' }) as never;
  const intent = { kind: 'managed_sync_import', runId: run, index: 7 } as never;
  const fence = { run_id: run, request_id: now, group: null, index: 3, dropped: [{ requestId: member, root }] };
  const detail = (id: string, f: typeof fence) => cursorFenceRefusal(row(id), intent, f).syncRefusal as Record<string, unknown>;
  expect(detail(member, fence)).toMatchObject({ cause: 'outside_fence', origin: 'sync_cursor_fence' });
  expect(detail(member, fence)).not.toHaveProperty('root_request_id');
  expect(detail(member, { ...fence, run_id: randomUUID() })).toMatchObject({ cause: 'run_replaced' });
});

test('the never-admitted legacy patterns match only with text where their ids stood', () => {
  const id = randomUUID(), other = randomUUID();
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `Its predecessor request ${id} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(true);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', 'Its predecessor request  was never admitted; this page was not published and is re-frozen on the next sync pass.'.replace('  ', ' '))).toBe(false);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `The first page of its group (request ${id}) was cancelled because its predecessor request ${other} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(true);
  expect(legacyKnockOnMessage('cancelled', 'cancelled', `The first page of its group (request ${id}) was cancelled because its predecessor request ${other} was never admitted; and more.`)).toBe(false);
  expect(legacyKnockOnMessage('cancelled', 'storage_error', `Its predecessor request ${id} was never admitted; this page was not published and is re-frozen on the next sync pass.`)).toBe(false);
});
