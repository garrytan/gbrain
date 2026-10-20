/**
 * apple-mail-hold-staging — resumable recovery of held Mail threads under a SLOW Mail.app, end to end on PGLite with the
 * synthetic reader (no macOS, no Mail.app, no private data).
 *
 * A slow Mail hands the helper only a few bodies per call (3 were observed) and always the OLDEST requested. The recovery
 * therefore accumulates what it really read, by message id, in bounded persistent staging (mail-recovery.ts) and renders the
 * thread (and clears its hold) only when every remembered message is accounted for:
 *  - a 40-message thread at 3 bodies per call lands as 40 messages across a bounded number of runs; a 4-message one in one run;
 *  - a small readable unit is not starved by an older larger one; units rotate by a persisted turn, never by a failure count;
 *  - a helper budget that resolves nothing ends the run's reads (one wasted call, not four) and counts nothing;
 *  - total staging is bounded across all holds (messages and bytes); overflow refuses to stage and loses nothing;
 *  - an abort or a malformed staging keeps the holds and the evidence safe; Mail text is never logged;
 *  - a whole-window recovery walk proves a >100-message thread only when its remembered oldest message is inside the window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { appleStateFile, normalizeAppleState, readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { mailRelPath } from '../src/core/apple/render.ts';
import { mergeThreadRef, parseThreadLocator, walkReaches } from '../src/core/apple/mail-holds.ts';
import { STAGE_MAX_BYTES, STAGE_MAX_MESSAGES, STAGE_TTL_MS, admit, emptyRecovery, normalizeMailRecovery, reconcileRecovery, stage, stagedBytes } from '../src/core/apple/mail-recovery.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import type { ItemHoldRecord } from '../src/core/connectors/item-holds.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { AppleMailRecoveryState, AppleReaders, AppleSourceState } from '../src/core/apple/types.ts';
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
  logs.length = 0;
  stats.calls = [];
});

const SID = 'amh';
const clock = { t: NOW };
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
async function pageOf(threadId: string): Promise<string | undefined> {
  const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = $2`, [SID, threadId]);
  return row?.compiled_truth;
}
function ctx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SID } as OperationContext;
}
const waiting = async (): Promise<any> => loopsOperations.find((o) => o.name === 'open_loops')!.handler(ctx(), { source_id: SID, group_by: 'counterparty', include_context: false });

const threadMsgs = (tid: string, n: number, startDaysAgo: number, body?: (i: number) => string): ReturnType<typeof mk>[] =>
  Array.from({ length: n }, (_, i) => mk(`<${tid}-${i}@x>`, tid, startDaysAgo, { date: new Date(Date.parse(dayIso(startDaysAgo)) + i * 60_000).toISOString(), ...(body ? { body: body(i) } : {}) }));
const countIn = async (tid: string): Promise<number> => ((await pageOf(tid)) ?? '').split('Synthetic body of').length - 1;
const blockerOf = (dir: string, tid: string, msgs: ReturnType<typeof mk>[]): string => join(dir, `${mailRelPath({ threadId: tid, messages: msgs })}.tmp`);
const threadHold = (dir: string, tid: string): ItemHoldRecord | undefined => holdsOf(dir)[`mail:${tid}`];
const recoveryOf = (dir: string): AppleMailRecoveryState | undefined => readAppleState(dir).mail_recovery;

/** Fail the page import of every given thread on every run (a directory sits where the temp file goes) until 3 runs hold them. */
async function holdThreads(dir: string, raw: Record<string, unknown>, f: FakeMail, threads: Array<{ tid: string; msgs: ReturnType<typeof mk>[] }>): Promise<string[]> {
  const blockers = threads.map((t) => blockerOf(dir, t.tid, t.msgs));
  blockers.forEach((b) => mkdirSync(b, { recursive: true }));
  for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
  for (const t of threads) expect(threadHold(dir, t.tid)?.state).toBe('held');
  // The cursor moves on: the held threads are no longer in any incremental listing.
  f.box.push(mk('<later@x>', 'thr-later', 1));
  await sweep(dir, f, raw);
  await sweep(dir, f, raw);
  return blockers;
}

async function heldThread(dir: string, raw: Record<string, unknown>, f: FakeMail, tid: string, msgs: ReturnType<typeof mk>[]): Promise<string> {
  return (await holdThreads(dir, raw, f, [{ tid, msgs }]))[0]!;
}

// Slow Mail: a targeted helper call resolves only the OLDEST `perCall` requested targets (date,id order, like mail.js); the
// rest are silently unresolved (truncated + budgetExhausted). `stall.on` resolves nothing at all.
const stats = { calls: [] as Array<{ asked: string[]; resolved: string[]; stalled: boolean }> };
const stall = { on: false, throwOnCall: null as number | null };
function slowReaders(f: FakeMail, perCall: number): AppleReaders {
  const base = readersOf(f);
  return { ...base, async mailMessages(opts) {
    const asked = opts.targets.map((t) => t.id);
    const idx = stats.calls.length;
    if (stall.throwOnCall === idx) { stats.calls.push({ asked, resolved: [], stalled: true }); throw new Error('synthetic helper failure'); }
    if (stall.on) { stats.calls.push({ asked, resolved: [], stalled: true }); return { messages: [], truncated: true, budgetExhausted: true }; }
    const sorted = [...opts.targets].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const take = sorted.slice(0, perCall);
    const res = await base.mailMessages!({ ...opts, targets: take });
    stats.calls.push({ asked, resolved: take.map((t) => t.id), stalled: false });
    return { ...res, truncated: sorted.length > perCall, budgetExhausted: sorted.length > perCall };
  } };
}
async function slowSweep(dir: string, f: FakeMail, raw: Record<string, unknown>, perCall: number, opts: Partial<SyncOpts> = {}) {
  const cfg = parseAppleSourceConfig(raw, dir);
  stats.calls = [];
  clock.t += HOUR;
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts },
    { readers: slowReaders(f, perCall), now: () => clock.t, log: (m) => { logs.push(m); } });
}
const stagedIds = (dir: string): string[] => Object.keys(recoveryOf(dir)?.staged ?? {});

describe('Mail hold recovery under slow Mail — evidence accumulates across runs', () => {
  test('a 40-message held thread at 3 bodies per helper call lands as 40 messages across bounded runs; nothing partial lands, nothing is counted', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-mid', big), { recursive: true, force: true });
    await retryHeld(engine, SID);
    const before = threadHold(dir, 'thr-mid')!;
    const resolvedOnce = new Map<string, number>();
    let landedRun = 0;
    for (let run = 1; run <= 6 && landedRun === 0; run++) {
      const r = await slowSweep(dir, f, raw, 3);
      expect(stats.calls.length).toBeLessThanOrEqual(4);
      for (const c of stats.calls) { expect(c.asked.length).toBeLessThanOrEqual(25); for (const id of c.resolved) resolvedOnce.set(id, (resolvedOnce.get(id) ?? 0) + 1); }
      if (await countIn('thr-mid') === 40) { landedRun = run; break; }
      // Partial: the page is NOT built from partial evidence, the hold is untouched (no failure, no backoff move), the answer is not complete.
      expect(await pageOf('thr-mid')).toBeUndefined();
      const h = threadHold(dir, 'thr-mid')!;
      expect(h.state).toBe('held');
      expect([h.attempts, h.reconsiderations, h.last_failed_at, h.next_attempt_at]).toEqual([before.attempts, before.reconsiderations, before.last_failed_at, before.next_attempt_at]);
      expect((await waiting()).completeness).not.toBe('complete');
      expect(stagedIds(dir).length).toBeLessThanOrEqual(STAGE_MAX_MESSAGES);
      expect(r.status).toBeDefined();
    }
    expect(landedRun).toBeGreaterThan(0);
    expect(landedRun).toBeLessThanOrEqual(5);
    expect(await countIn('thr-mid')).toBe(40);
    // Every message was read exactly once (nothing was re-asked after it was resolved).
    expect([...resolvedOnce.values()].every((n) => n === 1)).toBe(true);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
    expect(recoveryOf(dir)).toBeUndefined();
    expect((await waiting()).completeness).toBe('complete');
    expect(logs.some((l) => l.includes('Synthetic body'))).toBe(false);
  }));

  test('a 4-message held thread completes in ONE run (the follow-up call asks only for what is left)', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-four', 4, 25);
    const f = fakeMail([...msgs, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-four', msgs), { recursive: true, force: true });
    await retryHeld(engine, SID);
    await slowSweep(dir, f, raw, 3);
    expect(stats.calls.map((c) => [c.asked.length, c.resolved.length])).toEqual([[4, 3], [1, 1]]);
    expect(await countIn('thr-four')).toBe(4);
    expect(threadHold(dir, 'thr-four')).toBeUndefined();
    expect(recoveryOf(dir)).toBeUndefined();
  }));

  test('small readable units are not starved by a stalled larger one: they finish in the first run while the large one still progresses', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 6, 25);
    const singles = Array.from({ length: 2 }, (_, i) => mk(`<s${i}@x>`, `thr-s${i}`, 10 - i));
    const f = fakeMail([...big, ...singles, mk('<ok@x>', 'thr-ok', 24)]);
    for (const s of singles) f.unreadable.add(s.id);
    const blocker = blockerOf(dir, 'thr-mid', big);
    mkdirSync(blocker, { recursive: true });
    for (let i = 0; i < 4; i++) await sweep(dir, f, raw);
    expect(Object.values(holdsOf(dir)).filter((r) => r.state === 'held').map((r) => r.key).sort()).toEqual(['mail-message:<s0@x>', 'mail-message:<s1@x>', 'mail:thr-mid']);
    f.box.push(mk('<later@x>', 'thr-later', 1)); await sweep(dir, f, raw); await sweep(dir, f, raw);
    f.unreadable.clear(); rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    await slowSweep(dir, f, raw, 3);
    expect(holdsOf(dir)['mail-message:<s0@x>']).toBeUndefined();
    expect(holdsOf(dir)['mail-message:<s1@x>']).toBeUndefined();
    expect(await pageOf('thr-s0')).toContain('Synthetic body of <s0@x>');
    expect(await pageOf('thr-s1')).toContain('Synthetic body of <s1@x>');
    expect(await countIn('thr-mid')).toBe(6);
  }));

  test('the rotation is a persisted turn: of two 40-message threads at 3 per call, neither starves and the one worked on yields to the other', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const a = threadMsgs('thr-a', 40, 25); const b = threadMsgs('thr-b', 40, 24);
    const f = fakeMail([...a, ...b, mk('<ok@x>', 'thr-ok', 23)]);
    const blockers = await holdThreads(dir, raw, f, [{ tid: 'thr-a', msgs: a }, { tid: 'thr-b', msgs: b }]);
    blockers.forEach((p) => rmSync(p, { recursive: true, force: true }));
    await retryHeld(engine, SID);
    const doneAt: Record<string, number> = {};
    for (let run = 1; run <= 12; run++) {
      await slowSweep(dir, f, raw, 3);
      for (const t of ['thr-a', 'thr-b']) if (!(t in doneAt) && await countIn(t) === 40) doneAt[t] = run;
      const rec = recoveryOf(dir);
      if (rec) expect(stagedIds(dir).length).toBeLessThanOrEqual(STAGE_MAX_MESSAGES);
      for (const key of ['mail:thr-a', 'mail:thr-b']) { const h = holdsOf(dir)[key]; if (h) expect([h.attempts, h.reconsiderations]).toEqual([3, 0]); }
      if (Object.keys(doneAt).length === 2) break;
    }
    expect(Object.keys(doneAt).sort()).toEqual(['thr-a', 'thr-b']);
    expect(Math.max(...Object.values(doneAt))).toBeLessThanOrEqual(8);
    expect(Object.keys(holdsOf(dir))).toEqual([]);
    expect(recoveryOf(dir)).toBeUndefined();
  }));

  test('a stalled helper budget (nothing resolved) ends the run\'s reads after ONE call, counts nothing, and keeps what was staged earlier', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-mid', big), { recursive: true, force: true });
    await retryHeld(engine, SID);
    await slowSweep(dir, f, raw, 3);
    const staged = stagedIds(dir).sort();
    expect(staged.length).toBeGreaterThanOrEqual(3);
    const before = threadHold(dir, 'thr-mid')!;
    stall.on = true;
    try {
      for (let i = 0; i < 3; i++) {
        const r = await slowSweep(dir, f, raw, 3);
        expect(stats.calls).toHaveLength(1);
        expect(r.status).not.toBe('first_sync');
        expect(stagedIds(dir).sort()).toEqual(staged);
        const h = threadHold(dir, 'thr-mid')!;
        expect([h.state, h.attempts, h.reconsiderations, h.next_attempt_at]).toEqual(['held', before.attempts, before.reconsiderations, before.next_attempt_at]);
      }
    } finally { stall.on = false; }
    // Mail recovers: the run resumes from what was staged and finishes.
    for (let i = 0; i < 6 && !(await countIn('thr-mid')); i++) await slowSweep(dir, f, raw, 3);
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
  }));

  test('a failing targeted call is a source problem: nothing counted, earlier progress kept, the next ask is smaller', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-mid', big), { recursive: true, force: true });
    await retryHeld(engine, SID);
    const before = threadHold(dir, 'thr-mid')!;
    stall.throwOnCall = 1;
    try { await slowSweep(dir, f, raw, 3); } finally { stall.throwOnCall = null; }
    expect(stats.calls).toHaveLength(2);
    expect(stagedIds(dir)).toHaveLength(3);
    const h = threadHold(dir, 'thr-mid')!;
    expect([h.state, h.attempts, h.reconsiderations]).toEqual(['held', before.attempts, before.reconsiderations]);
    expect(recoveryOf(dir)!.capacity).toBeLessThan(25);
    for (let i = 0; i < 6 && !(await countIn('thr-mid')); i++) await slowSweep(dir, f, raw, 3);
    expect(await countIn('thr-mid')).toBe(40);
  }));
});

describe('Mail hold recovery staging — bounded across every hold, safe on overflow', () => {
  test('three held 60-message threads at 3 per call: staging never exceeds the total message or byte bound, overflow refuses admission and loses nothing, every thread lands whole', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const threads = Array.from({ length: 3 }, (_, i) => ({ tid: `thr-${i}`, msgs: threadMsgs(`thr-${i}`, 60, 25 - i, () => 'x'.repeat(9000) + ' Synthetic body of') }));
    const f = fakeMail([...threads.flatMap((t) => t.msgs), mk('<ok@x>', 'thr-ok', 12)]);
    const blockers = await holdThreads(dir, raw, f, threads);
    blockers.forEach((p) => rmSync(p, { recursive: true, force: true }));
    await retryHeld(engine, SID);
    const landed = new Set<string>();
    let peakMessages = 0; let peakBytes = 0; let peakUnits = 0; let runs = 0;
    for (; runs < 120 && landed.size < 3; runs++) {
      await slowSweep(dir, f, raw, 3);
      const rec = recoveryOf(dir);
      if (rec) {
        peakMessages = Math.max(peakMessages, Object.keys(rec.staged).length);
        peakBytes = Math.max(peakBytes, stagedBytes(rec));
        peakUnits = Math.max(peakUnits, Object.keys(rec.units).length);
        for (const id of Object.keys(rec.staged)) expect(Object.keys(rec.units).some((k) => threads.some((t) => `mail:${t.tid}` === k && t.msgs.some((m) => m.id === id)))).toBe(true);
      }
      for (const t of threads) { const n = (await pageOf(t.tid))?.split('Synthetic body of').length; if (n !== undefined && !landed.has(t.tid)) { expect(n - 1).toBe(60); landed.add(t.tid); } }
    }
    expect(landed.size).toBe(3);
    expect(peakMessages).toBeLessThanOrEqual(STAGE_MAX_MESSAGES);
    expect(peakBytes).toBeLessThanOrEqual(STAGE_MAX_BYTES);
    expect(peakUnits).toBe(1); // 3 x 60 > the bound: one thread at a time is admitted, the others wait their turn
    expect(Object.keys(holdsOf(dir))).toEqual([]);
    expect(recoveryOf(dir)).toBeUndefined();
  }), 120_000);

  test('stage() refuses at the message bound and at the byte bound, never evicts, and admit() reserves whole threads', () => {
    const rec = emptyRecovery();
    expect(admit(rec, 'mail:a', 60, dayIso(0))).toBe(true);
    expect(admit(rec, 'mail:b', 50, dayIso(0))).toBe(false); // 110 > STAGE_MAX_MESSAGES
    expect(admit(rec, 'mail:b', 40, dayIso(0))).toBe(true);
    const m = (i: number, body = 'b') => ({ ...mk(`<m${i}@x>`, 'thr', 1), body });
    for (let i = 0; i < STAGE_MAX_MESSAGES; i++) expect(stage(rec, m(i), dayIso(0))).toBe(true);
    expect(stage(rec, m(9999), dayIso(0))).toBe(false);
    expect(Object.keys(rec.staged)).toHaveLength(STAGE_MAX_MESSAGES);
    expect(rec.staged['<m0@x>']).toBeDefined(); // nothing evicted
    const big = emptyRecovery();
    const huge = 'y'.repeat(800_000);
    expect(stage(big, m(1, huge), dayIso(0))).toBe(true);
    expect(stage(big, m(2, huge), dayIso(0))).toBe(true);
    expect(stage(big, m(3, huge), dayIso(0))).toBe(true);
    expect(stage(big, m(4, huge), dayIso(0))).toBe(false);
    expect(stagedBytes(big)).toBeLessThanOrEqual(STAGE_MAX_BYTES);
  });

  test('a stored staging is read back defensively: malformed entries are dropped, an over-bound one whole; reconcile drops the orphaned and the expired', () => {
    const good = { at: dayIso(0), m: mk('<g@x>', 'thr', 1) };
    const rec = normalizeMailRecovery({ version: 1, turn: 3, units: { 'mail:t': { turn: 1, n: 2 }, bad: 7 }, staged: { '<g@x>': good, '<b@x>': { at: 'nope', m: {} }, '<c@x>': { at: dayIso(0), m: { ...mk('<d@x>', 'thr', 1) } } }, gone: { '<x@x>': dayIso(0), '<y@x>': 5 } })!;
    expect(Object.keys(rec.staged)).toEqual(['<g@x>']);
    expect(Object.keys(rec.units)).toEqual(['mail:t']);
    expect(Object.keys(rec.gone)).toEqual(['<x@x>']);
    expect(normalizeMailRecovery({ version: 2 })).toBeUndefined();
    const overflow = { version: 1, turn: 0, units: {}, staged: Object.fromEntries(Array.from({ length: STAGE_MAX_MESSAGES + 1 }, (_, i) => [`<m${i}@x>`, { at: dayIso(0), m: mk(`<m${i}@x>`, 'thr', 1) }])), gone: {} };
    expect(normalizeMailRecovery(overflow)).toBeUndefined();

    const state = { ...normalizeAppleState({}), mail_recovery: structuredClone(rec) } as AppleSourceState;
    state.mail_recovery!.units['mail:orphan'] = { turn: 0, n: 1 };
    state.mail_recovery!.staged['<old@x>'] = { at: new Date(NOW - STAGE_TTL_MS - HOUR).toISOString(), m: mk('<old@x>', 'thr', 1) };
    reconcileRecovery(state, new Map([['mail:t', [{ id: '<g@x>', date: dayIso(1) }, { id: '<old@x>', date: dayIso(1) }]]]), NOW);
    expect(Object.keys(state.mail_recovery!.units)).toEqual(['mail:t']);
    expect(Object.keys(state.mail_recovery!.staged)).toEqual(['<g@x>']); // '<old@x>' expired
    reconcileRecovery(state, new Map(), NOW);
    expect(state.mail_recovery).toBeUndefined(); // the hold is gone: its mail text is gone with it
  });

  test('a corrupt staging in the state file is dropped; the hold stays and the recovery restarts from the helper', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-mid', big), { recursive: true, force: true });
    await retryHeld(engine, SID);
    await slowSweep(dir, f, raw, 3);
    expect(stagedIds(dir).length).toBeGreaterThan(0);
    const file = appleStateFile(dir);
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    state.mail_recovery = { version: 1, turn: 'x', units: 4, staged: { '<thr-mid-0@x>': { at: 'garbage', m: 7 } }, gone: [] };
    writeFileSync(file, JSON.stringify(state));
    expect(recoveryOf(dir)).toBeUndefined();
    expect(threadHold(dir, 'thr-mid')?.state).toBe('held');
    for (let i = 0; i < 8 && !(await countIn('thr-mid')); i++) await slowSweep(dir, f, raw, 3);
    expect(await countIn('thr-mid')).toBe(40);
  }));
});

describe('Mail hold recovery staging — abort and restart keep the holds safe', () => {
  test('an abort during the second helper call lands nothing and clears nothing; the restart completes', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 40, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    rmSync(await heldThread(dir, raw, f, 'thr-mid', big), { recursive: true, force: true });
    await retryHeld(engine, SID);
    const before = threadHold(dir, 'thr-mid')!;
    const ac = new AbortController();
    const cfg = parseAppleSourceConfig(raw, dir);
    const base = slowReaders(f, 3);
    let n = 0;
    const readers: AppleReaders = { ...base, async mailMessages(opts) { if (n++ === 1) { ac.abort(); throw new DOMException('aborted', 'AbortError'); } return base.mailMessages!(opts); } };
    clock.t += HOUR;
    await runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, signal: ac.signal }, { readers, now: () => clock.t, log: (m) => { logs.push(m); } }).catch(() => undefined);
    expect(await pageOf('thr-mid')).toBeUndefined();
    const h = threadHold(dir, 'thr-mid')!;
    expect([h.state, h.attempts, h.reconsiderations, h.next_attempt_at]).toEqual(['held', before.attempts, before.reconsiderations, before.next_attempt_at]);
    expect((await waiting()).completeness).not.toBe('complete');
    for (let i = 0; i < 8 && !(await countIn('thr-mid')); i++) await slowSweep(dir, f, raw, 3);
    expect(await countIn('thr-mid')).toBe(40);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
    expect(recoveryOf(dir)).toBeUndefined();
  }));

  test('staged evidence survives a failed landing: the next run lands from the stage with no helper call; the hold clears only when the page lands', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = threadMsgs('thr-mid', 4, 25);
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-mid', big);
    await retryHeld(engine, SID);
    // The thread is read completely, but its page still cannot be written (the blocker stays): hold stays, evidence stays staged.
    await slowSweep(dir, f, raw, 3);
    expect(await pageOf('thr-mid')).toBeUndefined();
    expect(threadHold(dir, 'thr-mid')?.state).toBe('held');
    expect(stagedIds(dir).sort()).toEqual(big.map((m) => m.id).sort());
    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    clock.t += 30 * HOUR;
    await slowSweep(dir, f, raw, 3);
    expect(stats.calls).toHaveLength(0); // nothing left to read
    expect(await countIn('thr-mid')).toBe(4);
    expect(threadHold(dir, 'thr-mid')).toBeUndefined();
    expect(recoveryOf(dir)).toBeUndefined();
  }));
});

describe('Mail hold recovery — a whole-window walk proves a thread only when the window reaches all of it', () => {
  const agedThread = async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const big = Array.from({ length: 101 }, (_, i) => mk(`<thr-big-${i}@x>`, 'thr-big', 45, { date: new Date(Date.parse(dayIso(45)) + i * 3_600_000).toISOString() }));
    const f = fakeMail([...big, mk('<ok@x>', 'thr-ok', 24)]);
    const blocker = await heldThread(dir, raw, f, 'thr-big', big);
    rmSync(blocker, { recursive: true, force: true });
    return { dir, raw, f, big };
  };

  test('the locator remembers the oldest message it knew', () => {
    const msgs = Array.from({ length: 101 }, (_, i) => ({ id: `<m${i}@x>`, date: new Date(Date.parse(dayIso(45)) + i * 3_600_000).toISOString() }));
    const ref = mergeThreadRef(undefined, msgs);
    expect(parseThreadLocator(ref)).toMatchObject({ walk: true, size: 101, oldest: dayIso(45) });
    // A later view with only newer messages (and a page whose first message is older) never invents a newer boundary.
    expect(parseThreadLocator(mergeThreadRef({ ref }, msgs.slice(50)))).toMatchObject({ walk: true, size: 101, oldest: dayIso(45) });
    expect(parseThreadLocator(mergeThreadRef(undefined, msgs, dayIso(50)))).toMatchObject({ oldest: dayIso(50) });
    // A locator that never knew a boundary stays unknown: a boundary is not made up from a partial view.
    expect(parseThreadLocator(mergeThreadRef({ ref: JSON.stringify({ w: 101 }) }, msgs.slice(50))).oldest).toBeUndefined();
    expect(walkReaches(parseThreadLocator(ref), new Date(NOW - 60 * DAY))).toBe('yes');
    expect(walkReaches(parseThreadLocator(ref), new Date(NOW - 30 * DAY))).toBe('no');
    expect(walkReaches(parseThreadLocator(JSON.stringify({ w: 101 })), new Date(0))).toBe('unknown');
  });

  test('101 -> 42: when the oldest messages age out of the mail window the hold, the thread and the coverage gap stay; no partial page lands; no futile walks', () => withHome(async () => {
    const { dir, raw, f } = await agedThread();
    clock.t += 17 * DAY; // the oldest ~48 messages are now older than 60 days
    await retryHeld(engine, SID);
    for (let i = 0; i < 4; i++) {
      f.main.length = 0;
      clock.t += HOUR;
      await sweep(dir, f, raw);
      expect(await pageOf('thr-big')).toBeUndefined();
      expect(threadHold(dir, 'thr-big')?.state).toBe('held');
      expect((await waiting()).completeness).not.toBe('complete');
    }
    expect(logs.some((l) => l.includes('older than the mail window'))).toBe(true);
    // No whole-window walk was begun for a thread the window cannot reach.
    expect(readAppleState(dir).mail.walk?.recover).toBeUndefined();
  }));

  test('widening the mail window (the user\'s call) makes the thread reachable again: the walk then lands all 101 and clears the hold', () => withHome(async () => {
    const { dir, raw, f } = await agedThread();
    clock.t += 17 * DAY;
    await retryHeld(engine, SID);
    await sweep(dir, f, raw);
    expect(threadHold(dir, 'thr-big')?.state).toBe('held');
    const wide = { ...raw, a_mail_days: 120 };
    await engine.executeRaw(`UPDATE sources SET config = $2::text::jsonb WHERE id = $1`, [SID, JSON.stringify(wide)]);
    for (let i = 0; i < 4 && threadHold(dir, 'thr-big'); i++) { clock.t += HOUR; await sweep(dir, f, wide); }
    expect(await countIn('thr-big')).toBe(101);
    expect(threadHold(dir, 'thr-big')).toBeUndefined();
  }));

  test('a window that still reaches the whole thread lands all 101 (the boundary changes nothing when it is inside the window)', () => withHome(async () => {
    const { dir, raw, f } = await agedThread();
    await retryHeld(engine, SID);
    for (let i = 0; i < 4 && threadHold(dir, 'thr-big'); i++) { clock.t += HOUR; await sweep(dir, f, raw); }
    expect(await countIn('thr-big')).toBe(101);
    expect(threadHold(dir, 'thr-big')).toBeUndefined();
  }));

  test('a locator without a boundary (written before it was remembered) is trusted only by what the walk finds: fewer than it stands for never lands or clears', () => withHome(async () => {
    const { dir, raw, f } = await agedThread();
    // Rewrite the stored locator the way an older build wrote it: the count, no boundary.
    const file = appleStateFile(dir);
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    state.item_holds.items['mail:thr-big'].ref = JSON.stringify({ w: 101 });
    writeFileSync(file, JSON.stringify(state));
    clock.t += 17 * DAY;
    await retryHeld(engine, SID);
    for (let i = 0; i < 4; i++) { clock.t += HOUR; await sweep(dir, f, raw); }
    expect(await pageOf('thr-big')).toBeUndefined();
    expect(threadHold(dir, 'thr-big')?.state).toBe('held');
    expect(parseThreadLocator(threadHold(dir, 'thr-big')!.ref).oldest).toBeUndefined();
    expect((await waiting()).completeness).not.toBe('complete');
  }));
});
