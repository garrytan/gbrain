/**
 * apple-mail-hold-recovery — a held Mail thread import and a held unreadable message are recovered from COMPLETE evidence,
 * fairly and within bounds, end to end on PGLite with the synthetic Mail reader (no macOS, no Mail.app, no private data).
 *
 *  - a remembered thread (up to 100 messages) is read by id in bounded batches within one run and rendered once, whole;
 *    a partial read (a failed batch, a silently unresolved id, an abort) lands and clears nothing;
 *  - a thread too long for a list (or an unusable locator) is recovered by a whole-window recovery walk and its hold is
 *    cleared only when that walk completes;
 *  - the locator grows with the thread and never keeps a stale shorter list;
 *  - held re-attempts are exempt from the circuit breaker and rotate fairly, so every held record advances its
 *    reconsideration and backoff however many are held and however quiet the mailbox is;
 *  - the breaker still suppresses counting when fresh traffic looks like a Mail outage; Google keeps its behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { appleStateFile, readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { mailRelPath } from '../src/core/apple/render.ts';
import { APPLE_THREAD_REF_MAX, encodeThreadRef } from '../src/core/apple/mail-holds.ts';
import { AppleReaderError } from '../src/core/apple/readers/errors.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { ItemHoldsRun, HOLD_CAP, type ItemHoldRecord } from '../src/core/connectors/item-holds.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { AppleMailListing, AppleReaders } from '../src/core/apple/types.ts';
import { DAY, HOUR, NOW, OWNER, dayIso, fakeMail, mk, readersOf, type FakeMail } from './helpers/apple-mail-fake.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.executeRaw('DELETE FROM op_checkpoints').catch(() => undefined);
  clock.t = NOW;
});

const SID = 'amh';
const clock = { t: NOW };
// ── Harness ──────────────────────────────────────────────────────────────────

const logs: string[] = [];
const newDir = (): string => mkdtempSync(join(tmpdir(), 'amh-'));
const withHome = <T,>(fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
const baseRaw = (dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'mail', a_mail_days: 60, a_mail_owner_addresses: OWNER, ...extra });

async function insertSource(dir: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const raw = baseRaw(dir, extra);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`, [SID, dir, JSON.stringify(raw)]);
  return raw;
}
async function sweep(dir: string, f: FakeMail, raw: Record<string, unknown>, opts: Partial<SyncOpts> = {}) {
  const cfg = parseAppleSourceConfig(raw, dir);
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts },
    { readers: readersOf(f), now: () => clock.t, log: (m) => { logs.push(m); } });
}
const holdsOf = (dir: string): Record<string, ItemHoldRecord> => ((readAppleState(dir).item_holds ?? { items: {} }) as { items: Record<string, ItemHoldRecord> }).items;
const messageHolds = (dir: string): ItemHoldRecord[] => Object.values(holdsOf(dir)).filter((r) => r.key.startsWith('mail-message:'));
async function pages(): Promise<Array<{ slug: string; compiled_truth: string }>> {
  return engine.executeRaw(`SELECT slug, compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' IS NOT NULL ORDER BY slug`, [SID]);
}
async function pageOf(threadId: string): Promise<string | undefined> {
  const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = $2`, [SID, threadId]);
  return row?.compiled_truth;
}
function ctx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SID } as OperationContext;
}
const waiting = async (): Promise<any> => loopsOperations.find((o) => o.name === 'open_loops')!.handler(ctx(), { source_id: SID, group_by: 'counterparty', include_context: false });
const hasPage = async (needle: string): Promise<boolean> => (await pages()).some((p) => p.compiled_truth.includes(needle));

/** A clean baseline so Mail loop coverage starts complete (the poison arrives afterwards). */
async function baseline(dir: string, f: FakeMail, raw: Record<string, unknown>): Promise<void> {
  const r = await sweep(dir, f, raw);
  expect(r.status).not.toBe('partial');
  expect((await waiting()).completeness).toBe('complete');
}


// ── Helpers specific to thread recovery ──────────────────────────────────────

const threadMsgs = (tid: string, n: number, startDaysAgo: number): ReturnType<typeof mk>[] =>
  Array.from({ length: n }, (_, i) => mk(`<${tid}-${i}@x>`, tid, startDaysAgo, { date: new Date(Date.parse(dayIso(startDaysAgo)) + i * 60_000).toISOString() }));
const countIn = async (tid: string): Promise<number> => ((await pageOf(tid)) ?? '').split('Synthetic body of').length - 1;
const blockerOf = (dir: string, tid: string, msgs: ReturnType<typeof mk>[]): string => join(dir, `${mailRelPath({ threadId: tid, messages: msgs })}.tmp`);
const threadHold = (dir: string, tid: string): ItemHoldRecord | undefined => holdsOf(dir)[`mail:${tid}`];

/** A thread whose page import fails on every run (a directory sits where the temp file goes) until 3 runs hold it. */
async function heldThread(dir: string, raw: Record<string, unknown>, f: FakeMail, tid: string, msgs: ReturnType<typeof mk>[]): Promise<string> {
  const blocker = blockerOf(dir, tid, msgs);
  mkdirSync(blocker, { recursive: true });
  for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
  expect(threadHold(dir, tid)?.state).toBe('held');
  // The cursor moves on: the held thread is no longer in any incremental listing.
  f.box.push(mk('<later@x>', 'thr-later', 1));
  await sweep(dir, f, raw);
  await sweep(dir, f, raw);
  return blocker;
}

describe('Mail thread recovery — a remembered thread is rebuilt whole or not at all', () => {
  test('a 40-message held import is read by id in bounded batches of one run and lands as 40 messages (not a 25-message page)', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    expect(JSON.parse(threadHold(dir, 'thr-mid')!.ref!).m).toHaveLength(40);
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    f.byId.length = 0;
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(f.byId.map((b) => b.length)).toEqual([25, 15]);
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('partial recovery aborts: a batch that fails after the first lands nothing, counts nothing and keeps the retry request; the next run completes', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    rmSync(blocker, { recursive: true, force: true });
    const before = structuredClone(threadHold(dir, 'thr-mid')!);
    await retryHeld(engine, SID);
    f.byId.length = 0;
    f.failByIdAt = { call: 1, error: new Error('Mail helper hiccup') };
    const r = await sweep(dir, f, raw);
    expect(r.status).toBe('partial');
    expect(await pageOf('thr-mid')).toBeUndefined();
    const after = threadHold(dir, 'thr-mid')!;
    expect(after.state).toBe('held');
    expect([after.attempts, after.reconsiderations, after.next_attempt_at]).toEqual([before.attempts, before.reconsiderations, before.next_attempt_at]);
    expect(JSON.parse(after.ref!).m).toHaveLength(40);
    // The retry request survived the aborted run.
    f.failByIdAt = undefined; f.byId.length = 0;
    const again = await sweep(dir, f, raw);
    expect(again.status).not.toBe('partial');
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('an id the helper leaves unresolved (neither read, unreadable nor missing) blocks the whole thread; nothing lands until it resolves', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    f.dropById.add('<thr-mid-39@x>');
    await sweep(dir, f, raw);
    expect(await pageOf('thr-mid')).toBeUndefined();
    expect(threadHold(dir, 'thr-mid')?.state).toBe('held');
    expect((await waiting()).completeness).not.toBe('complete');
    f.dropById.clear();
    await sweep(dir, f, raw);
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('an abort between batches lands nothing and keeps the hold and the retry request', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    const ac = new AbortController();
    f.byId.length = 0;
    f.onById = (call) => { if (call === 1) ac.abort(); };
    const r = await sweep(dir, f, raw, { signal: ac.signal });
    expect(r.status).toBe('partial');
    expect(await pageOf('thr-mid')).toBeUndefined();
    expect(threadHold(dir, 'thr-mid')?.state).toBe('held');
    f.onById = undefined; f.byId.length = 0;
    await sweep(dir, f, raw);
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('a message of the thread that is proven unreadable is carried by its own hold: the page lands without it, coverage stays incomplete, and a later read completes the page', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    rmSync(blocker, { recursive: true, force: true });
    f.unreadable.add('<thr-mid-7@x>');
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).toBe('partial');
    expect(await countIn('thr-mid')).toBe(39);
    expect(await hasPage('Synthetic body of <thr-mid-7@x>.')).toBe(false);
    expect(messageHolds(dir).map((h) => [h.key, h.state])).toEqual([['mail-message:<thr-mid-7@x>', 'failing']]);
    expect((await waiting()).completeness).not.toBe('complete');
    // Three failed runs hold it; once Mail can read it again the page is whole and coverage completes.
    await sweep(dir, f, raw); await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]?.state).toBe('held');
    f.unreadable.clear();
    await retryHeld(engine, SID);
    await sweep(dir, f, raw);
    expect(await countIn('thr-mid')).toBe(40);
    expect(messageHolds(dir)).toHaveLength(0);
  }));
});

describe('Mail thread recovery — a thread too long for a list is recovered by a whole-window walk', () => {
  test('a 101-message held import is reached by retry-held and by the due backoff, and lands as 101 messages', () => withHome(async () => {
    for (const via of ['retry-held', 'backoff'] as const) {
      await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      const dir = newDir(); const raw = await insertSource(dir);
      const big = threadMsgs('thr-big', 101, 25);
      const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
      const blocker = await heldThread(dir, raw, f, 'thr-big', big);
      expect(JSON.parse(threadHold(dir, 'thr-big')!.ref!)).toEqual({ w: 101, o: big[0]!.date });
      rmSync(blocker, { recursive: true, force: true });
      if (via === 'retry-held') await retryHeld(engine, SID); else clock.t += 2 * HOUR;
      f.byId.length = 0; f.main.length = 0;
      const r = await sweep(dir, f, raw);
      expect(r.status).not.toBe('partial');
      expect(f.byId).toEqual([]);
      expect(Date.parse(f.main[0]!.since)).toBeLessThan(Date.parse(dayIso(25)));
      expect(await countIn('thr-big')).toBe(101);
      expect(threadHold(dir, 'thr-big')).toBeUndefined();
      expect(readAppleState(dir).mail.walk).toBeUndefined();
    }
  }));

  test('a capped recovery walk lands pages as it goes but clears the hold only when the walk completes; a partial thread is never settled', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir, { a_mail_max: 30 });
    const big = threadMsgs('thr-big', 101, 25);
    const f = fakeMail([...big, ...threadMsgs('thr-other', 20, 20)]);
    const blocker = blockerOf(dir, 'thr-big', big);
    mkdirSync(blocker, { recursive: true });
    // The import keeps failing: capped walks of the initial listing pin until the holds are made.
    for (let i = 0; i < 12 && threadHold(dir, 'thr-big')?.state !== 'held'; i++) await sweep(dir, f, raw);
    expect(threadHold(dir, 'thr-big')?.state).toBe('held');
    // Drain the initial capped walk so the cursor is at the end, then repair and retry.
    for (let i = 0; i < 8; i++) await sweep(dir, f, raw);
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    const counts: number[] = []; const states: Array<string | undefined> = [];
    for (let i = 0; i < 8; i++) {
      await sweep(dir, f, raw);
      counts.push(await countIn('thr-big'));
      states.push(threadHold(dir, 'thr-big')?.state);
      if (!threadHold(dir, 'thr-big')) break;
    }
    // Every intermediate run that left the hold in place had a page that was not (yet) the whole thread...
    const lastHeld = states.lastIndexOf('held');
    for (let i = 0; i <= lastHeld; i++) if (counts[i] === 101) expect(states[i]).toBe('held');
    // ...and the hold cleared exactly when the page was whole.
    expect(threadHold(dir, 'thr-big')).toBeUndefined();
    expect(await countIn('thr-big')).toBe(101);
    expect(readAppleState(dir).mail.walk).toBeUndefined();
  }));

  test('a growing thread never keeps a stale list: a 100-message locator becomes a walk locator at 101 and recovers all 101 (no partial rebuild)', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-big', 100, 25);
    const f = fakeMail([...msgs, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-big', msgs);
    expect(JSON.parse(threadHold(dir, 'thr-big')!.ref!).m).toHaveLength(100);
    // A new message of the held thread arrives: the listing sees it, the page is NOT built from it alone.
    f.box.push(mk('<thr-big-new@x>', 'thr-big', 0));
    await sweep(dir, f, raw);
    expect(await pageOf('thr-big')).toBeUndefined();
    expect(threadHold(dir, 'thr-big')?.state).toBe('held');
    expect(JSON.parse(threadHold(dir, 'thr-big')!.ref!)).toEqual({ w: 101, o: msgs[0]!.date });
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    await sweep(dir, f, raw);
    expect(await countIn('thr-big')).toBe(101);
    expect(threadHold(dir, 'thr-big')).toBeUndefined();
  }));

  test('a growing thread under the bound keeps every remembered message: the list is the union, and the rebuilt page has them all', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-mid', 30, 25);
    const f = fakeMail([...msgs, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', msgs);
    f.box.push(mk('<thr-mid-new1@x>', 'thr-mid', 0), mk('<thr-mid-new2@x>', 'thr-mid', 0, { date: new Date(clock.t).toISOString() }));
    await sweep(dir, f, raw);
    expect(await pageOf('thr-mid')).toBeUndefined();
    expect(JSON.parse(threadHold(dir, 'thr-mid')!.ref!).m).toHaveLength(32);
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    await sweep(dir, f, raw);
    expect(await countIn('thr-mid')).toBe(32);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('metadata failure: a locator with an unreadable entry, or a message hold without a usable date, is recovered by the walk instead of a partial rebuild', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-mid', 12, 25);
    const f = fakeMail([...msgs, mk('<a@x>', 'thr-a', 26), mk('<p@x>', 'thr-a', 23, { from: 'Bob Example <bob-example@example.com>' }), mk('<ok@x>', 'thr-ok', 24)]);
    f.unreadable.add('<p@x>');
    const blocker = await heldThread(dir, raw, f, 'thr-mid', msgs);
    rmSync(blocker, { recursive: true, force: true });
    f.unreadable.clear();
    // Corrupt the stored metadata: one date of the thread locator, and the date of the held message.
    const state = readAppleState(dir) as any;
    const ref = JSON.parse(state.item_holds.items['mail:thr-mid'].ref);
    ref.m[3][1] = 'not-a-date';
    state.item_holds.items['mail:thr-mid'].ref = JSON.stringify(ref);
    const pk = Object.keys(state.item_holds.items).find((k) => k.startsWith('mail-message:'));
    if (pk) state.item_holds.items[pk].meta.upstream_at = null;
    writeFileSync(appleStateFile(dir), JSON.stringify(state));
    await retryHeld(engine, SID);
    f.byId.length = 0; f.main.length = 0;
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(f.byId).toEqual([]);
    expect(Date.parse(f.main[0]!.since)).toBeLessThan(Date.parse(dayIso(25)));
    expect(await countIn('thr-mid')).toBe(12);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
    expect(await hasPage('Synthetic body of <p@x>.')).toBe(true);
    expect(messageHolds(dir)).toHaveLength(0);
  }));
  test('an oversize held thread that is gone upstream is dropped when the complete walk never sees it; one still there is not', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const gone = threadMsgs('thr-gone', 101, 25); const kept = threadMsgs('thr-kept', 101, 24);
    const f = fakeMail([...gone, ...kept, mk('<ok@x>', 'thr-ok', 23)]);
    const blockers = [blockerOf(dir, 'thr-gone', gone), blockerOf(dir, 'thr-kept', kept)];
    blockers.forEach((p) => mkdirSync(p, { recursive: true }));
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    f.box.push(mk('<later@x>', 'thr-later', 1));
    await sweep(dir, f, raw);
    f.box = f.box.filter((m) => m.threadId !== 'thr-gone');
    rmSync(blockers[1]!, { recursive: true, force: true });
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(threadHold(dir, 'thr-gone')).toBeUndefined();
    expect(threadHold(dir, 'thr-kept')).toBeUndefined();
    expect(await countIn('thr-kept')).toBe(101);
    expect(await pageOf('thr-gone')).toBeUndefined();
  }));

  test('a recovery walk never removes a page: a thread that is held and gone upstream keeps its landed page (only a --full walk deletes)', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const old = threadMsgs('thr-old', 5, 30);
    const f = fakeMail([...old, mk('<ok@x>', 'thr-ok', 23)]);
    await sweep(dir, f, raw); // landed
    expect(await countIn('thr-old')).toBe(5);
    // The thread grows past the list bound with recent messages; its re-import fails until it is held.
    const recent = Array.from({ length: 96 }, (_, i) => mk(`<thr-old-r${i}@x>`, 'thr-old', 1, { date: new Date(clock.t - 20 * HOUR + i * 60_000).toISOString() }));
    f.box.push(...recent);
    const blocker = blockerOf(dir, 'thr-old', old);
    mkdirSync(blocker, { recursive: true });
    // (a gap in loop coverage widens the second run to a whole-window re-read, which restarts the count once)
    for (let i = 0; i < 8 && threadHold(dir, 'thr-old')?.state !== 'held'; i++) await sweep(dir, f, raw);
    expect(threadHold(dir, 'thr-old')?.state).toBe('held');
    expect(JSON.parse(threadHold(dir, 'thr-old')!.ref!).w).toBeGreaterThanOrEqual(96);
    f.box = f.box.filter((m) => m.threadId !== 'thr-old');
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.deleted).toBe(0);
    expect(await countIn('thr-old')).toBe(5);
    expect(threadHold(dir, 'thr-old')).toBeUndefined(); // nothing left to rebuild
    const full = await sweep(dir, f, raw, { full: true });
    expect(full.deleted).toBe(1); // a --full walk is what judges deletions
  }));
});

describe('Mail hold recovery — fair, persisted progress for held retries', () => {
  const poisonBox = (n: number, healthy = 0): FakeMail => {
    const poison = Array.from({ length: n }, (_, i) => mk(`<p${i}@x>`, `thr-p${i}`, 29, { date: new Date(Date.parse(dayIso(29)) + i * 1000).toISOString(), from: 'Bob Example <bob-example@example.com>' }));
    const ok = Array.from({ length: healthy }, (_, i) => mk(`<h${i}@x>`, `thr-h${i}`, 28, { date: new Date(Date.parse(dayIso(28)) + i * 1000).toISOString() }));
    const f = fakeMail([...poison, ...ok, mk('<n@x>', 'thr-n', 1)]);
    poison.forEach((p) => f.unreadable.add(p.id));
    return f;
  };

  test('30 held messages over 12 quiet daily runs: every one is re-attempted, its reconsideration and backoff advance, none is starved, and the retries stop after the 7-day window', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = poisonBox(30, 150);
    for (let i = 0; i < 5; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir).filter((h) => h.state === 'held')).toHaveLength(30);
    const attempts = new Map<string, number>();
    const trace: number[] = [];
    for (let day = 1; day <= 12; day++) {
      clock.t += 25 * HOUR; f.byId.length = 0;
      await sweep(dir, f, raw);
      for (const t of f.byId.flat()) attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
      trace.push(Math.min(...messageHolds(dir).map((h) => h.reconsiderations)));
    }
    // All 30 were re-attempted, every day until the window closed, and their reconsiderations advanced together.
    expect(attempts.size + messageHolds(dir).filter((h) => h.next_attempt_at === null).length).toBeGreaterThanOrEqual(30);
    for (const h of messageHolds(dir)) {
      expect(h.state).toBe('held');
      expect(h.reconsiderations).toBeGreaterThanOrEqual(4);
      expect(h.next_attempt_at).toBeNull(); // 7-day window over: bounded, no infinite loop
    }
    expect(trace[0]).toBeGreaterThanOrEqual(1);
    // After the window the due path reads nothing by id any more.
    f.byId.length = 0; clock.t += 25 * HOUR;
    await sweep(dir, f, raw);
    expect(f.byId.flat()).toEqual([]);
  }));

  test('4, 5 and 6 held poison messages with a quiet mailbox no longer trip the breaker: reconsiderations and backoff advance every day', () => withHome(async () => {
    for (const n of [4, 5, 6]) {
      await resetPgliteState(engine); await engine.setConfig('version', schemaVersion); clock.t = NOW;
      const dir = newDir(); const raw = await insertSource(dir);
      const f = poisonBox(n, 20);
      for (let i = 0; i < 5; i++) await sweep(dir, f, raw);
      expect(messageHolds(dir).filter((h) => h.state === 'held')).toHaveLength(n);
      let previous = 0;
      for (let day = 1; day <= 3; day++) {
        clock.t += 25 * HOUR;
        await sweep(dir, f, raw);
        const recs = messageHolds(dir);
        expect(new Set(recs.map((h) => h.reconsiderations)).size).toBe(1);
        expect(recs[0]!.reconsiderations).toBeGreaterThan(previous);
        previous = recs[0]!.reconsiderations;
        expect(recs.every((h) => h.next_attempt_at !== null && Date.parse(h.next_attempt_at) > clock.t)).toBe(true);
      }
    }
  }));

  test('retry-held with the maximum 100 held messages re-reads them in bounded batches (at most 25 ids per call, 100 per run) with nothing starved', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = poisonBox(100, 300);
    for (let i = 0; i < 5; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir).filter((h) => h.state === 'held')).toHaveLength(100);
    await retryHeld(engine, SID);
    const seen = new Set<string>();
    const sizes: number[] = [];
    for (let run = 0; run < 3; run++) {
      f.byId.length = 0;
      await sweep(dir, f, raw);
      sizes.push(f.byId.flat().length);
      f.byId.flat().forEach((t) => seen.add(t.id));
      for (const b of f.byId) expect(b.length).toBeLessThanOrEqual(25);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(seen.size).toBe(100);
  }));

  test('two 80-message held threads do not fit one run: one is rebuilt per run, least recently attempted first, and neither starves', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const a = threadMsgs('thr-a', 80, 25); const b = threadMsgs('thr-b', 80, 24);
    const f = fakeMail([...a, ...b, mk('<ok@x>', 'thr-ok', 23)]);
    const blockers = [blockerOf(dir, 'thr-a', a), blockerOf(dir, 'thr-b', b)];
    blockers.forEach((p) => mkdirSync(p, { recursive: true }));
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect([threadHold(dir, 'thr-a')?.state, threadHold(dir, 'thr-b')?.state]).toEqual(['held', 'held']);
    f.box.push(mk('<later@x>', 'thr-later', 1));
    await sweep(dir, f, raw);
    blockers.forEach((p) => rmSync(p, { recursive: true, force: true }));
    await retryHeld(engine, SID);
    f.byId.length = 0; await sweep(dir, f, raw);
    expect(f.byId.flat().length).toBeLessThanOrEqual(100);
    const firstDone = [await countIn('thr-a'), await countIn('thr-b')].filter((c) => c === 80).length;
    expect(firstDone).toBe(1);
    expect([threadHold(dir, 'thr-a'), threadHold(dir, 'thr-b')].filter(Boolean)).toHaveLength(1);
    f.byId.length = 0; await sweep(dir, f, raw);
    expect([await countIn('thr-a'), await countIn('thr-b')]).toEqual([80, 80]);
    expect(Object.keys(holdsOf(dir))).toEqual([]);
  }));

  test('the breaker still protects against a Mail outage: fresh traffic that looks like one suppresses counting for held re-attempts too', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = poisonBox(6, 20);
    for (let i = 0; i < 5; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir).filter((h) => h.state === 'held')).toHaveLength(6);
    const before = messageHolds(dir).map((h) => h.reconsiderations);
    clock.t += 25 * HOUR;
    // Six fresh messages arrive and Mail cannot produce any body at all: the fresh group trips the breaker.
    for (let j = 0; j < 6; j++) f.box.push(mk(`<fresh${j}@x>`, `thr-fresh${j}`, 0, { date: new Date(clock.t - HOUR).toISOString() }));
    f.outage = true;
    await sweep(dir, f, raw);
    expect(messageHolds(dir).map((h) => h.reconsiderations)).toEqual(before);
    expect(messageHolds(dir).filter((h) => h.key.includes('fresh'))).toHaveLength(0);
    f.outage = false;
  }));
});

describe('Mail hold recovery — shared breaker neighbours', () => {
  const mixed = (groupOf?: (key: string, held: boolean) => string | null) => {
    const stored = { version: 1, items: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, { key: `k${i}`, state: 'held', code: 'x', class: 'transient', message: '', upstream_version: null,
      first_failed_at: dayIso(5), last_failed_at: dayIso(5), attempts: 3, held_at: dayIso(5), next_attempt_at: dayIso(4), reconsiderations: 0, meta: { sender: null, subject: null, title: null, upstream_at: null }, slug: null, request_id: null, ref: null, legacy: false }])) };
    const run = new ItemHoldsRun(stored, { now: () => NOW, ...(groupOf ? { groupOf } : {}) });
    for (let i = 0; i < 6; i++) { run.shouldAttempt(`k${i}`); run.fail(`k${i}`, new Error('socket hang up'), {}); }
    run.succeed('healthy');
    return run.finish();
  };
  test('default (Google/GitHub): six held re-attempts failing transiently are still an outage and count nothing', () => {
    const done = mixed();
    expect(done.outage).toBe(true);
    expect(Object.values(done.state.items).map((r) => r.reconsiderations)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  test('an exempt (null) group counts the held re-attempts, and a judged group in outage still suppresses them', () => {
    const exempt = mixed((_k, held) => (held ? null : 'fresh'));
    expect(exempt.outage).toBe(false);
    expect(Object.values(exempt.state.items).map((r) => r.reconsiderations)).toEqual([1, 1, 1, 1, 1, 1]);
    const run = new ItemHoldsRun(exempt.state, { now: () => NOW + HOUR * 30, groupOf: (_k, held) => (held ? null : 'fresh') });
    for (let i = 0; i < 6; i++) run.fail(`fresh${i}`, new Error('socket hang up'), {});
    for (let i = 0; i < 6; i++) { run.shouldAttempt(`k${i}`); run.fail(`k${i}`, new Error('socket hang up'), {}); }
    const done = run.finish();
    expect(done.outage).toBe(true);
    expect(Object.values(done.state.items).filter((r) => r.key.startsWith('k')).map((r) => r.reconsiderations)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Object.keys(done.state.items).filter((k) => k.startsWith('fresh'))).toEqual([]);
  });
});
