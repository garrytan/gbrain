/**
 * Write comparisons for swap criterion 5 (src/shadow/write-compare.ts, write-capture.ts, write-compare-child.ts): the PGLite arm.
 * Scenarios shared with the Postgres twin (test/e2e/shadow-write-compare.test.ts) are in test/helpers/shadow-write-compare-scenarios.ts.
 *
 * Authoring gate (docs/TESTING.md): (1) protects the count criterion 5 reads: a sampled page or link write is replayed on a scratch Rust
 * store and counted `comparable` only when the changed rows match. (2) Fails when a match is not counted, a mismatch is not unexplained,
 * a write from another family is counted anywhere but `capability_missing`, an uncomparable or unreadable write is ever `comparable`,
 * criterion 5 leaves `missing` with no comparison behind it, the pilot changes a primary write, or a shadow that is off or unseeded
 * reads anything. (3) Nothing else compares writes. (4) The real scratch replay needs the built addon and skips without it
 * (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 or GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error; the Rust engine workflow runs it that way through its rust-store receipt lane); everything else uses fake engines or no engine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { WRITE_COVERAGE_LIMIT, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { PassThrough } from 'node:stream';
import { createEngine } from '../src/core/engine-factory.ts';
import { runShadowChild } from '../src/shadow/child.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { ensureEpoch, readEpoch, withLock } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus, renderFollowStatus } from '../src/shadow/follow-status.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { configDir } from '../src/core/config.ts';
import { shadowRoot } from '../src/shadow/state.ts';
import { scratchRootDefault } from '../src/shadow/write-compare-child.ts';
import { faultsPath, readFaults } from '../src/shadow/ledger.ts';
import { lostPath, movedOutsideFootprint, pageRefs, readWriteTally, recordLost, sentPath, unfoldedLost, writeTallyPath, WriteTally, type WriteEvent } from '../src/shadow/write-compare.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { defineWriteCompareScenarios, fakeComparer, page, row5, settle, tallyOn, watchPreimage } from './helpers/shadow-write-compare-scenarios.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 or GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${BUILT} does not exist; run bun run rust:build`);

const NOW = new Date('2026-12-01T00:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-')); dirs.push(d); return d; };

let primary: PGLiteEngine;
let addon: RustAddon | undefined;
beforeAll(async () => {
  primary = new PGLiteEngine(); await primary.connect({}); await primary.initSchema();
  if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
});
afterAll(async () => { await primary.disconnect(); });
beforeEach(async () => { await resetPgliteState(primary); });

describe('write comparisons on PGLite', () => {
  defineWriteCompareScenarios({ primary: () => primary, reset: async () => { await resetPgliteState(primary); }, kind: 'pglite', tempDir: tmp, ...(HAVE_ADDON ? { addon: () => addon!, addonPath: BUILT } : {}) });
});

describe('write comparison counts', () => {
  test('the child never takes a verdict from the serving process', async () => {
    const dir = tmp();
    const comparer = fakeComparer(dir);
    await settle(comparer, [{ t: 'write', op: 'putPage', outcome: 'comparable' }, { t: 'write', op: 'putPage', outcome: 'unexplained_difference' }]);
    expect(comparer.counts()).toMatchObject({ comparable: 0, unexplained_difference: 0 });
  });
});

describe('the locked write tally', () => {
  const OTHER = process.ppid; // a second child that is running
  const STATE = { sample_rate: 0.1 } as never;
  const put = (over: Partial<WriteEvent> = {}): WriteEvent => ({
    t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[],
    pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over,
  });
  /** Makes this child's save fail (its temp file is a directory) until the returned function is called. */
  const blockSave = (dir: string, pid: number): (() => void) => { const path = `${writeTallyPath(dir)}.${pid}.tmp`; mkdirSync(path); return () => rmSync(path, { recursive: true, force: true }); };
  /** A saved passing tally: 1,000 comparable writes, none unexplained. */
  const saved = (dir: string, epoch: string): void => writeFileSync(writeTallyPath(dir), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [] }));
  const status = (dir: string) => buildFollowStatus(dir, STATE, NOW).write_comparisons;

  test('lost samples the serving process recorded are folded once into the owner child\'s epoch as uncomparable; until then status reads no evidence, and another epoch\'s lines never count', () => {
    const dir = tmp();
    const { tally, epoch, counts } = tallyOn(dir); saved(dir, epoch);
    expect(recordLost(dir, epoch, 'send_shed')).toBe(true);
    recordLost(dir, epoch, 'send_shed'); recordLost(dir, 'a-retired-epoch', 'send_shed');
    appendFileSync(lostPath(dir, process.pid), 'not json\n'); // a line that cannot be read is counted too, never skipped
    expect(status(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 3 }); // two readable lines of this epoch and the unreadable one, none folded
    expect(row5({ write_comparisons: status(dir) as ShadowStatus['write_comparisons'] }).state).toBe('missing');
    tally.save();
    expect(counts()).toMatchObject({ comparable: 1000, uncomparable: 3, uncomparable_by_reason: { send_shed: 2, lost_unreadable: 1 } });
    expect(status(dir)).toMatchObject({ state: 'measured', comparable: 1000 });
    expect(status(dir).unresolved_replays).toBeUndefined();
    tally.save();
    expect(counts().uncomparable).toBe(3); // each line is added once
    appendFileSync(lostPath(dir, process.pid), `{"epoch_id":"${epoch}","reason":"readback_`); // a line still being appended waits for its newline
    tally.save();
    expect(counts().uncomparable).toBe(3);
    appendFileSync(lostPath(dir, process.pid), 'abandoned"}\n');
    tally.save();
    expect(counts()).toMatchObject({ uncomparable: 4, uncomparable_by_reason: { readback_abandoned: 1 } });
    expect(recordLost(join(dir, 'gone'), epoch, 'send_shed')).toBe(false); // not recorded: the sampler then carries the count on its next line
  });

  test('an unreadable loss journal or a listing that fails is unresolved, never zero: status reads no evidence, and criterion 5 stays missing', () => {
    const dir = tmp();
    const { tally, epoch, counts } = tallyOn(dir); saved(dir, epoch);
    expect(recordLost(dir, epoch, 'send_shed')).toBe(true);
    rmSync(lostPath(dir, process.pid)); mkdirSync(lostPath(dir, process.pid)); // the journal can no longer be read (EISDIR stands for EIO)
    expect(status(dir)).toMatchObject({ state: 'capability_missing', comparable: 1000, unresolved_replays: 1 });
    expect(row5({ write_comparisons: status(dir) as ShadowStatus['write_comparisons'] }).state).toBe('missing');
    tally.save();
    expect(counts()).toMatchObject({ comparable: 1000, uncomparable: 0 }); // nothing is invented from what cannot be read
    const aFile = join(dir, 'not-a-directory'); writeFileSync(aFile, '');
    expect(unfoldedLost(aFile, epoch)).toBe(1); // a listing that fails (ENOTDIR) is unresolved
    expect(unfoldedLost(join(dir, 'gone'), epoch)).toBe(0); // a directory that is gone has nothing to fold
  });

  test('a loss is acknowledged only after its journal file and directory entry are flushed: a failed flush returns false so the count is kept', async () => {
    const durable = await import('../src/core/fs-durable.ts');
    const dir = tmp();
    const file = spyOn(durable, 'flushFile').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(recordLost(dir, 'an-epoch', 'send_shed')).toBe(false);
    file.mockRestore();
    const directory = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(recordLost(dir, 'an-epoch', 'send_shed')).toBe(false);
    directory.mockRestore();
    expect(recordLost(dir, 'an-epoch', 'send_shed')).toBe(true);
  });

  test('an unfinished journal line is unresolved while its writer lives, and exactly one lost_unreadable once the writer is dead; the fold then moves past it', () => {
    const dir = tmp();
    const { tally, epoch, counts } = tallyOn(dir); saved(dir, epoch);
    appendFileSync(lostPath(dir, process.pid), '{"epoch_id":'); // cut short, and its writer (this process) is alive
    expect(status(dir)).toMatchObject({ state: 'capability_missing', comparable: 1000, unresolved_replays: 1 });
    expect(row5({ write_comparisons: status(dir) as ShadowStatus['write_comparisons'] }).state).toBe('missing');
    tally.save();
    expect(counts()).toMatchObject({ comparable: 1000, uncomparable: 0 }); // nothing is invented while the writer may still finish the line
    rmSync(lostPath(dir, process.pid));
    const dead = 99_999_999; // no such process
    writeFileSync(lostPath(dir, dead), `{"epoch_id":"${epoch}","reason":"send_shed"}\n{"epoch_id":`);
    expect(status(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 2 }); // the complete line and the cut-short one
    tally.save();
    expect(counts()).toMatchObject({ comparable: 1000, uncomparable: 2, uncomparable_by_reason: { send_shed: 1, lost_unreadable: 1 } });
    expect(status(dir)).toMatchObject({ state: 'measured' });
    expect(status(dir).unresolved_replays).toBeUndefined();
    tally.save();
    expect(counts().uncomparable).toBe(2); // the fold moved past the cut-short line: it is counted once
  });

  test('a lost sample of one epoch is never added to the next epoch (the owner child takes lines for its own fixed epoch only)', () => {
    const dir = tmp();
    const first = tallyOn(dir);
    recordLost(dir, first.epoch, 'send_shed');
    const second = ensureEpoch(dir, { seed_id: 's2', rust_addon_sha256: 'b', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' }, NOW.getTime()).epoch_id;
    expect(second).not.toBe(first.epoch);
    const next = new WriteTally(dir, () => second, () => true, process.pid);
    next.note('comparable');
    expect(readWriteTally(dir, second)).toMatchObject({ comparable: 1, uncomparable: 0 });
    expect(status(dir).unresolved_replays).toBeUndefined(); // the first epoch is retired: its lost line is not this epoch's
  });

  test('two children: a mismatch the second saves is never lost when the first saves late, and neither clears the other\'s mark', () => {
    const dir = tmp();
    const a = tallyOn(dir, process.pid); const b = tallyOn(dir, OTHER);
    expect(a.tally.begin()).toBe(true);
    expect(b.tally.begin()).toBe(true);
    expect(a.counts().in_flight.sort()).toEqual([OTHER, process.pid].sort());
    const unblock = blockSave(dir, process.pid);
    a.tally.note('comparable', undefined, 1, true); // A's verdict cannot be saved: kept, and A's mark stands
    expect(a.counts().comparable).toBe(0);
    b.tally.note('unexplained_difference', undefined, 1, true); // B saves a mismatch meanwhile
    expect(b.counts()).toMatchObject({ unexplained_difference: 1, in_flight: [process.pid] }); // B ended only its own mark
    unblock();
    a.tally.note('capability_missing', 'tags'); // A's next save adds its own verdicts to what the file holds now
    expect(a.counts()).toMatchObject({ comparable: 1, unexplained_difference: 1, capability_missing: 1, in_flight: [] });
    expect(status(dir)).toMatchObject({ state: 'measured', unexplained_difference: 1 });
  });

  test('both saves failing: the mark is refused so no replay runs, a saved tally stands unchanged, and the unsaved count is added at the next save', async () => {
    const dir = tmp();
    const { epoch } = tallyOn(dir); saved(dir, epoch);
    const before = readFileSync(writeTallyPath(dir), 'utf8');
    const unblock = blockSave(dir, process.pid);
    let connects = 0;
    const comparer = fakeComparer(dir, { connect: async () => { connects++; } });
    await settle(comparer, [put()]); // begin() cannot publish its mark, and the verdict save fails too
    expect(connects).toBe(0); // no replay ran, so no verdict exists that could be lost
    expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe(before); // the saved passing tally is untouched, never rebuilt from memory
    unblock();
    await settle(comparer, [put()]); // the next save adds the earlier uncomparable sample to the file's current contents
    expect(connects).toBe(1);
    expect(comparer.counts()).toMatchObject({ comparable: 1001, uncomparable: 1, uncomparable_by_reason: { mark_unwritten: 1 }, in_flight: [] });
  });

  test('a verdict that cannot be saved leaves the mark standing, and status reads that as no evidence, never a pass', async () => {
    const dir = tmp();
    const { epoch } = tallyOn(dir); saved(dir, epoch);
    expect(status(dir)).toMatchObject({ state: 'measured', comparable: 1000 });
    const mine = tallyOn(dir); // the mark is published, then the verdict save fails
    expect(mine.tally.begin()).toBe(true);
    expect(status(dir)).toMatchObject({ state: 'capability_missing', comparable: 1000, unresolved_replays: 1 });
    const row = row5({ write_comparisons: status(dir) as ShadowStatus['write_comparisons'] });
    expect(row.state).toBe('missing');
    expect(row.detail).toContain('capability_missing');
    expect(renderFollowStatus(buildFollowStatus(dir, STATE, NOW)).join('\n')).toContain('1 replay(s) with no verdict written yet, so no evidence');
    const unblock = blockSave(dir, process.pid);
    mine.tally.note('comparable', undefined, 1, true);
    mine.tally.note('comparable', undefined, 1, true);
    expect(status(dir).state).toBe('capability_missing'); // still unresolved: two verdicts held, none saved
    unblock();
    mine.tally.note('comparable', undefined, 1, true);
    expect(status(dir)).toMatchObject({ state: 'measured', comparable: 1003 });
    expect(status(dir).unresolved_replays).toBeUndefined(); // none standing; nothing restarted, nothing lost
  });

  test('a dead process\'s mark is recovered as unexplained_difference, which fails the epoch, and the mark of an earlier process with this pid is too', () => {
    const dir = tmp();
    const { epoch } = tallyOn(dir); saved(dir, epoch);
    const dead = Bun.spawnSync(['true']).pid; // exited and reaped: no such process
    expect(tallyOn(dir, dead).tally.begin()).toBe(true);
    expect(status(dir).state).toBe('capability_missing'); // until a child recovers it
    const next = tallyOn(dir, process.pid);
    next.tally.recover();
    expect(next.counts()).toMatchObject({ comparable: 1000, unexplained_difference: 1, in_flight: [] });
    const row = row5({ write_comparisons: status(dir) as ShadowStatus['write_comparisons'] });
    expect(status(dir).state).toBe('measured');
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('1 unexplained differences');
    // The same pid in the list at a child's start is an earlier process that had it (pid reuse): also unresolved.
    const reused = tallyOn(dir, OTHER);
    expect(reused.tally.begin()).toBe(true);
    tallyOn(dir, OTHER).tally.recover();
    expect(reused.counts()).toMatchObject({ unexplained_difference: 2, in_flight: [] });
  });

  test('a live process\'s mark is left alone by recovery and by every other child\'s save', () => {
    const dir = tmp();
    const a = tallyOn(dir, OTHER); const b = tallyOn(dir, process.pid);
    expect(a.tally.begin()).toBe(true);
    b.tally.recover(); b.tally.note('uncomparable', 'moved');
    expect(b.counts()).toMatchObject({ unexplained_difference: 0, uncomparable: 1, in_flight: [OTHER] });
  });

  test('begin() is true only when the mark is durable: a failed file or directory flush refuses the replay, and a save that may have landed is added once at the retry', async () => {
    const dir = tmp();
    const { epoch } = tallyOn(dir); saved(dir, epoch);
    const durable = await import('../src/core/fs-durable.ts');
    const mine = tallyOn(dir);
    const flushFile = spyOn(durable, 'flushFile').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(mine.tally.begin()).toBe(false); // the temp file could not be flushed: nothing was published
    expect(readWriteTally(dir, epoch)!.in_flight).toEqual([]);
    flushFile.mockRestore();
    const flushDirectory = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(mine.tally.begin()).toBe(false); // renamed, but the rename may not survive a power loss: the replay is refused all the same
    flushDirectory.mockRestore();
    expect(mine.tally.begin()).toBe(true); // the retry publishes durably
    // A verdict whose directory flush fails after the rename may have landed: it is kept, and counted once when saved again.
    const again = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    mine.tally.note('comparable', undefined, 1, true);
    again.mockRestore();
    expect(mine.counts().comparable).toBe(1001); // it did land
    mine.tally.note('capability_missing', 'tags'); // the next save carries the earlier batch again: it is not added a second time
    expect(mine.counts()).toMatchObject({ comparable: 1001, capability_missing: 1, in_flight: [] });
    mine.tally.note('uncomparable', 'moved');
    expect(mine.counts()).toMatchObject({ comparable: 1001, uncomparable: 1 });
    const other = tallyOn(dir, OTHER); // another child's batches are numbered on their own
    other.tally.note('comparable');
    expect(other.counts().comparable).toBe(1002);
  });

  test('a failed begin() before the rename cannot unseal a batch that may have landed: the next outcome is counted, not lost', async () => {
    const dir = tmp();
    const { epoch } = tallyOn(dir); saved(dir, epoch);
    const mine = tallyOn(dir);
    const durable = await import('../src/core/fs-durable.ts');
    const flush = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    mine.tally.note('comparable', undefined, 1, true); // renamed, then the directory flush failed: it may have landed
    expect(flush).toHaveBeenCalledTimes(1); flush.mockRestore(); // the ambiguity really happened
    const unblock = blockSave(dir, process.pid);
    expect(mine.tally.begin()).toBe(false); // fails before any rename
    unblock();
    mine.tally.note('uncomparable', 'mark_unwritten', 1, true); // the refused sample's outcome
    expect(mine.counts()).toMatchObject({ comparable: 1001, uncomparable: 1, uncomparable_by_reason: { mark_unwritten: 1 }, in_flight: [] });
  });

  test('a lock that names no holder (empty, as a crash between creating and writing it leaves) is never taken over, however old, so a live replacement is never removed', () => {
    const dir = tmp(); const lock = join(dir, 'x.lock');
    writeFileSync(lock, '');
    utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000)); // long past any age a takeover once waited for
    let judged = 0; let ran = 0;
    expect(() => withLock(lock, () => { ran++; }, { afterJudged: () => { judged++; }, waitMs: 200 })).toThrow('the lock is held');
    expect([judged, ran, readFileSync(lock, 'utf8'), existsSync(`${lock}.takeover`)]).toEqual([0, 0, '', false]);
    writeFileSync(lock, 'not-a-pid'); // text that names no holder either
    expect(() => withLock(lock, () => { ran++; }, { waitMs: 200 })).toThrow('the lock is held');
    expect(ran).toBe(0);
  });

  test('a file that is there and not a tally is never written over (begin refuses), and a child of a retired epoch never replaces the current epoch\'s file', () => {
    const dir = tmp();
    const mine = tallyOn(dir);
    writeFileSync(writeTallyPath(dir), '{"version":1,"comparable":"many"}');
    expect(mine.tally.begin()).toBe(false);
    expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe('{"version":1,"comparable":"many"}');
    rmSync(writeTallyPath(dir));
    expect(mine.tally.begin()).toBe(true);
    mine.tally.note('comparable', undefined, 1, true);
    const stale = new WriteTally(dir, () => 'an-epoch-that-was-retired', () => true, OTHER);
    expect(stale.begin()).toBe(false);
    stale.note('uncomparable', 'moved');
    expect(readWriteTally(dir, mine.epoch)).toMatchObject({ comparable: 1, uncomparable: 0 });
  });

  test('stale lock takeover is exclusive: with one contender slow between judging the lock dead and removing it, two real processes still never overlap and neither one\'s saved result is lost', async () => {
    const dir = tmp(); const lock = join(dir, 'x.lock'); const counter = join(dir, 'counter.json'); const log = join(dir, 'log.txt'); const barrier = join(dir, 'a-entered');
    writeFileSync(counter, '[]'); writeFileSync(log, ''); writeFileSync(lock, String(Bun.spawnSync(['true']).pid)); // a lock whose holder is gone
    const slow = Bun.spawn(['bun', join(import.meta.dir, 'helpers', 'lock-contender.ts'), lock, counter, log, barrier, 'B'], { stdout: 'pipe', stderr: 'pipe' });
    for (let i = 0; i < 400 && !existsSync(`${barrier}.judged`); i++) await new Promise((r) => setTimeout(r, 25)); // B has judged the lock dead and waits
    const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    withLock(lock, () => { // this process takes the lock over while B is still on its old judgment
      appendFileSync(log, 'enter A\n'); writeFileSync(barrier, '1'); // B may go on now
      const seen = JSON.parse(readFileSync(counter, 'utf8')) as string[];
      pause(600);
      writeFileSync(counter, JSON.stringify([...seen, 'A'])); appendFileSync(log, 'exit A\n');
    });
    expect(await slow.exited).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.length).toBe(4);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['enter', 'exit', 'enter', 'exit']); // never two inside at once
    expect(lines[0]).toBe('enter A'); expect(lines[1]).toBe('exit A');
    expect((JSON.parse(readFileSync(counter, 'utf8')) as string[]).sort()).toEqual(['A', 'B']); // both results saved
    expect(existsSync(lock)).toBe(false); expect(existsSync(`${lock}.takeover`)).toBe(false);
  }, 30_000);

  test('a lock is released only while it is still the releasing process\'s own', () => {
    const dir = tmp(); const lock = join(dir, 'x.lock');
    withLock(lock, () => { rmSync(lock); writeFileSync(lock, `${process.ppid}:another-holder`); }); // the lock was taken from under it (a takeover judged it dead)
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid}:another-holder`); // its release leaves the new holder's lock alone
  });

  test('the lock is the epoch manifest\'s: a lock whose holder is gone is taken over, and the work inside runs once', () => {
    const dir = tmp(); const lock = join(dir, 'x.lock');
    writeFileSync(lock, String(Bun.spawnSync(['true']).pid));
    let ran = 0;
    expect(withLock(lock, () => { ran++; return 'done'; })).toBe('done');
    expect(ran).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(() => withLock(join(dir, 'missing-directory', 'x.lock'), () => 1)).toThrow(); // it never creates the directory it locks in
    expect(existsSync(join(dir, 'missing-directory'))).toBe(false);
  });
});

describe('a client child records no write comparison (lane owner ruling)', () => {
  const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
  const BASE = { loadAddon: ADDON, capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };
  const sample = JSON.stringify({ t: 'write', op: 'addTag', outcome: 'capability_missing', family: 'tags' }) + '\n';
  const replay = JSON.stringify({ t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] } }) + '\n';
  async function run(dir: string, role: 'owner' | 'client', sha: string, lines: string[]): Promise<void> {
    const input = new PassThrough();
    const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, addonSha256: () => sha, openEngine: () => ({ ownerRole: role, async connect() {}, async disconnect() {} }) as never });
    for (const l of lines) input.write(l);
    input.end();
    await done;
  }
  const seeded = (): string => { const d = tmp(); writeSeedRecord(d, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never); return d; };

  test('only the owner child records; a client child adds nothing, with the epoch\'s own addon and inputs, and across an A to B to A epoch rotation', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = seeded(); const A = 'a'.repeat(64);
      await run(dir, 'owner', A, [sample]); // the owner opens the epoch and counts one
      const epoch = readEpoch(dir)!.epoch_id;
      expect(readWriteTally(dir, epoch)).toMatchObject({ capability_missing: 1 });
      const before = readFileSync(writeTallyPath(dir), 'utf8');
      await run(dir, 'client', A, [sample, replay]); // the same addon and inputs, as a client of another process's store: nothing is counted, no replay runs
      expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe(before);
      await run(dir, 'owner', 'b'.repeat(64), []); // another addon takes the store: a second epoch
      await run(dir, 'client', 'b'.repeat(64), [sample, replay]); // its client: still nothing
      await run(dir, 'owner', A, []); // and A again, which is a third epoch, not the first
      const third = readEpoch(dir)!.epoch_id;
      expect(third).not.toBe(epoch);
      await run(dir, 'client', A, [sample, replay]); // a client with the third epoch's own addon and inputs: nothing is counted in it
      expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe(before); // the file is byte for byte the first owner's
      expect(readWriteTally(dir, third)).toBeNull();
    });
  }, 60_000);
});

describe('a client child\'s verdicts are counted, never dropped (no_epoch)', () => {
  test('a client child hands its verdicts to the owner as lost samples, in a few appends, and the owner counts every one as uncomparable no_epoch; the tally file is not touched by the client', () => {
    const dir = tmp();
    const owner = tallyOn(dir);
    owner.tally.note('capability_missing', 'tags'); // the owner has recorded one
    const before = readFileSync(writeTallyPath(dir), 'utf8');
    const client = new WriteTally(dir, () => null, () => true, 424242); // a child with no epoch of its own
    const lostFile = lostPath(dir, process.pid);
    const sizes = new Set<number>();
    for (let n = 0; n < 600; n++) { client.note(n % 2 ? 'capability_missing' : 'uncomparable', n % 2 ? 'tags' : 'moved'); sizes.add(existsSync(lostFile) ? statSync(lostFile).size : 0); }
    expect(sizes.size).toBeLessThanOrEqual(4); // one append per 256 verdicts, not one per verdict
    client.save();
    expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe(before); // a client child records nothing in the tally
    expect(unfoldedLost(dir, owner.epoch)).toBe(600);
    owner.tally.save(); // the owner folds them in
    expect(owner.counts()).toMatchObject({ comparable: 0, capability_missing: 1, uncomparable: 600, uncomparable_by_reason: { no_epoch: 600 } });
  });

  test('a client\'s pending verdicts plus a large count are all kept across the 10,000-line append cap: only what was written is released (255 + 10,000 = 10,255 counted)', () => {
    const dir = tmp();
    const owner = tallyOn(dir);
    const client = new WriteTally(dir, () => null, () => true, 424242);
    client.note('uncomparable', 'send_shed', 255); client.note('uncomparable', 'send_shed', 10_000);
    client.save();
    expect(unfoldedLost(dir, owner.epoch)).toBe(10_255); // before: 10,000, and 255 released unwritten
    owner.tally.save();
    expect(owner.counts().uncomparable_by_reason.no_epoch).toBe(10_255);
  });

  test('a client whose appends fail keeps the whole count: nothing is released, and the last save names it in a fault', () => {
    const dir = tmp();
    tallyOn(dir);
    mkdirSync(lostPath(dir, process.pid)); // appends fail
    const client = new WriteTally(dir, () => null, () => true, 424242);
    client.note('uncomparable', 'moved', 300);
    expect(client.save()).toBe(false);
    expect(readFaults(dir).map((f) => [f.kind, f.detail])).toContainEqual(['write_samples_unrecorded', 'no_epoch n=300']);
  });

  test('with no epoch on disk yet nothing can be recorded: the count waits for the next save, and the last one leaves a fault line, never a silent drop; a deleted shadow directory counts nothing', () => {
    const dir = tmp();
    const client = new WriteTally(dir, () => null, () => true, 424242);
    client.note('uncomparable', 'moved', 3);
    expect(client.save()).toBe(false);
    expect(readFaults(dir).map((f) => f.kind)).toEqual(['write_samples_unrecorded']);
    const gone = new WriteTally(join(dir, 'gone'), () => null, () => false, 424243);
    gone.note('uncomparable', 'moved', 3); gone.save();
    expect(existsSync(join(dir, 'gone'))).toBe(false);
  });
});

describe('write comparison rules (review findings)', () => {
  const sample = (over: Partial<WriteEvent> = {}): WriteEvent => ({
    t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[],
    pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over,
  });

  test('putPage takes its source from its options (third argument), and a link origin with no source is the default source', () => {
    const page = { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' };
    expect(pageRefs('putPage', ['people/pat-example', page, { sourceId: 'team-example' }])).toEqual([{ source: 'team-example', slug: 'people/pat-example' }]);
    expect(pageRefs('putPage', ['people/pat-example', { ...page, sourceId: 'not-an-option' }])).toEqual([{ source: 'default', slug: 'people/pat-example' }]);
    expect(pageRefs('deletePage', ['people/pat-example', { sourceId: 'team-example' }])).toEqual([{ source: 'team-example', slug: 'people/pat-example' }]);
    const link = pageRefs('addLink', ['a/x', 'a/y', 'c', 'knows', 'markdown', 'a/origin', 'f', { fromSourceId: 'team-example', toSourceId: 'team-example' }]);
    expect(link).toEqual([{ source: 'team-example', slug: 'a/x' }, { source: 'team-example', slug: 'a/y' }, { source: 'default', slug: 'a/origin' }]);
    const batch = pageRefs('addLinksBatch', [[{ from_slug: 'a/x', to_slug: 'a/y', from_source_id: 'team-example', to_source_id: 'team-example', origin_slug: 'a/origin' }]]);
    expect(batch.map((r) => r.source)).toEqual(['team-example', 'team-example', 'default']);
  });

  test('a sample that is known to have had another write land is uncomparable even when the rows match', async () => {
    const comparer = fakeComparer(tmp());
    await settle(comparer, [sample({ moved: true }), sample()]);
    expect(comparer.counts()).toMatchObject({ comparable: 1, unexplained_difference: 0, uncomparable: 1, uncomparable_by_reason: { moved: 1 } });
  });

  test('a second child never deletes the store a first one is using, and a dead process\'s leftover store is removed', async () => {
    const dir = tmp(); const scratch = tmp();
    let opened = ''; let release = (): void => {}; let entered = (): void => {};
    const inside = new Promise<void>((r) => { entered = r; });
    const first = fakeComparer(dir, { scratchRoot: scratch, connect: async (path) => { opened = path; entered(); await new Promise<void>((r) => { release = r; }); } });
    first.handle(sample());
    await inside;
    mkdirSync(join(scratch, 'write-compare-2147483646-leftover')); // a pid that is not running
    fakeComparer(dir, { scratchRoot: scratch }); // another child starts in the same temp directory
    expect(existsSync(dirname(opened))).toBe(true);
    expect(existsSync(join(scratch, 'write-compare-2147483646-leftover'))).toBe(false);
    release(); await first.idle();
    expect(readdirSync(scratch)).toEqual([]);
  });

  test('a replay that is still opening when stop --delete removes the shadow directory does not bring it back', async () => {
    const dir = tmp(); const scratch = tmp();
    let release = (): void => {}; let entered = (): void => {};
    const inside = new Promise<void>((r) => { entered = r; });
    const comparer = fakeComparer(dir, { scratchRoot: scratch, alive: () => existsSync(dir), connect: async (path) => {
      entered(); await new Promise<void>((r) => { release = r; });
      mkdirSync(path, { recursive: true }); // what the owner election does to the ancestors of a store it opens
    } });
    comparer.handle(sample());
    await inside;
    rmSync(dir, { recursive: true, force: true }); // stop --delete
    release(); await comparer.idle();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('the data fence and the scratch location (lane owner ruling)', () => {
  const R = (o: Record<string, string>) => ({ ...o });
  const A = R({ id: '1', source_id: 'default', slug: 'a/x', title: 'X' }); const B = R({ id: '2', source_id: 'default', slug: 'a/y', title: 'Y' });
  const L = R({ id: '10', from_page_id: '1', to_page_id: '2', link_type: 'knows' });
  const pre = { sources: [], pages: [A, B], links: [L] };
  const sample = (over: Partial<WriteEvent> = {}): WriteEvent => ({ t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over });

  test('rows outside the write\'s footprint must be unchanged, and no link may appear that the write did not add', () => {
    const link = ['a/x', 'a/y', 'c', 'knows'];
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, B], links: [L] })).toBe(false);
    const added = R({ id: '11', from_page_id: '2', to_page_id: '1', link_type: 'knows' });
    const forward = ['a/y', 'a/x', 'c', 'knows'];
    expect(movedOutsideFootprint('addLink', forward, pre, { sources: [], pages: [A, B], links: [L, added] })).toBe(false); // the write's own link
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, B], links: [L, added] })).toBe(true); // a link nobody here wrote
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A, { ...B, title: 'Edited elsewhere' }], links: [L] })).toBe(true); // a copied page changed
    expect(movedOutsideFootprint('addLink', link, pre, { sources: [], pages: [A], links: [L] })).toBe(true); // a copied page is gone
    expect(movedOutsideFootprint('removeLink', ['a/x', 'a/y', 'knows'], pre, { sources: [], pages: [A, B], links: [] })).toBe(false); // the write's own link, removed
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [{ ...A, title: 'New' }, B], links: [L] })).toBe(false); // the page it writes
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [A, { ...B, title: 'Edited elsewhere' }], links: [L] })).toBe(true);
    expect(movedOutsideFootprint('putPage', ['a/x', {}], pre, { sources: [], pages: [A, B], links: [] })).toBe(true); // a link it does not write is gone
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [B], links: [] })).toBe(false); // the page and its links go
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [{ ...B, title: 'Edited elsewhere' }], links: [] })).toBe(true);
    const farther = R({ id: '12', from_page_id: '2', to_page_id: '99', link_type: 'knows' });
    expect(movedOutsideFootprint('deletePage', ['a/x'], pre, { sources: [], pages: [B], links: [farther] })).toBe(false); // a link to a page that was never copied is not a change to the copy
    const jobs = { ...B, projection_job_revision: 'r1' };
    expect(movedOutsideFootprint('addLink', link, { ...pre, pages: [A, jobs] }, { sources: [], pages: [A, { ...jobs, projection_job_revision: 'r2' }], links: [L] })).toBe(false); // job-queue state is not an edit
  });

  test('a link another process adds between the same two pages, with another type or source, is not the write\'s own (a type or source it leaves out matches any)', () => {
    const typed = ['a/x', 'a/y', 'c', 'knows', 'markdown'];
    const other = R({ id: '13', from_page_id: '1', to_page_id: '2', link_type: 'works_at', link_source: 'markdown' });
    const same = R({ id: '14', from_page_id: '1', to_page_id: '2', link_type: 'knows', link_source: 'markdown' });
    const fromElsewhere = R({ id: '15', from_page_id: '1', to_page_id: '2', link_type: 'knows', link_source: 'frontmatter' });
    const after = (links: Array<Record<string, string>>) => ({ sources: [], pages: [A, B], links: [L, ...links] });
    expect(movedOutsideFootprint('addLink', typed, pre, after([same]))).toBe(false);
    expect(movedOutsideFootprint('addLink', typed, pre, after([other]))).toBe(true);
    expect(movedOutsideFootprint('addLink', typed, pre, after([fromElsewhere]))).toBe(true);
    expect(movedOutsideFootprint('addLink', ['a/x', 'a/y', 'c'], pre, after([other]))).toBe(false); // no type named: the documented gap
  });

  test('the link fence keys on the origin page too: another origin between the same ends is not the write\'s own, and a link that names no origin is own only when the row has none', () => {
    const O = R({ id: '3', source_id: 'default', slug: 'a/o', title: 'O' }); const P = R({ id: '4', source_id: 'default', slug: 'a/p', title: 'P' });
    const base = { sources: [], pages: [A, B, O, P], links: [L] };
    const after = (links: Array<Record<string, string | null>>) => ({ sources: [], pages: [A, B, O, P], links: [L, ...links] });
    const row = (origin: string | null, id = '20') => R({ id, from_page_id: '1', to_page_id: '2', link_type: 'knows', link_source: 'markdown', origin_page_id: origin as never });
    const named = ['a/x', 'a/y', 'c', 'knows', 'markdown', 'a/o'];
    expect(movedOutsideFootprint('addLink', named, base, after([row('3')]))).toBe(false); // the origin it named
    expect(movedOutsideFootprint('addLink', named, base, after([row('4')]))).toBe(true); // another process's link with another origin
    expect(movedOutsideFootprint('addLink', named, base, after([row(null)]))).toBe(true); // one with none
    const unnamed = ['a/x', 'a/y', 'c', 'knows', 'markdown'];
    expect(movedOutsideFootprint('addLink', unnamed, base, after([row(null)]))).toBe(false); // no origin named: own when the row has none
    expect(movedOutsideFootprint('addLink', unnamed, base, after([row('3')]))).toBe(true); // a row with an origin is not
    const batch = (origin: Record<string, string>) => [[{ from_slug: 'a/x', to_slug: 'a/y', link_type: 'knows', link_source: 'markdown', ...origin }]];
    expect(movedOutsideFootprint('addLinksBatch', batch({ origin_slug: 'a/o' }), base, after([row('3')]))).toBe(false);
    expect(movedOutsideFootprint('addLinksBatch', batch({ origin_slug: 'a/o' }), base, after([row('4')]))).toBe(true);
    expect(movedOutsideFootprint('addLinksBatch', batch({}), base, after([row('3')]))).toBe(true);
    expect(movedOutsideFootprint('addLinksBatch', batch({}), base, after([row(null)]))).toBe(false);
    const withOrigin = { sources: [], pages: [A, B, O, P], links: [L, row('3')] };
    expect(movedOutsideFootprint('removeLink', ['a/x', 'a/y', 'knows', 'markdown'], withOrigin, base)).toBe(false); // a removal matches the link whatever its origin
  });

  test('a copy that leaves out a column the Rust store does not keep is not that copy (uncomparable), except the one column the seed always reports', async () => {
    const dir = tmp();
    const withPage = sample({ pre: { sources: [], pages: [{ id: '1', source_id: 'default', slug: 'people/pat-example' }], links: [] } });
    const lossy = fakeComparer(dir, { imported: (rows) => ({ imported: rows, unmapped_columns: ['trust_level'] }) });
    await settle(lossy, [withPage]);
    expect(lossy.counts()).toMatchObject({ comparable: 0, uncomparable: 1, uncomparable_by_reason: { preimage_not_loaded: 1 } });
    const expected = fakeComparer(tmp(), { imported: (rows) => ({ imported: rows, unmapped_columns: ['generation'] }) });
    await settle(expected, [withPage]);
    expect(expected.counts()).toMatchObject({ comparable: 1, uncomparable: 0 });
  });

  test('scratch stores are in the gbrain data home beside shadow/, not in a shared temp directory, and not under the shadow directory', async () => {
    const home = tmp();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const root = scratchRootDefault();
      expect(root).toBe(join(configDir(), 'scratch'));
      expect(root.startsWith(shadowRoot())).toBe(false);
      expect(root.startsWith(tmpdir() + '/') && !root.startsWith(home)).toBe(false);
      expect(dirname(root)).toBe(dirname(shadowRoot()));
    });
  });

  test('every replay runs in a 0700 directory that is gone afterwards, however the replay ends', async () => {
    const scratch = join(tmp(), 'scratch');
    const modes: number[] = [];
    const seen = (path: string): void => { modes.push(statSync(dirname(path)).mode & 0o777); };
    const ends = [fakeComparer(tmp(), { scratchRoot: scratch, connect: async (path) => seen(path) }),
      fakeComparer(tmp(), { scratchRoot: scratch, connect: async (path) => seen(path), put: async () => { throw new Error('refused'); } }),
      fakeComparer(tmp(), { scratchRoot: scratch, connect: async (path) => { seen(path); throw new Error('cannot open'); } })];
    for (const comparer of ends) await settle(comparer, [sample()]);
    expect(modes).toEqual([0o700, 0o700, 0o700]);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(readdirSync(scratch)).toEqual([]);
    expect(ends.map((c) => c.counts().comparable)).toEqual([1, 0, 0]);
    expect(ends.map((c) => c.counts().uncomparable)).toEqual([0, 1, 1]);
  });
});

describe('shadow mode off', () => {
  test('the engine factory hands out the bare engine and no preimage read happens', async () => {
    const home = tmp();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const engine = await createEngine(config);
      await engine.connect(config);
      try {
        await engine.initSchema();
        const watch = watchPreimage(engine);
        await engine.putPage('people/off-example', page('Off Example'));
        await engine.deletePage('people/off-example');
        expect(watch.count()).toBe(0);
        watch.restore();
        expect(existsSync(join(home, '.gbrain', 'shadow'))).toBe(false); // nothing of shadow mode was even created
      } finally { await engine.disconnect(); }
    });
  }, 60_000);
});

describe('every sample the child was sent ends in the tally (sample accounting)', () => {
  const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
  const BASE = { loadAddon: ADDON, capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };
  const replayLine = (n: number) => JSON.stringify({ t: 'write', op: 'putPage', args: encodeArgs([`people/queued-${n}-example`, { type: 'person', title: `Queued ${n}`, compiled_truth: 'Q.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] } }) + '\n';

  test('the child counts what its serving process sent and it never read (the pipe dropped at that process\'s exit) as uncomparable pipe_unflushed, exactly once, and removes the sent count', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      writeFileSync(sentPath(dir, 'sess-1'), JSON.stringify({ session: 'sess-1', sent: 10 }) + '\n');
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-1', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
      input.write('{"t":"write","op":"putPage"}\n{"t":"write","op":"putPage"}\n'); // two samples read
      input.write('{"t":"write","op":"putPage","dropped":2}\n'); // a third, carrying two earlier refusals: three samples' worth
      input.write('{"t":"write","op":"putPage","pad":"cut by the exit of the serving proc'); // a line the exit cut short: not read
      input.end();
      await done;
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 3, send_shed: 2, pipe_unflushed: 10 - 5 });
      expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(3 + 2 + 5);
      expect(existsSync(sentPath(dir, 'sess-1'))).toBe(false);
    });
  }, 30_000);

  async function childWithSent(sent: number, lines: string[], prepare?: (dir: string) => void, sentQualifying?: number) {
    return withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      writeFileSync(sentPath(dir, 'sess-3'), JSON.stringify({ session: 'sess-3', sent, ...(sentQualifying === undefined ? {} : { sent_qualifying: sentQualifying }) }) + '\n');
      prepare?.(dir);
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-3', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
      for (const l of lines) input.write(l);
      input.end();
      await done;
      return { dir, epoch: readEpoch(dir)!.epoch_id };
    });
  }

  test('a lost sample counts against the share only when it was a qualifying write: the rest is booked capability_missing pipe_unflushed_nonqualifying, still counted and visible', async () => {
    const other = '{"t":"write","op":"updatePageContextualRetrievalState","outcome":"capability_missing","family":"pages:updatePageContextualRetrievalState"}\n';
    const { dir, epoch } = await childWithSent(10, ['{"t":"write","op":"putPage"}\n', '{"t":"write","op":"putPage"}\n', other], undefined, 6);
    const t = readWriteTally(dir, epoch)!;
    // 10 sent, 6 of them qualifying; 3 read, 2 of them qualifying: 4 qualifying and 3 other samples were lost.
    expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 2, pipe_unflushed: 4 });
    expect(t.capability_missing_by_family).toMatchObject({ 'pages:updatePageContextualRetrievalState': 1, pipe_unflushed_nonqualifying: 3 });
    expect(t.uncomparable).toBe(6);
    expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(10);
    expect(existsSync(sentPath(dir, 'sess-3'))).toBe(false);
  }, 60_000);

  test('a sent count written before it carried the qualifying count books every lost sample pipe_unflushed, as before (never fewer against the share)', async () => {
    const other = '{"t":"write","op":"updatePageContextualRetrievalState","outcome":"capability_missing","family":"pages:updatePageContextualRetrievalState"}\n';
    const { dir, epoch } = await childWithSent(10, ['{"t":"write","op":"putPage"}\n', other]);
    const t = readWriteTally(dir, epoch)!;
    expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 1, pipe_unflushed: 8 });
    expect(t.capability_missing_by_family.pipe_unflushed_nonqualifying).toBeUndefined();
  }, 60_000);

  test('a deficit larger than 10,000 is counted whole, never cut (20,001 sent, 1 read: 20,000 counted pipe_unflushed)', async () => {
    const { dir, epoch } = await childWithSent(20_001, ['{"t":"write","op":"putPage"}\n']);
    const t = readWriteTally(dir, epoch)!;
    expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 1, pipe_unflushed: 20_000 }); // before: 10,000, and the sent count was removed: 10,000 samples gone
    expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(20_001);
    expect(existsSync(sentPath(dir, 'sess-3'))).toBe(false);
  }, 60_000);

  test('a deficit that cannot be written to the tally is already on disk as lost samples and counted unresolved by status, and the sent count is removed only then (nine samples, blocked tally write)', async () => {
    const { dir, epoch } = await childWithSent(10, ['{"t":"write","op":"putPage"}\n'], (d) => {
      mkdirSync(join(d, `write-comparisons.json.${process.pid}.tmp`)); // the tally cannot be saved by this process
    });
    expect(readWriteTally(dir, epoch)).toBeNull(); // nothing was saved to the tally
    expect(unfoldedLost(dir, epoch)).toBe(9); // before: 0 and the receipt gone, so status read "measured" with the nine missing
    expect(existsSync(sentPath(dir, 'sess-3'))).toBe(true); // was false: the tally save failed, so this child's own outcome was never saved; the sent count stays (the next owner worker books it)
  }, 60_000);

  test('a deficit that cannot be recorded at all (the lost file is not writable) is a fault line naming it, never a silent drop', async () => {
    const { dir } = await childWithSent(10, ['{"t":"write","op":"putPage"}\n'], (d) => { mkdirSync(lostPath(d, process.pid)); });
    expect(readFaults(dir).map((f) => [f.kind, f.detail])).toContainEqual(['write_samples_unrecorded', 'pipe_unflushed n=9']);
  }, 60_000);

  // S2b: a receipt (the sent count) is the only record that samples are missing, so it goes only when the whole deficit is in the lost-sample file.
  const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never;
  const OWNER = () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never;
  const stat = (dir: string) => buildFollowStatus(dir, { sample_rate: 0.1 } as never, NOW).write_comparisons;
  /** A passing tally of 1,000 comparable writes under `epoch`, so only an unsettled receipt can keep status from reading measured. */
  const passing = (dir: string, epoch: string): void => { const f = JSON.parse(readFileSync(writeTallyPath(dir), 'utf8')); writeFileSync(writeTallyPath(dir), JSON.stringify({ ...f, epoch_id: epoch, comparable: 1000 }) + '\n'); };
  const saved = (dir: string, epoch: string): void => writeFileSync(writeTallyPath(dir), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [] }) + '\n');
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!; // a process that has ended
  const receiptFile = (dir: string, session: string): string => sentPath(dir, session);
  async function runChild(dir: string, session: string, lines: string[] = []) {
    const input = new PassThrough();
    const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session, addonSha256: () => 'a'.repeat(64), openEngine: OWNER });
    for (const l of lines) input.write(l);
    input.end();
    await done;
    return readEpoch(dir)!.epoch_id;
  }

  test('both the lost-sample append and the fault line fail (a full disk): the sent count stays on disk and status reads no evidence, never measured', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeFileSync(receiptFile(dir, 'sess-9'), JSON.stringify({ session: 'sess-9', sent: 10 }) + '\n');
      mkdirSync(lostPath(dir, process.pid)); mkdirSync(faultsPath(dir)); // neither can be written (EISDIR stands for ENOSPC)
      const epoch = await runChild(dir, 'sess-9', ['{"t":"write","op":"putPage"}\n']);
      expect(existsSync(receiptFile(dir, 'sess-9'))).toBe(true); // before: removed, and nine samples were in no counter and no fault
      rmSync(lostPath(dir, process.pid), { recursive: true }); rmSync(faultsPath(dir), { recursive: true }); passing(dir, epoch);
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 });
    });
  }, 60_000);

  test('a fault line alone is not a settlement: with the lost-sample file blocked the sent count stays, with its fault line written', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeFileSync(receiptFile(dir, 'sess-9'), JSON.stringify({ session: 'sess-9', sent: 10 }) + '\n');
      mkdirSync(lostPath(dir, process.pid));
      const epoch = await runChild(dir, 'sess-9', ['{"t":"write","op":"putPage"}\n']);
      expect(readFaults(dir).map((f) => [f.kind, f.detail])).toContainEqual(['write_samples_unrecorded', 'pipe_unflushed n=9']);
      expect(existsSync(receiptFile(dir, 'sess-9'))).toBe(true); // before: removed because the fault line landed, and status read measured
      rmSync(lostPath(dir, process.pid), { recursive: true }); passing(dir, epoch);
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 });
    });
  }, 60_000);

  for (const [what, make] of [['truncated', (f: string) => writeFileSync(f, '{"session":"sess-8","sent":1')], ['unreadable (EISDIR stands for EIO)', (f: string) => mkdirSync(f)], ['a negative number', (f: string) => writeFileSync(f, JSON.stringify({ session: 'sess-8', sent: -4 }))]] as const) {
    test(`a sent count that is ${what}: raises one write_samples_unrecorded fault, is left in place, and status reads no evidence`, async () => {
      await withEnv({ GBRAIN_HOME: tmp() }, async () => {
        const dir = tmp(); writeSeedRecord(dir, SEED);
        make(receiptFile(dir, 'sess-8'));
        const epoch = await runChild(dir, 'sess-8', ['{"t":"write","op":"putPage"}\n']);
        expect(readFaults(dir).filter((f) => f.kind === 'write_samples_unrecorded')).toHaveLength(1); // before: none, the child read it as no count
        expect(existsSync(receiptFile(dir, 'sess-8'))).toBe(true);
        passing(dir, epoch);
        const s = stat(dir);
        expect(s).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 });
        expect(s.outstanding_receipts).toEqual([basename(receiptFile(dir, 'sess-8'))]);
      });
    }, 60_000);
  }

  test('status counts a receipt of the current epoch, of no epoch and of another epoch as unresolved and names it; with no directory nothing is counted', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); saved(dir, epoch);
    expect(stat(dir)).toMatchObject({ state: 'measured', comparable: 1000 });
    writeFileSync(receiptFile(dir, 'now'), JSON.stringify({ session: 'now', sent: 3, pid: process.pid, epoch_id: epoch }));
    writeFileSync(receiptFile(dir, 'bare'), JSON.stringify({ session: 'bare', sent: 3, pid: process.pid }));
    writeFileSync(receiptFile(dir, 'old'), JSON.stringify({ session: 'old', sent: 3, pid: process.pid, epoch_id: 'a-retired-epoch' }));
    const s = stat(dir);
    expect(s).toMatchObject({ state: 'capability_missing', unresolved_replays: 3 }); // was 2: the receipt of another epoch was left out
    expect([...(s.outstanding_receipts ?? [])].sort()).toEqual(['bare', 'now', 'old'].map((n) => basename(receiptFile(dir, n))).sort()); // was bare and now only
    expect((s as Record<string, unknown>).retired_receipts).toBeUndefined(); // was [old]: there is no longer a list of receipts status does not count
    rmSync(receiptFile(dir, 'now')); rmSync(receiptFile(dir, 'bare'));
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 }); // was measured with no unresolved: a receipt of another epoch is a deficit nobody recorded, so it keeps status at no evidence
    expect(() => stat(join(dir, 'gone'))).not.toThrow();
    expect(stat(join(dir, 'gone')).unresolved_replays).toBeUndefined();
  });

  test('a worker\'s own receipt is its own samples whatever epoch it names: a fresh command\'s receipt that names the previous epoch is booked under the new one, never dropped', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeFileSync(receiptFile(dir, 'sess-7'), JSON.stringify({ session: 'sess-7', sent: 10, pid: process.pid, epoch_id: 'the-previous-epoch' }));
      const epoch = await runChild(dir, 'sess-7', ['{"t":"write","op":"putPage"}\n']);
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_sample: 1, pipe_unflushed: 9 }); // before: removed as another epoch\'s, nothing booked (10 sent, 1 delivered)
      expect(existsSync(receiptFile(dir, 'sess-7'))).toBe(false);
    });
  }, 60_000);

  test('a retired worker (its epoch is no longer the manifest\'s) settles nothing and removes no receipt; the current owner settles it whole', () => {
    for (const stamped of [false, true]) {
      const dir = tmp(); const old = tallyOn(dir); // epoch 1
      const fields = { seed_id: 's', rust_addon_sha256: 'b', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' };
      const next = ensureEpoch(dir, fields, NOW.getTime() + 60_000).epoch_id; // the manifest moves to epoch 2
      expect(next).not.toBe(old.epoch);
      writeFileSync(receiptFile(dir, 'dead'), JSON.stringify({ session: 'dead', sent: 7, pid: deadPid(), ...(stamped ? { epoch_id: next } : {}) }));
      old.tally.save(); old.tally.recover();
      expect(existsSync(receiptFile(dir, 'dead'))).toBe(true); // before: removed, with its lines booked under epoch 1 where nobody reads them
      const owner = new WriteTally(dir, () => next, () => true, process.pid);
      owner.recover(); owner.save();
      expect(readWriteTally(dir, next)!.uncomparable_by_reason).toEqual({ receipt_orphaned: 7 });
      expect(existsSync(receiptFile(dir, 'dead'))).toBe(false);
    }
  });

  test('a receipt a dead session left is settled exactly once by an owner worker (receipt_orphaned); a live pid, a pid we cannot trust and a count we cannot trust are left alone', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      const put = (session: string, body: Record<string, unknown>, ageMs = 0): void => { const f = receiptFile(dir, session); writeFileSync(f, JSON.stringify({ session, ...body })); if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(f, t, t); } };
      put('dead', { sent: 7, pid: deadPid() });
      put('recycled', { sent: 2, pid: process.ppid }, 20 * 60_000); // its pid is alive but the file is old: the pid was reused
      put('live', { sent: 50, pid: process.ppid }); // a running worker's own receipt
      put('nopid', { sent: 50 }); // cannot tell yet: fresh
      put('hostile', { sent: 50, pid: -1 }); put('hostile2', { sent: 50, pid: 0 }); put('hostile3', { sent: 50, pid: 1.5 }); // not a pid
      put('huge', { sent: 5_000_000_000, pid: deadPid() }); // not a count we can write down
      const epoch = await runChild(dir, 'sess-a');
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toEqual({ receipt_orphaned: 9 }); // before: nothing settled, every receipt left for ever
      expect(readdirSync(dir).filter((n) => n.startsWith('write-sent.')).sort()).toEqual(['hostile', 'hostile2', 'hostile3', 'huge', 'live', 'nopid'].map((n) => basename(receiptFile(dir, n))).sort());
      expect(await runChild(dir, 'sess-b')).toBe(epoch);
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toEqual({ receipt_orphaned: 9 }); // once: the second owner finds nothing to add
    });
  }, 60_000);

  test('a sent count stays when this child\'s final tally save failed (an outcome only in memory), and status reads no evidence, never measured', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      const epoch = await runChild(dir, 'warmup'); saved(dir, epoch); // a passing tally of 1,000 comparable writes
      writeFileSync(receiptFile(dir, 'pending'), JSON.stringify({ session: 'pending', sent: 1 }));
      mkdirSync(`${writeTallyPath(dir)}.${process.pid}.tmp`); // this child cannot save its tally
      await runChild(dir, 'pending', [JSON.stringify({ t: 'write', op: 'putPage', outcome: 'uncomparable', reason: 'preimage_timeout' }) + '\n']); // sent 1, received 1: no deficit, one outcome that stays in memory
      expect(existsSync(receiptFile(dir, 'pending'))).toBe(true); // before: removed (sent == received), and the outcome was lost with status still measured
      expect(readWriteTally(dir, epoch)!.uncomparable).toBe(0);
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_receipts: [basename(receiptFile(dir, 'pending'))] });
    });
  }, 60_000);

  test('a client worker whose lost-sample write failed keeps its count and status reads no evidence, even though its fault line was written; the count is written down at the next save', () => {
    const dir = tmp(); const { tally, epoch } = tallyOn(dir); saved(dir, epoch); // an epoch and a passing tally of 1,000 comparable writes
    const client = new WriteTally(dir, () => null, () => true, process.pid); // another process owns the store
    for (let i = 0; i < 3; i++) client.note('uncomparable', 'preimage_timeout');
    mkdirSync(lostPath(dir, process.pid)); // the lost-sample file cannot be written
    expect(client.save()).toBe(false);
    expect(readFaults(dir).map((f) => [f.kind, f.detail])).toContainEqual(['write_samples_unrecorded', 'no_epoch n=3']);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unrecorded_sample_faults: 1 }); // before: measured, the fault line was ignored
    expect(client.save()).toBe(false); expect(readFaults(dir).filter((f) => f.kind === 'write_samples_unrecorded')).toHaveLength(1); // one fault line for the same count
    rmSync(lostPath(dir, process.pid), { recursive: true }); // the disk recovers
    expect(client.save()).toBe(true);
    expect(unfoldedLost(dir, epoch)).toBe(3); // before: 0, the count was cleared by the fault line and never written down
    tally.save(); // the owner folds the three lost samples into the tally
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_epoch: 3 });
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unrecorded_sample_faults: 1 }); // nothing else is open, but the fault of this epoch still blocks measured (a new epoch clears it)
  });

  test('an orphaned receipt keeps status at no evidence until an owner worker settles it as receipt_orphaned (uncomparable); then the receipt is gone and the unresolved mark clears', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      const epoch = await runChild(dir, 'sess-a'); saved(dir, epoch); // a passing tally of 1,000 comparable writes under the current epoch
      writeFileSync(receiptFile(dir, 'dead'), JSON.stringify({ session: 'dead', sent: 7, pid: deadPid() })); // a command that died: its receipt is nobody's
      const before = stat(dir);
      expect(before).toMatchObject({ state: 'capability_missing', comparable: 1000, unresolved_replays: 1, outstanding_receipts: [basename(receiptFile(dir, 'dead'))] }); // not measured while seven samples are unaccounted for
      expect(readWriteTally(dir, epoch)!.uncomparable).toBe(0);
      expect(await runChild(dir, 'sess-b')).toBe(epoch); // the next owner worker settles it
      const t = readWriteTally(dir, epoch)!;
      expect(t.uncomparable_by_reason).toEqual({ receipt_orphaned: 7 });
      expect(t).toMatchObject({ comparable: 1000, uncomparable: 7 }); // booked uncomparable, never compared
      expect(existsSync(receiptFile(dir, 'dead'))).toBe(false);
      const after = stat(dir);
      expect(after.unresolved_replays).toBeUndefined();
      expect(after.outstanding_receipts).toBeUndefined();
      expect(after).toMatchObject({ state: 'measured', comparable: 1000, uncomparable: 7 }); // every deficit is now recorded
    });
  }, 60_000);

  test('a receipt that names another epoch keeps status at no evidence, then is settled as receipt_orphaned (uncomparable), never compared', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      const epoch = await runChild(dir, 'sess-a'); saved(dir, epoch); // a passing tally of 1,000 comparable writes
      writeFileSync(receiptFile(dir, 'dead'), JSON.stringify({ session: 'dead', sent: 7, pid: deadPid(), epoch_id: 'a-retired-epoch' }));
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_receipts: [basename(receiptFile(dir, 'dead'))] }); // before: measured, the receipt was listed as retired and not counted
      expect(await runChild(dir, 'sess-b')).toBe(epoch);
      expect(readWriteTally(dir, epoch)!).toMatchObject({ comparable: 1000, uncomparable: 7, uncomparable_by_reason: { receipt_orphaned: 7 } });
      expect(existsSync(receiptFile(dir, 'dead'))).toBe(false);
      expect(stat(dir)).toMatchObject({ state: 'measured', comparable: 1000, uncomparable: 7 }); // measured only once every deficit is recorded
    });
  }, 60_000);

  test('a leftover receipt that names another epoch is settled by the next owner worker as receipt_orphaned like any other', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeFileSync(receiptFile(dir, 'dead'), JSON.stringify({ session: 'dead', sent: 7, pid: deadPid(), epoch_id: 'a-retired-epoch' }));
      const epoch = await runChild(dir, 'sess-a');
      expect(readWriteTally(dir, epoch)?.uncomparable_by_reason ?? {}).toEqual({ receipt_orphaned: 7 }); // was {}: it was removed with no count
      expect(existsSync(receiptFile(dir, 'dead'))).toBe(false);
    });
  }, 60_000);

  test('no sent count, or one that is not more than what was read, adds nothing', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      for (const sent of [undefined, 2, 'bad'] as const) {
        const dir = tmp();
        writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
        if (sent !== undefined) writeFileSync(sentPath(dir, 'sess-2'), JSON.stringify({ session: 'sess-2', sent }) + '\n');
        const input = new PassThrough();
        const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-2', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
        input.write('{"t":"write","op":"putPage"}\n{"t":"write","op":"putPage"}\n'); input.end();
        await done;
        expect(readWriteTally(dir, readEpoch(dir)!.epoch_id)!.uncomparable_by_reason).toEqual({ no_sample: 2 });
      }
    });
  }, 30_000);

  test('a burst of 300 samples behind one stuck replay: 256 wait their turn, the other 44 are counted queue_full, and every one of the 300 ends in the tally (never comparable when shed)', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      const input = new PassThrough();
      let exitCode = null as number | null;
      void runShadowChild(dir, {
        input, writeControl: () => {}, ...BASE, addonSha256: () => 'a'.repeat(64),
        openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {}, storeFor: () => new Promise(() => {}) }) as never,
        exitDeadlineMs: 300, exit: (code) => { exitCode = code; },
      });
      for (let n = 0; n < 300; n++) input.write(replayLine(n));
      input.end();
      const until = Date.now() + 10_000;
      while (exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(exitCode).toBe(0);
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      expect(t.uncomparable_by_reason.queue_full).toBe(44); // master: 16 wait, 284 are shed
      expect(t.uncomparable_by_reason.child_exit_deadline).toBe(255); // the 255 behind the stuck replay are counted at the exit deadline
      expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing + t.in_flight.length).toBe(300);
      expect(t.comparable).toBe(0);
    });
  }, 30_000);

  test('a queue that is full by bytes, not by count, sheds the next sample queue_full and gives the bytes back when the replays end', async () => {
    const dir = tmp(); let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const comparer = fakeComparer(dir, { connect: () => gate });
    const sample = (n: number): WriteEvent => ({ t: 'write', op: 'putPage', args: encodeArgs([`people/bytes-${n}-example`, { type: 'person', title: 'B', compiled_truth: 'B.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] } });
    const MIB = 1024 * 1024;
    for (let n = 0; n < 3; n++) comparer.handle(sample(n), 7 * MIB); // 7 + 7 fit in 16 MiB, the third would be 21
    release();
    await comparer.idle();
    expect(comparer.counts().uncomparable_by_reason.queue_full).toBe(1);
    for (let n = 3; n < 5; n++) comparer.handle(sample(n), 7 * MIB); // the bytes came back
    await comparer.idle();
    expect(comparer.counts().uncomparable_by_reason.queue_full).toBe(1);
    const t = comparer.counts();
    expect(t.comparable + t.unexplained_difference + t.uncomparable).toBe(5);
  }, 30_000);

  test('a child that reaches its exit deadline with replays still queued counts them (uncomparable, named), never drops them uncounted', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      const input = new PassThrough();
      let exitCode = null as number | null;
      // The scratch store of the first replay never opens (a slow or stuck replay); the next two wait behind it in the child's queue.
      void runShadowChild(dir, {
        input, writeControl: () => {}, ...BASE, addonSha256: () => 'a'.repeat(64),
        openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {}, storeFor: () => new Promise(() => {}) }) as never,
        exitDeadlineMs: 300, exit: (code) => { exitCode = code; },
      });
      for (let n = 0; n < 3; n++) input.write(replayLine(n));
      input.end(); // the serving process disconnects
      const until = Date.now() + 10_000;
      while (exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(exitCode).toBe(0);
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      // The stuck replay keeps its in-flight mark (the next child counts it unexplained); the two queued behind it must be counted too.
      expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing + t.in_flight.length).toBe(3);
      expect(t.comparable).toBe(0);
    });
  }, 30_000);
});
