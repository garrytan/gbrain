/**
 * apple-mail-holds — poison-message recovery for the Apple Mail sweep, end to end on PGLite with an injected synthetic
 * Mail reader (no macOS, no Mail.app, no private data; placeholders only).
 *
 * The contract under test is the Google connector's hold contract applied to Mail messages:
 *  - a message the reader PROVES unreadable counts as a failed run; runs 1-3 pin the cursor and healthy siblings import;
 *  - after the third failed run it is held, and a run that starts with the hold excludes it, so the cursor and later
 *    mail move on;
 *  - the unreadable message's thread stays live (deletion protection) and Mail open-loop coverage stays incomplete
 *    until the message is actually read again;
 *  - `retry-held`, a due transient reconsideration and `--full` re-read the message by id, however old it is;
 *  - source errors, helper timeouts, budget truncation and unattributable messages are never item holds.
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

// A, P (poison, same thread as A), B: P sits between two healthy messages.
const threeMessages = (): FakeMail => {
  const f = fakeMail([mk('<a@x>', 'thr-a', 20), mk('<p@x>', 'thr-a', 19, { from: 'Bob Example <bob-example@example.com>' }), mk('<b@x>', 'thr-b', 18)]);
  return f;
};

describe('Apple Mail poison recovery — three failed runs, then progress', () => {
  test('runs 1-3 pin the cursor and import the healthy siblings; the third holds; run 4 excludes it and later mail moves on', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20)]);
    await baseline(dir, f, raw);
    const newestAfterBaseline = readAppleState(dir).mail.newest;

    f.box.push(mk('<p@x>', 'thr-a', 19, { from: 'Bob Example <bob-example@example.com>' }), mk('<b@x>', 'thr-b', 18));
    f.unreadable.add('<p@x>');
    for (const attempt of [1, 2, 3]) {
      const r = await sweep(dir, f, raw);
      expect(r.status).toBe('partial');
      // The healthy sibling and the next thread import while the cursor stays where it was.
      expect(await hasPage('Synthetic body of <b@x>.')).toBe(true);
      expect(readAppleState(dir).mail.newest).toBe(newestAfterBaseline);
      const [record] = messageHolds(dir);
      expect(record).toMatchObject({ key: 'mail-message:<p@x>', state: attempt === 3 ? 'held' : 'failing', attempts: attempt, code: 'item_unreadable',
        class: 'transient', ref: 'thr-a', meta: { upstream_at: dayIso(19) } });
      if (attempt === 3) expect(r.connectorHolds).toMatchObject({ held: 1, newly_held: 1 });
      else expect(r.connectorHolds).toBeUndefined();
      expect(f.main.at(-1)!.exclude).toEqual([]);
    }

    // Run 4: held at start. The message is excluded from the read, the run is not partial and the cursor moves past it.
    const r4 = await sweep(dir, f, raw);
    expect(f.main.at(-1)!.exclude).toEqual(['<p@x>']);
    expect(r4.status).not.toBe('partial');
    expect(r4.connectorHolds).toMatchObject({ held: 1, newly_held: 0 });
    const newest = readAppleState(dir).mail.newest;
    expect(Date.parse(newest!)).toBeGreaterThan(Date.parse(newestAfterBaseline!));
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', attempts: 3 });

    // Later mail still imports, the hold is untouched, and the held message is never read again.
    f.box.push(mk('<c@x>', 'thr-c', 1));
    const r5 = await sweep(dir, f, raw);
    expect(r5.status).not.toBe('partial');
    expect(await hasPage('Synthetic body of <c@x>.')).toBe(true);
    expect(Date.parse(readAppleState(dir).mail.newest!)).toBeGreaterThan(Date.parse(newest!));
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', attempts: 3 });
    expect(f.byId).toEqual([]);
  }));

  test('a capped (truncated) walk steps past the held message by its stable (date,id) key', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_mail_max: 2 });
    const f = fakeMail([mk('<a@x>', 'thr-a', 20), mk('<p@x>', 'thr-p', 19), mk('<b@x>', 'thr-b', 18), mk('<c@x>', 'thr-c', 17), mk('<d@x>', 'thr-d', 16)]);
    f.unreadable.add('<p@x>');
    // While the poison is unheld the cursor cannot pass it: every run re-reads the same two-message slice.
    for (let i = 0; i < 3; i++) {
      await sweep(dir, f, raw);
      expect(readAppleState(dir).mail.resume_from).toBeUndefined();
    }
    expect(messageHolds(dir)[0]!.state).toBe('held');
    // Held: the walk moves through the rest of the window, two messages per run, never reading the poison.
    for (let i = 0; i < 6; i++) await sweep(dir, f, raw);
    expect(await hasPage('Synthetic body of <d@x>.')).toBe(true);
    expect(f.main.slice(3).every((c) => c.exclude.length === 1)).toBe(true);
    expect(readAppleState(dir).mail.resume_from).toBeUndefined();
    expect(readAppleState(dir).mail.newest).toBe(dayIso(16));
  }));

  test('the held message\'s thread stays live: a continuing full walk that no longer sees the message deletes nothing', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_mail_max: 2 });
    const f = fakeMail([mk('<x1@x>', 'thr-x1', 25), mk('<x2@x>', 'thr-x2', 24), mk('<a@x>', 'thr-a', 23), mk('<p@x>', 'thr-a', 22, { from: 'Bob Example <bob-example@example.com>' })]);
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 8 && messageHolds(dir)[0]?.state !== 'held'; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]!.state).toBe('held');
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw); // the walk reaches the end of the window
    expect(await pageOf('thr-a')).toContain('Synthetic body of <a@x>.');
    // thr-a's readable message disappears upstream: only the held (excluded) message still names the thread.
    f.box = f.box.filter((m) => m.id !== '<a@x>');
    // A --full run starts a full walk that, truncated at 2 messages, stops before the held message and CONTINUES on the next
    // ordinary run, which does not read the held message (not due) but must not judge its thread gone.
    const first = await sweep(dir, f, raw, { full: true });
    expect(first.deleted).toBe(0);
    expect(f.main.at(-1)!.exclude).toEqual([]);
    expect(readAppleState(dir).mail.walk?.purpose).toBe('full');
    const second = await sweep(dir, f, raw);
    expect(f.main.at(-1)!.exclude).toEqual(['<p@x>']);
    expect(second.deleted).toBe(0);
    expect(readAppleState(dir).mail.walk).toBeUndefined(); // the full walk completed and reconciled
    expect(await pageOf('thr-a')).toContain('Synthetic body of <a@x>.');
    // Control: once the hold is gone and the message really is gone, the same walk does delete the page.
    f.box = f.box.filter((m) => m.id !== '<p@x>');
    await retryHeld(engine, SID);
    await sweep(dir, f, raw, { full: true });
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir)).toEqual([]);
    expect(await pageOf('thr-a')).toBeUndefined();
  }));

  test('retry-held lists the message hold with its stable key and the shared code', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = threeMessages();
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    const dry = await retryHeld(engine, SID, { dryRun: true });
    expect(dry.items).toEqual([expect.objectContaining({ key: 'mail-message:<p@x>', code: 'item_unreadable', action: 'would_retry' })]);
  }));
});

describe('Apple Mail poison recovery — coverage stays incomplete until the message is actually read again', () => {
  test('waiting is incomplete while held (even after the cursor moved on), still incomplete after a failed retry, complete after real recovery', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20)]);
    await baseline(dir, f, raw);
    f.box.push(mk('<p@x>', 'thr-a', 19, { from: 'Bob Example <bob-example@example.com>' }), mk('<b@x>', 'thr-b', 18));
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 3; i++) {
      await sweep(dir, f, raw);
      expect((await waiting()).completeness).toBe('partial');
    }
    // Held, cursor moving: coverage is still incomplete, and the sweeps do not fall back to re-reading the whole window.
    for (let i = 0; i < 3; i++) {
      const r = await sweep(dir, f, raw);
      expect(r.status).not.toBe('partial');
      expect((await waiting()).completeness).toBe('partial');
    }
    expect(readAppleState(dir).mail_loops!.reread).toBeUndefined();
    expect(readAppleState(dir).mail_loops!.pending_threads).toEqual(['thr-a']);
    expect(f.main.at(-1)!.since).toBe(new Date(Date.parse(readAppleState(dir).mail.newest!) - 2 * DAY).toISOString());

    // retry-held while Mail still cannot produce the body: the re-attempt fails again, stays held, stays incomplete, never pins.
    const retried = await retryHeld(engine, SID);
    expect(retried.scheduled).toBe(1);
    const failedRetry = await sweep(dir, f, raw);
    expect(failedRetry.status).not.toBe('partial');
    // The message is inside the incremental window here, so the main read itself re-attempts it (no separate read by id).
    expect(f.main.at(-1)!.exclude).toEqual([]);
    expect(f.byId).toEqual([]);
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', attempts: 4, reconsiderations: 1 });
    expect((await waiting()).completeness).toBe('partial');

    // The message becomes readable and is retried: the hold clears, the thread page carries the message, coverage completes.
    f.unreadable.clear();
    await retryHeld(engine, SID);
    const recovered = await sweep(dir, f, raw);
    expect(recovered.status).not.toBe('partial');
    expect(messageHolds(dir)).toEqual([]);
    expect(await pageOf('thr-a')).toContain('Synthetic body of <p@x>.');
    expect(await pageOf('thr-a')).toContain('Synthetic body of <a@x>.');
    expect(readAppleState(dir).mail_loops!.pending_threads).toEqual([]);
    expect((await waiting()).completeness).toBe('complete');
  }));
});

describe('Apple Mail poison recovery — retry reaches a message outside the incremental window', () => {
  async function heldOldPoison(dir: string, raw: Record<string, unknown>, f: FakeMail): Promise<void> {
    f.box = [mk('<a@x>', 'thr-a', 30), mk('<p@x>', 'thr-a', 29, { from: 'Bob Example <bob-example@example.com>' }), mk('<n@x>', 'thr-n', 1)];
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]!.state).toBe('held');
    await sweep(dir, f, raw); // run 4 moves the cursor past the held message
    await sweep(dir, f, raw);
    // The cursor now sits a month past the poison: the incremental window (newest - 2 days) cannot reach it.
    expect(Date.parse(f.main.at(-1)!.since)).toBeGreaterThan(Date.parse(dayIso(29)));
    f.unreadable.clear();
  }

  test('without a retry the recovered message is not read; retry-held reads it by id and date and merges it into its thread', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    await heldOldPoison(dir, raw, f);
    await sweep(dir, f, raw);
    expect(f.byId).toEqual([]); // held, not due, not requested
    expect(await hasPage('Synthetic body of <p@x>.')).toBe(false);

    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(f.byId).toEqual([[{ id: '<p@x>', date: dayIso(29) }]]);
    expect(await pageOf('thr-a')).toContain('Synthetic body of <p@x>.');
    expect(await pageOf('thr-a')).toContain('Synthetic body of <a@x>.');
    expect(messageHolds(dir)).toEqual([]);
    // The retry never touches the cursor: it is exactly where the incremental run left it.
    expect(readAppleState(dir).mail.newest).toBe(dayIso(1));
  }));

  test('a due transient reconsideration re-reads the message once its backoff has elapsed', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    await heldOldPoison(dir, raw, f);
    await sweep(dir, f, raw);
    expect(f.byId).toEqual([]);
    clock.t += 2 * HOUR; // the first transient backoff is one hour
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(f.byId).toEqual([[{ id: '<p@x>', date: dayIso(29) }]]);
    expect(messageHolds(dir)).toEqual([]);
    expect(await pageOf('thr-a')).toContain('Synthetic body of <p@x>.');
  }));

  test('sync --full re-attempts every held message once', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    await heldOldPoison(dir, raw, f);
    const r = await sweep(dir, f, raw, { full: true });
    expect(r.status).not.toBe('partial');
    expect(messageHolds(dir)).toEqual([]);
    expect(await pageOf('thr-a')).toContain('Synthetic body of <p@x>.');
  }));

  test('a message deleted upstream while held is dropped when its retry finds nothing', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    await heldOldPoison(dir, raw, f);
    f.box = f.box.filter((m) => m.id !== '<p@x>');
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(messageHolds(dir)).toEqual([]);
    expect(f.byId).toEqual([[{ id: '<p@x>', date: dayIso(29) }]]);
  }));

  test('a retry that still cannot read the message keeps the hold and counts a reconsideration; a reader that cannot read by id leaves it held, visibly', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    await heldOldPoison(dir, raw, f);
    f.unreadable.add('<p@x>');
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial'); // a held message failing again never pins or marks the run partial
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', reconsiderations: 1 });

    f.unreadable.clear();
    f.noById = true;
    await retryHeld(engine, SID);
    await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]!.state).toBe('held');
    expect(logs.some((l) => l.includes('cannot read a message by id'))).toBe(true);
  }));
});

describe('Apple Mail poison recovery — what is never an item hold', () => {
  test('helper timeouts, permission errors and budget truncation count nothing and reset nothing; only attempted runs count', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = threeMessages();
    f.unreadable.add('<p@x>');
    await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'failing', attempts: 1 });
    f.failMain = new AppleReaderError('helper_timeout', 'mail', 'Mail did not answer', 'retry later');
    const timeout = await sweep(dir, f, raw);
    expect(timeout.status).toBe('partial');
    f.failMain = new AppleReaderError('permission_denied', 'mail', 'denied', 'allow it');
    await sweep(dir, f, raw);
    f.failMain = undefined;
    f.budgetStop = true;
    const budget = await sweep(dir, f, raw);
    expect(budget.status).toBe('partial');
    f.budgetStop = false;
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'failing', attempts: 1 });
    await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'failing', attempts: 2 });
    await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', attempts: 3 });
    // Source-level failures never created a record of their own.
    expect(Object.keys(holdsOf(dir))).toEqual(['mail-message:<p@x>']);
  }));

  test('a thread the reader could not resolve (no proof) pins the cursor forever and never becomes a hold', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = threeMessages();
    f.deferred.add('thr-b');
    for (let i = 0; i < 6; i++) {
      const r = await sweep(dir, f, raw);
      expect(r.status).toBe('partial');
    }
    expect(Object.keys(holdsOf(dir))).toEqual([]);
    expect(readAppleState(dir).mail.newest).toBeUndefined();
  }));

  test('a reader that reports only thread ids (no message identity) and an incomplete listing stay conservative: no hold, cursor pinned', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = threeMessages();
    const readers = readersOf(f);
    const legacy: AppleReaders = { ...readers, async mail(opts) { const l = await readers.mail(opts) as AppleMailListing; return { messages: l.messages, unavailableThreads: ['thr-a'], incomplete: false }; } };
    const run = () => runAppleSync(engine, SID, parseAppleSourceConfig(raw, dir), { sourceId: SID, noEmbed: true, noExtract: true }, { readers: legacy, now: () => clock.t, log: () => {} });
    for (let i = 0; i < 5; i++) expect((await run()).status).toBe('partial');
    const unattributed: AppleReaders = { ...readers, async mail(opts) { const l = await readers.mail(opts) as AppleMailListing; return { messages: l.messages, incomplete: true }; } };
    for (let i = 0; i < 5; i++) {
      const r = await runAppleSync(engine, SID, parseAppleSourceConfig(raw, dir), { sourceId: SID, noEmbed: true, noExtract: true }, { readers: unattributed, now: () => clock.t, log: () => {} });
      expect(r.status).toBe('partial');
    }
    expect(Object.keys(holdsOf(dir))).toEqual([]);
    expect(readAppleState(dir).mail.newest).toBeUndefined();
  }));

  test('a targeted re-read that times out is a source problem: nothing is counted, the hold stays, the rest of the sweep imports', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    f.box = [mk('<a@x>', 'thr-a', 30), mk('<p@x>', 'thr-a', 29), mk('<n@x>', 'thr-n', 1)];
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 4; i++) await sweep(dir, f, raw);
    f.unreadable.clear();
    f.failById = new AppleReaderError('helper_timeout', 'mail', 'Mail did not answer', 'retry later');
    f.box.push(mk('<later@x>', 'thr-later', 0));
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).toBe('partial');
    expect(await hasPage('Synthetic body of <later@x>.')).toBe(true);
    expect(messageHolds(dir)[0]).toMatchObject({ state: 'held', attempts: 3, reconsiderations: 0 });
    // The retry request survived (nothing was attempted), so the next run re-reads it.
    f.failById = undefined;
    await sweep(dir, f, raw);
    expect(messageHolds(dir)).toEqual([]);
  }));
});

describe('Apple Mail poison recovery — circuit breaker and hold cap', () => {
  test('a Mail outage (half of the messages unreadable) counts no message failure, however many healthy threads import', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    // 6 messages in 6 threads; 3 unreadable. By messages that is half (an outage); mixed with the 3 thread imports it is a third.
    const f = fakeMail([1, 2, 3, 4, 5, 6].map((n) => mk(`<m${n}@x>`, `thr-${n}`, 20 - n)));
    for (const n of [1, 2, 3]) f.unreadable.add(`<m${n}@x>`);
    for (let i = 0; i < 4; i++) await sweep(dir, f, raw);
    expect(messageHolds(dir)).toEqual([]);
    // A single poison among healthy messages is counted: the breaker did not just switch off.
    f.unreadable.clear();
    f.unreadable.add('<m1@x>');
    await sweep(dir, f, raw);
    expect(messageHolds(dir)[0]).toMatchObject({ key: 'mail-message:<m1@x>', attempts: 1 });
  }));

  test('an outage group does not hide a real thread-import failure, and the reverse', () => {
    const run = new ItemHoldsRun(undefined, { groupOf: (key) => (key.startsWith('mail-message:') ? 'm' : 'i') });
    for (let n = 0; n < 6; n++) { run.succeed(`mail:t${n}`); if (n < 3) run.succeed(`mail-message:ok${n}`); else run.fail(`mail-message:bad${n}`, Object.assign(new Error('x'), { name: 'ConnectorItemUnreadable' })); }
    run.fail('mail:bad', new Error('malformed page'));
    const done = run.finish();
    expect(done.outage).toBe(true);
    expect(Object.keys(done.state.items)).toEqual(['mail:bad']);
  });

  test('the default breaker (one group) is unchanged: the same mixed counts do not read as an outage', () => {
    const run = new ItemHoldsRun(undefined, {});
    for (let n = 0; n < 6; n++) { run.succeed(`mail:t${n}`); if (n < 3) run.succeed(`mail-message:ok${n}`); else run.fail(`mail-message:bad${n}`, Object.assign(new Error('x'), { name: 'ConnectorItemUnreadable' })); }
    const done = run.finish();
    expect(done.outage).toBe(false);
    expect(Object.keys(done.state.items).sort()).toEqual(['mail-message:bad3', 'mail-message:bad4', 'mail-message:bad5']);
  });

  test('hold exhaustion blocks the cursor: a poison message past the cap fails the run before anything is saved', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fakeMail();
    // 110 healthy messages in one thread (the breaker needs healthy messages) plus HOLD_CAP already-held poison messages.
    for (let n = 0; n < 110; n++) f.box.push(mk(`<ok${n}@x>`, 'thr-ok', 20, { date: new Date(Date.parse(dayIso(20)) + n * 60_000).toISOString() }));
    const seeded: Record<string, ItemHoldRecord> = {};
    for (let n = 0; n < HOLD_CAP; n++) {
      const key = `mail-message:<held${n}@x>`;
      seeded[key] = { key, state: 'held', code: 'item_unreadable', class: 'transient', message: 'x', upstream_version: null, first_failed_at: '2026-10-01T00:00:00.000Z',
        last_failed_at: '2026-10-01T00:00:00.000Z', attempts: 3, held_at: '2026-10-01T00:00:00.000Z', next_attempt_at: '2099-01-01T00:00:00.000Z', reconsiderations: 0,
        meta: { sender: null, subject: null, title: null, upstream_at: dayIso(40) }, slug: null, request_id: null, ref: `thr-held${n}`, legacy: false };
    }
    writeFileSync(appleStateFile(dir), JSON.stringify({ version: 1, calendar: { hashes: {} }, contacts: { hashes: {} }, mail: { hashes: {} }, item_holds: { version: 1, items: seeded } }));
    f.box.push(mk('<extra@x>', 'thr-extra', 19));
    f.unreadable.add('<extra@x>');
    for (let i = 0; i < 2; i++) expect((await sweep(dir, f, raw)).status).toBe('partial');
    expect(readAppleState(dir).mail.newest).toBeUndefined();
    await expect(sweep(dir, f, raw)).rejects.toMatchObject({ code: 'connector_holds_exhausted' });
    // The failed run saved nothing: the cursor is still pinned and the extra message is still only failing.
    const after = readAppleState(dir);
    expect(after.mail.newest).toBeUndefined();
    expect(holdsOf(dir)['mail-message:<extra@x>']).toMatchObject({ state: 'failing', attempts: 2 });
    expect(Object.values(holdsOf(dir)).filter((r) => r.state === 'held')).toHaveLength(HOLD_CAP);
  }), 120_000);
});

describe('Apple Mail poison recovery — thread import holds no longer pin the cursor', () => {
  test('a thread whose import is held (3 failed runs) is skipped, later mail moves on, and the hold remembers what it needs to be rebuilt', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    // A NUL in the message id makes this thread's import fail every time (item-scoped, deterministic).
    const f = fakeMail([mk('<bad\u0000id@x>', 'thr-bad', 25), mk('<ok@x>', 'thr-ok', 24)]);
    for (let i = 0; i < 3; i++) expect((await sweep(dir, f, raw)).status).toBe('partial');
    const held = holdsOf(dir)['mail:thr-bad']!;
    expect(held.state).toBe('held');
    expect(JSON.parse(held.ref!)).toEqual({ m: [['<bad\u0000id@x>', dayIso(25)]] });
    expect(held.meta.upstream_at).toBe(dayIso(25));
    // Held at start: skipped without pinning, so the cursor advances and a later message imports.
    f.box.push(mk('<later@x>', 'thr-later', 1));
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(await hasPage('Synthetic body of <later@x>.')).toBe(true);
    expect(readAppleState(dir).mail.newest).toBe(dayIso(1));
    expect((await waiting()).completeness).toBe('partial');
  }));

  test('retry-held rebuilds an old held thread from its remembered messages, outside the incremental window', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const old = mk('<old@x>', 'thr-old', 25);
    const f = fakeMail([old, mk('<ok@x>', 'thr-ok', 24)]);
    // A directory where the import writes its temp file: a deterministic, repairable import failure.
    const blocker = join(dir, `${mailRelPath({ threadId: old.threadId, messages: [old] })}.tmp`);
    mkdirSync(blocker, { recursive: true });
    for (let i = 0; i < 3; i++) expect((await sweep(dir, f, raw)).status).toBe('partial');
    expect(holdsOf(dir)['mail:thr-old']!.state).toBe('held');
    f.box.push(mk('<later@x>', 'thr-later', 1));
    await sweep(dir, f, raw);
    await sweep(dir, f, raw);
    expect(Date.parse(f.main.at(-1)!.since)).toBeGreaterThan(Date.parse(dayIso(25)));
    expect(await pageOf('thr-old')).toBeUndefined();

    rmSync(blocker, { recursive: true, force: true });
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(f.byId).toEqual([[{ id: '<old@x>', date: dayIso(25) }]]);
    expect(await pageOf('thr-old')).toContain('Synthetic body of <old@x>.');
    expect(holdsOf(dir)['mail:thr-old']).toBeUndefined();
    expect(readAppleState(dir).mail.newest).toBe(dayIso(1)); // the cursor is untouched by the retry
  }));

  test('a held thread whose remembered messages are all gone upstream is dropped by its retry', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const old = mk('<old@x>', 'thr-old', 25);
    const f = fakeMail([old, mk('<later@x>', 'thr-later', 1)]);
    const blocker = join(dir, `${mailRelPath({ threadId: old.threadId, messages: [old] })}.tmp`);
    mkdirSync(blocker, { recursive: true });
    for (let i = 0; i < 4; i++) await sweep(dir, f, raw);
    expect(holdsOf(dir)['mail:thr-old']!.state).toBe('held');
    f.box = f.box.filter((m) => m.id !== '<old@x>');
    await retryHeld(engine, SID);
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(holdsOf(dir)['mail:thr-old']).toBeUndefined();
  }));
});

describe('Apple Mail poison recovery — remembered thread messages', () => {
  test('a thread longer than the bound is remembered as a whole-window locator, never as a partial list that would rebuild it without its older messages', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `<m${i}@x>`, date: dayIso(1) }));
    expect(JSON.parse(encodeThreadRef(many(APPLE_THREAD_REF_MAX))).m).toHaveLength(APPLE_THREAD_REF_MAX);
    expect(JSON.parse(encodeThreadRef(many(APPLE_THREAD_REF_MAX + 1)))).toEqual({ w: APPLE_THREAD_REF_MAX + 1, o: dayIso(1) });
  });
});
