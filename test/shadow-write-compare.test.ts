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
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
import { ensureEpoch, epochPath, readEpoch, withLock } from '../src/shadow/evidence-epoch.ts';
import { buildFollowStatus, renderFollowStatus } from '../src/shadow/follow-status.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { configDir } from '../src/core/config.ts';
import { shadowRoot } from '../src/shadow/state.ts';
import { scratchRootDefault } from '../src/shadow/write-compare-child.ts';
import { faultsPath, readFaults } from '../src/shadow/ledger.ts';
import { sampleWeight } from '../src/shadow/supervisor.ts';
import { createWriteSampler } from '../src/shadow/write-capture.ts';
import { droppedWeight, MAX_DROPPED, lostPath, movedOutsideFootprint, owedPath, pageRefs, readOwed, readWriteSnapshot, readWriteTally, recordLost, sentPath, sessionKey, unfoldedLost, unfoldedLines, writeOwed, writeTallyPath, WriteTally, SAVE_FAILURE_EXIT_MS, type OwedRecord, type WriteEvent } from '../src/shadow/write-compare.ts';
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
    writeFileSync(lostPath(dir, dead), `{"epoch_id":"${epoch}","reason":"send_shed","session":""}\n{"epoch_id":`); // S2c: a line names its session (here none: the serving process's own loss, which settles nothing); a line with no session key is an older writer's (legacy_lines)
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
    expect([...sizes]).toEqual([0]); // was: at most 4 sizes (one append per 256 verdicts); now nothing is appended until the 2 s flush or a save: never one durable write per verdict
    client.save();
    expect(readFileSync(writeTallyPath(dir), 'utf8')).toBe(before); // a client child records nothing in the tally
    expect(unfoldedLost(dir, owner.epoch)).toBe(600);
    owner.tally.save(); // the owner folds them in
    expect(owner.counts()).toMatchObject({ comparable: 0, capability_missing: 1, uncomparable: 600, uncomparable_by_reason: { no_epoch: 600 } });
  });

  // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
  test('a client\'s pending verdicts plus a large count are all kept across the 10,000-line append cap: only what was written is released (255 + 10,000 = 10,255 counted)', () => {
    const dir = tmp();
    const owner = tallyOn(dir);
    const client = new WriteTally(dir, () => null, () => true, 424242);
    client.note('uncomparable', 'send_shed', 255); client.note('uncomparable', 'send_shed', 10_000);
    client.save();
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 an unrelated 10 (a count, limit or size), not the adapter version
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
    expect(readFaults(dir)).toEqual([]); // was: a write_samples_unrecorded fault `no_epoch n=300`; no fault line is the proof any more: the count is held (and a session it settles stays owed)
    rmSync(lostPath(dir, process.pid), { recursive: true }); expect(client.save()).toBe(true); // the held count is written once the file can be
  });

  test('with no epoch on disk yet nothing can be recorded: the count waits for the next save, and the last one leaves a fault line, never a silent drop; a deleted shadow directory counts nothing', () => {
    const dir = tmp();
    const client = new WriteTally(dir, () => null, () => true, 424242);
    client.note('uncomparable', 'moved', 3);
    expect(client.save()).toBe(false);
    expect(readFaults(dir)).toEqual([]); // was: one write_samples_unrecorded fault at the last save; the count is held, never a fault line standing for it
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

  /** The record a serving process leaves for a session: `owed` samples accepted, closed or not. */
  const owe = (dir: string, session: string, owed: number, over: Partial<OwedRecord> = {}): void => writeOwed(dir, { v: 1, session, serving_pid: process.pid, owed, closed: true, child_exited: false, ...over });

  test('the child books what its serving process owed and it never read (the pipe dropped at that process\'s exit) as uncomparable pipe_unflushed, exactly once, settles every sample, and removes the owed file', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      writeOwed(dir, { v: 1, session: 'sess-1', serving_pid: process.pid, owed: 10, closed: true, child_exited: false });
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-1', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
      input.write('{"t":"write","op":"putPage"}\n{"t":"write","op":"putPage"}\n'); // two samples read
      input.write('{"t":"write","op":"putPage","dropped":2}\n'); // a third, carrying two earlier refusals: three samples' worth
      input.write('{"t":"write","op":"putPage","pad":"cut by the exit of the serving proc'); // a line the exit cut short: it stands for one sample, unreadable
      input.end();
      await done;
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 3, send_shed: 2, line_unreadable: 1, pipe_unflushed: 10 - 6 }); // was pipe_unflushed 5: the cut-short line was not read and was booked with the pipe's loss; now it is read, unreadable, and settled as such
      expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(3 + 2 + 1 + 4);
      expect(t.settled).toEqual({ 'sess-1': 10 }); // every owed sample is settled, once
      expect(existsSync(owedPath(dir, 'sess-1'))).toBe(false); // was: the sent count (receipt) was removed
    });
  }, 30_000);

  async function childWithOwed(owed: number, lines: string[], prepare?: (dir: string) => void, over: Partial<OwedRecord> = {}) {
    return withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp();
      writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
      writeOwed(dir, { v: 1, session: 'sess-3', serving_pid: process.pid, owed, closed: true, child_exited: false, ...over });
      prepare?.(dir);
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-3', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
      for (const l of lines) input.write(l);
      input.end();
      await done;
      return { dir, epoch: readEpoch(dir)!.epoch_id };
    });
  }

  test('a deficit larger than 10,000 is counted whole, never cut (20,001 owed, 1 read: 20,000 counted pipe_unflushed)', async () => {
    const { dir, epoch } = await childWithOwed(20_001, ['{"t":"write","op":"putPage"}\n']);
    const t = readWriteTally(dir, epoch)!;
    expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 1, pipe_unflushed: 20_000 });
    expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(20_001);
    expect(t.settled).toEqual({ 'sess-3': 20_001 });
    expect(existsSync(owedPath(dir, 'sess-3'))).toBe(false);
  }, 60_000);

  test('a deficit that cannot be saved (blocked tally write) leaves the owed file, and status reads the session as outstanding: no evidence, never measured', async () => {
    const { dir, epoch } = await childWithOwed(10, ['{"t":"write","op":"putPage"}\n'], (d) => {
      mkdirSync(join(d, `write-comparisons.json.${process.pid}.tmp`)); // the tally cannot be saved by this process
    });
    expect(readWriteTally(dir, epoch)).toBeNull(); // nothing was saved to the tally
    expect(unfoldedLost(dir, epoch)).toBe(0); // was 9: the deficit was appended as lost lines at once; now it is one more outcome in the same save as its settlement, so a lost save loses both
    expect(existsSync(owedPath(dir, 'sess-3'))).toBe(true); // the owed file stays: the next owner worker books what was never settled
    rmSync(join(dir, `write-comparisons.json.${process.pid}.tmp`), { recursive: true }); saved(dir, epoch);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.sess-3.json'] });
  }, 60_000);

  test('a deficit that cannot be recorded at all leaves no fault line standing for it: the owed file stays and status reads the session as outstanding', async () => {
    const { dir, epoch } = await childWithOwed(10, ['{"t":"write","op":"putPage"}\n'], (d) => { mkdirSync(`${writeTallyPath(d)}.${process.pid}.tmp`); mkdirSync(faultsPath(d)); }); // neither the tally nor the fault ledger can be written (EISDIR stands for ENOSPC)
    expect(existsSync(faultsPath(dir)) && statSync(faultsPath(dir)).isDirectory()).toBe(true); // no fault line was written (was: a write_samples_unrecorded fault `pipe_unflushed n=9` stood for the deficit)
    expect(existsSync(owedPath(dir, 'sess-3'))).toBe(true);
    rmSync(`${writeTallyPath(dir)}.${process.pid}.tmp`, { recursive: true }); rmSync(faultsPath(dir), { recursive: true }); saved(dir, epoch);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 });
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

  test('a closed owed file that was never closed (the serving process died before it could) stays: only an orphan rule settles it', async () => {
    const { dir } = await childWithOwed(2, ['{"t":"write","op":"putPage"}\n', '{"t":"write","op":"putPage"}\n'], undefined, { closed: false });
    expect(existsSync(owedPath(dir, 'sess-3'))).toBe(true); // everything was settled, but the file is not closed: this child leaves it for the owner pass
    expect(readWriteTally(dir, readEpoch(dir)!.epoch_id)!.settled).toEqual({ 'sess-3': 2 });
  }, 60_000);

  for (const [what, make] of [['truncated', (f: string) => writeFileSync(f, '{"v":1,"session":"sess-8","owed":1')], ['unreadable (EISDIR stands for EIO)', (f: string) => mkdirSync(f)], ['a negative number', (f: string) => writeFileSync(f, JSON.stringify({ v: 1, session: 'sess-8', serving_pid: 1, owed: -4, closed: true, child_exited: false }))]] as const) {
    test(`an owed file that is ${what} is left in place and status reads no evidence (no fault line stands for it)`, async () => {
      await withEnv({ GBRAIN_HOME: tmp() }, async () => {
        const dir = tmp(); writeSeedRecord(dir, SEED);
        make(owedPath(dir, 'sess-8'));
        const epoch = await runChild(dir, 'sess-8', ['{"t":"write","op":"putPage"}\n']);
        expect(readFaults(dir).filter((f) => f.kind === 'write_samples_unrecorded')).toHaveLength(0); // was one fault for an unreadable sent count
        expect(existsSync(owedPath(dir, 'sess-8'))).toBe(true);
        passing(dir, epoch);
        expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.sess-8.json'] });
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

  test('a legacy receipt of this worker\'s own session is no longer read by the worker at the end of its input: it stays, status reads it as no evidence, and an owner pass settles it once its pid is gone', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeFileSync(receiptFile(dir, 'sess-7'), JSON.stringify({ session: 'sess-7', sent: 10, pid: deadPid(), epoch_id: 'the-previous-epoch' }));
      const epoch = await runChild(dir, 'sess-7', ['{"t":"write","op":"putPage"}\n']);
      // was: removed as this worker's own, booked pipe_unflushed 9; the worker keeps no receipt of its own any more (the owed file replaced it), so an older version's receipt is an ordinary leftover
      expect(existsSync(receiptFile(dir, 'sess-7'))).toBe(false); // settled by the pass at start (its pid is dead): the whole sent count, once
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_sample: 1, receipt_orphaned: 10 });
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

  test('an owed file stays when this child\'s final tally save failed (an outcome only in memory), and status reads no evidence, never measured', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      const epoch = await runChild(dir, 'warmup'); saved(dir, epoch); // a passing tally of 1,000 comparable writes
      owe(dir, 'pending', 1);
      mkdirSync(`${writeTallyPath(dir)}.${process.pid}.tmp`); // this child cannot save its tally
      await runChild(dir, 'pending', [JSON.stringify({ t: 'write', op: 'putPage', outcome: 'uncomparable', reason: 'preimage_timeout' }) + '\n']); // owed 1, received 1: no deficit, one outcome that stays in memory
      expect(existsSync(owedPath(dir, 'pending'))).toBe(true); // the sample was never settled in a save, so the obligation stays
      expect(readWriteTally(dir, epoch)!.uncomparable).toBe(0);
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.pending.json'] });
    });
  }, 60_000);

  test('a client worker whose lost-sample write failed keeps its count and its session stays owed: status reads no evidence, no fault line stands for it; the count is written down at the next save', () => {
    const dir = tmp(); const { tally, epoch } = tallyOn(dir); saved(dir, epoch); // an epoch and a passing tally of 1,000 comparable writes
    owe(dir, 'sess-c', 3);
    const client = new WriteTally(dir, () => null, () => true, process.pid, 'sess-c'); // another process owns the store
    for (let i = 0; i < 3; i++) client.note('uncomparable', 'preimage_timeout', 1, false, 1);
    mkdirSync(lostPath(dir, process.pid)); // the lost-sample file cannot be written
    expect(client.save()).toBe(false);
    expect(readFaults(dir)).toEqual([]); // was: a write_samples_unrecorded fault `no_epoch n=3`
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 2, outstanding_sessions: ['write-owed.sess-c.json'] }); // the owed session, and the lost-sample file that cannot be read (was: unrecorded_sample_faults 1)
    rmSync(lostPath(dir, process.pid), { recursive: true }); // the disk recovers
    expect(client.save()).toBe(true);
    expect(unfoldedLost(dir, epoch)).toBe(3);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 3 }); // written, not folded yet: three lost samples no tally has taken
    tally.save(); // the owner folds the three lost samples into the tally, and their credit
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_epoch: 3 });
    expect(readWriteTally(dir, epoch)!.settled).toEqual({ 'sess-c': 3 });
    expect(stat(dir)).toMatchObject({ state: 'measured' }); // was capability_missing for the rest of the epoch (the fault line stayed)
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

// ---- S2c: a durable per-session obligation for write samples (design: the supervisor owes, the child settles) ----
describe('S2c: a durable per-session obligation for write samples', () => {
  const STATE = { sample_rate: 0.1 } as never;
  const stat = (dir: string) => buildFollowStatus(dir, STATE, NOW).write_comparisons;
  const INPUTS = { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as const;
  const epochOf = (dir: string): string => ensureEpoch(dir, INPUTS, NOW.getTime()).epoch_id;
  const owe = (dir: string, session: string, owed: number, over: Partial<OwedRecord> = {}): void => writeOwed(dir, { v: 1, session, serving_pid: process.pid, owed, closed: false, child_exited: false, ...over });
  const tallyFile = (epoch: string, extra: Record<string, unknown> = {}) => ({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [], ...extra });
  /** A passing tally of 1,000 comparable writes, so only an unsettled obligation can keep status from reading measured. */
  const passing = (dir: string, epoch: string, extra: Record<string, unknown> = {}): void => writeFileSync(writeTallyPath(dir), JSON.stringify(tallyFile(epoch, extra)) + '\n');
  const worker = (dir: string, epoch: string, session: string, pid = process.pid, now?: () => number): WriteTally => new WriteTally(dir, () => epoch, () => true, pid, session, now);
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;
  const put = (over: Partial<WriteEvent> = {}): WriteEvent => ({ t: 'write', op: 'putPage', args: encodeArgs(['people/pat-example', { type: 'person', title: 'Pat', compiled_truth: 'Pat.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over });
  const settledOf = (dir: string, epoch: string, session: string): number | undefined => readWriteTally(dir, epoch)?.settled?.[session];

  // A-G: each gap the S2b review named, as a failing test on the S2b head.
  test('A: a sample owed before any epoch exists (a cold start) still blocks measured: the obligation has no epoch and no timestamp filter', () => {
    const dir = tmp(); owe(dir, 'cold', 2);
    utimesSync(owedPath(dir, 'cold'), new Date('2020-01-01'), new Date('2020-01-01')); // written long before the epoch opened
    const epoch = epochOf(dir); passing(dir, epoch);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.cold.json'] });
  });

  test('B: a save that landed but whose directory flush failed is not reported saved at the next try until it is flushed (the early return flushes the file and the directory)', async () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'sb', 1, { closed: true });
    const durable = await import('../src/core/fs-durable.ts');
    const w = worker(dir, epoch, 'sb');
    const dirFlush = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    w.note('comparable', undefined, 1, false, 1); // renamed, then the directory flush failed
    dirFlush.mockRestore();
    expect(readWriteTally(dir, epoch)!.comparable).toBe(1001); // it landed
    const fileFlush = spyOn(durable, 'flushFile').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(w.save()).toBe(false); // was true: nothing was left to add, so the retry returned without flushing anything
    fileFlush.mockRestore();
    expect(w.save()).toBe(true);
    expect(settledOf(dir, epoch, 'sb')).toBe(1);
  });

  test('C: no fault line is on the measured path: a deficit nothing can record leaves no write_samples_unrecorded fault, and status blocks on the owed session instead', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'sc', 3);
    mkdirSync(lostPath(dir, process.pid)); // lost lines cannot be written; the owned tally cannot be saved either
    const w = new WriteTally(dir, () => null, () => true, process.pid, 'sc');
    w.note('uncomparable', 'moved', 3, false, 3); w.save();
    expect(existsSync(faultsPath(dir))).toBe(false);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', outstanding_sessions: ['write-owed.sc.json'] });
  });

  test('C: the owed record is flushed (file, then directory) before it can be used: a failed flush throws and leaves no half-published record', async () => {
    const dir = tmp(); const durable = await import('../src/core/fs-durable.ts');
    const file = spyOn(durable, 'flushFile').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(() => owe(dir, 'sf', 1)).toThrow(); file.mockRestore();
    expect(existsSync(owedPath(dir, 'sf'))).toBe(false); // the rename comes after the file flush
    const directory = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(() => owe(dir, 'sf', 1)).toThrow(); directory.mockRestore(); // renamed, directory entry not known durable: the caller must not treat it as written
    expect(() => owe(dir, 'sf', 1)).not.toThrow();
  });

  test('D: a client worker that dies with buffered verdicts credits none of them: its session stays owed, and the next owner books the whole deficit once as receipt_orphaned', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    const dead = deadPid(); owe(dir, 'sd', 3, { child_pid: dead });
    const client = new WriteTally(dir, () => null, () => true, dead, 'sd');
    client.note('uncomparable', 'moved', 2, false, 2); // two verdicts buffered, never flushed: the worker dies here
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', outstanding_sessions: ['write-owed.sd.json'] });
    const owner = worker(dir, epoch, 'owner-session'); owner.recover(); // its child is not running: orphaned
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 3 });
    expect(existsSync(owedPath(dir, 'sd'))).toBe(false);
    expect(stat(dir)).toMatchObject({ state: 'measured' });
    owner.save(); owner.save(); worker(dir, epoch, 'another').recover(); // booked once, however many owners look
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason.receipt_orphaned).toBe(3);
  });

  test('E: an owed file that cannot be parsed blocks measured, and a torn fault line cannot hide it (faults are not what status trusts)', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    writeFileSync(owedPath(dir, 'se'), '{"v":1,"session":"se","owed":4,"serv'); // torn
    writeFileSync(faultsPath(dir), '{"ts":"2026-01-01T00:00:00Z","kind":"write_sam'); // a torn fault tail
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.se.json'] });
  });

  test('F: a live worker whose saves fail blocks only its own session; after 60 s of failing saves it asks to exit, and the next owner settles what it never saved', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    owe(dir, 'sf-live', 2, { child_pid: process.pid }); owe(dir, 'sf-other', 1); passing(dir, epoch, { settled: { 'sf-other': 1 } });
    let clock = 1_000_000; const w = worker(dir, epoch, 'sf-live', process.pid, () => clock);
    mkdirSync(`${writeTallyPath(dir)}.${process.pid}.tmp`); // every save of this child fails
    w.note('comparable', undefined, 1, false, 1);
    expect(w.stuckMs()).toBe(0); clock += 59_000; expect(w.save()).toBe(false);
    expect(w.stuckMs()).toBe(59_000);
    expect(stat(dir).outstanding_sessions).toEqual(['write-owed.sf-live.json']); // only the session that holds unsaved results is held; the other is settled
    clock += 2_000; w.save();
    expect(w.stuckMs()).toBeGreaterThanOrEqual(SAVE_FAILURE_EXIT_MS);
    rmSync(`${writeTallyPath(dir)}.${process.pid}.tmp`, { recursive: true }); expect(w.save()).toBe(true); expect(w.stuckMs()).toBe(0); // a save that lands ends the failure
  });

  test('G: a worker that dies with results it never saved: its session is booked once by the next owner, and the replay it was running keeps its mark and counts unexplained', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    const dead = deadPid(); owe(dir, 'sg', 4, { child_pid: dead, child_exited: true });
    passing(dir, epoch, { in_flight: [dead], settled: { sg: 1 } }); // one sample settled, one replay running when it died, two never reached it
    const owner = worker(dir, epoch, 'owner-session'); owner.recover();
    const t = readWriteTally(dir, epoch)!;
    expect(t.unexplained_difference).toBe(1); // the dead replay could have been a mismatch
    expect(t.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 3 }); // owed 4 less settled 1: the in-flight sample is counted twice (once unexplained, once here), never fewer
    expect(t.in_flight).toEqual([]);
    expect(existsSync(owedPath(dir, 'sg'))).toBe(false);
  });

  // The hard limit and the per-session rule.
  test('a long-running session with nothing unsettled reads measured, however many samples it has owed', () => {
    const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'long', 1_000_000, { child_pid: process.pid });
    passing(dir, epoch, { settled: { long: 1_000_000 } });
    expect(stat(dir)).toMatchObject({ state: 'measured' });
    expect(stat(dir).unresolved_replays).toBeUndefined();
  });

  test('an open session blocks only while one of its own samples is unsettled, and a settled one blocks nothing', () => {
    const dir = tmp(); const epoch = epochOf(dir);
    owe(dir, 'a', 5); owe(dir, 'b', 3);
    passing(dir, epoch, { settled: { a: 5, b: 2 } });
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-owed.b.json'] });
    passing(dir, epoch, { settled: { a: 5, b: 3 } });
    expect(stat(dir)).toMatchObject({ state: 'measured' });
    owe(dir, 'b', 4); // one more sample owed: the session blocks again
    expect(stat(dir).outstanding_sessions).toEqual(['write-owed.b.json']);
  });

  test('the status read order is tally, lost lines, owed files, then the tally again: a settlement that lands between the reads is read, never hidden, and a deleted owed file cannot show an old tally as measured', () => {
    const dir = tmp(); const epoch = epochOf(dir);
    owe(dir, 's', 1, { closed: true }); passing(dir, epoch); // the tally read first has no mismatch, and the session is owed one sample
    let seen: string[] = [];
    const snap = readWriteSnapshot(dir, epoch, (stage) => {
      seen.push(stage);
      if (stage === 'owed' && seen.filter((x) => x === 'owed').length === 1) { // the child replays the sample, saves a mismatch with the settlement, and removes the owed file, all between the reads
        passing(dir, epoch, { unexplained_difference: 1, settled: { s: 1 } }); rmSync(owedPath(dir, 's'));
      }
    });
    expect(snap.writes!.unexplained_difference).toBe(1); // the first pass read the old tally; the identity check made it read again
    expect(snap.outstanding).toEqual([]); expect(snap.unstable).toBe(false);
    expect(seen.slice(0, 3)).toEqual(['tally', 'lines', 'owed']);
  });

  test('a settlement and a new owed sample between the reads leave the session outstanding: a later settled sample cannot hide an earlier unsettled one', () => {
    const dir = tmp(); const epoch = epochOf(dir);
    owe(dir, 's', 1); passing(dir, epoch, { settled: { s: 0 } });
    let n = 0;
    const snap = readWriteSnapshot(dir, epoch, (stage) => {
      if (stage === 'tally' && n++ === 0) { passing(dir, epoch, { settled: { s: 1 } }); owe(dir, 's', 2); } // the first sample settles, a second is accepted
    });
    expect(snap.outstanding).toEqual(['write-owed.s.json']);
  });

  test('a tally that keeps changing under the reads reads as unresolved, never measured', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    let k = 0;
    const snap = readWriteSnapshot(dir, epoch, () => { passing(dir, epoch, { updated_at: String(++k) }); });
    expect(snap.unstable).toBe(true);
    owe(dir, 'x', 0);
    expect(buildFollowStatus(dir, STATE, NOW).write_comparisons.state).toBe('measured'); // a quiet tally reads normally
  });

  test('a retired-epoch worker writes its results as epoch_retired lines naming the session: the new owner settles the session and counts no outcome of the retired epoch', () => {
    const dir = tmp(); const oldEpoch = epochOf(dir);
    const old = worker(dir, oldEpoch, 'sr'); owe(dir, 'sr', 3, { child_pid: process.pid });
    const fresh = ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'b' }, NOW.getTime() + 1000).epoch_id; // a newer worker opened a new epoch
    expect(fresh).not.toBe(oldEpoch);
    const owner = worker(dir, fresh, 'new-owner', OTHER_PID); passing(dir, fresh);
    old.note('comparable', undefined, 1, false, 1); // detects it is retired: its save cannot land
    expect(old.begin()).toBe(false); // no replay may run in a retired epoch
    old.note('uncomparable', 'mark_unwritten', 1, false, 1); old.note('capability_missing', 'tags', 1, false, 1);
    expect(old.flush()).toBe(true);
    expect(stat(dir).outstanding_sessions).toBeUndefined(); // written lines already count toward the session's settlement before the owner folds them (and the retired epoch's outcomes block nothing in this one)
    owner.save();
    const t = readWriteTally(dir, fresh)!;
    expect(t.settled).toEqual({ sr: 3 });
    expect(t.uncomparable + t.capability_missing).toBe(0); // the retired epoch's outcomes count nowhere in this one
    expect(stat(dir)).toMatchObject({ state: 'measured' });
    old.save(); old.save(); owner.save();
    expect(readWriteTally(dir, fresh)!.settled).toEqual({ sr: 3 }); // once
  });

  test('a new epoch carries the settlement ledger whole: a line already folded in the earlier epoch adds no credit again, and a later unsettled sample still blocks', () => {
    const dir = tmp(); const e1 = epochOf(dir); owe(dir, 'sl', 2, { child_pid: process.pid });
    const owner1 = worker(dir, e1, 'o1'); passing(dir, e1);
    recordLost(dir, e1, 'no_epoch', 1, 'sl'); owner1.save(); // one line folded in epoch 1
    expect(readWriteTally(dir, e1)!.settled).toEqual({ sl: 1 });
    const e2 = ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'c' }, NOW.getTime() + 2000).epoch_id;
    const owner2 = worker(dir, e2, 'o2', OTHER_PID);
    recordLost(dir, e2, 'no_epoch', 0 + 1, 'zz'); owner2.save(); owner2.save(); // epoch 2 folds on; the epoch-1 line must not be credited again
    const t = readWriteTally(dir, e2)!;
    expect(t.settled).toMatchObject({ sl: 1 });
    expect(Object.keys(t.lost_applied ?? {})).toContain(`write-lost.${process.pid}.jsonl`);
  });

  test('a lost line the serving process wrote for itself settles nothing (session empty), a line with no session key is an older writer\'s (legacy_lines: no evidence), and neither is credited to another session', () => {
    const dir = tmp(); const epoch = epochOf(dir); const owner = worker(dir, epoch, 'o'); passing(dir, epoch); owe(dir, 'sx', 2);
    passing(dir, epoch, { settled: { sx: 1 } });
    expect(recordLost(dir, epoch, 'send_shed')).toBe(true); // the sampler's own refusal: session ''
    owner.save();
    expect(readWriteTally(dir, epoch)).toMatchObject({ uncomparable_by_reason: { send_shed: 1 } });
    expect(readWriteTally(dir, epoch)!.settled).toEqual({ sx: 1 }); // a refused sample was never owed: it credits nobody
    expect(readWriteTally(dir, epoch)!.legacy_lines).toBeUndefined();
    expect(stat(dir).outstanding_sessions).toEqual(['write-owed.sx.json']); // the accepted, unsettled sample still blocks
    appendFileSync(lostPath(dir, process.pid), JSON.stringify({ epoch_id: epoch, reason: 'send_shed' }) + '\n'); // an older version's line
    owner.save();
    expect(readWriteTally(dir, epoch)!.legacy_lines).toBe(1);
    passing(dir, epoch, { settled: { sx: 2 }, legacy_lines: 1, lost_applied: readWriteTally(dir, epoch)!.lost_applied });
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', legacy_lines: 1, unresolved_replays: 1 });
  });

  test('a client worker\'s credited lines count once: an append that landed but whose flush failed is written again with the same numbers on the retry, and the owner takes each number once', async () => {
    const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'sc2', 3); passing(dir, epoch);
    const durable = await import('../src/core/fs-durable.ts');
    const client = new WriteTally(dir, () => null, () => true, 424242, 'sc2');
    client.note('uncomparable', 'moved', 2, false, 2); client.note('uncomparable', 'moved', 1, false, 1);
    const flush = spyOn(durable, 'flushFile').mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(client.save()).toBe(false); flush.mockRestore(); // appended, flush failed
    expect(client.save()).toBe(true); // written again with the same numbers (was: flush only, and the lines were not appended twice)
    expect(client.save()).toBe(true);
    expect(unfoldedLines(dir, epoch).bySession).toEqual({ sc2: 3 }); // exactly three lines, not six
    const directory = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    client.note('uncomparable', 'moved', 1, false, 0); expect(client.save()).toBe(false); directory.mockRestore(); // an uncredited line, same rule
    expect(client.save()).toBe(true);
    worker(dir, epoch, 'o').save();
    expect(settledOf(dir, epoch, 'sc2')).toBe(3);
    expect(stat(dir)).toMatchObject({ state: 'measured' });
  });

  test('a dead client and a dead owner are each booked once, however many owners look and in whatever order', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    const d1 = deadPid(); const d2 = deadPid();
    owe(dir, 'client-s', 2, { child_pid: d1 }); owe(dir, 'owner-s', 5, { child_pid: d2, closed: true });
    const a = worker(dir, epoch, 'a', process.pid); const b = worker(dir, epoch, 'b', OTHER_PID);
    a.recover(); b.recover(); b.save(); a.save();
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 7 });
    expect(existsSync(owedPath(dir, 'client-s')) || existsSync(owedPath(dir, 'owner-s'))).toBe(false);
  });

  test('the orphan rules: child exited, child pid gone, closed and old, serving pid gone and old; a live session is left alone, a fresh closed one is not booked', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    const live = { child_pid: process.ppid, serving_pid: process.pid };
    owe(dir, 'exited', 1, { ...live, child_exited: true });
    owe(dir, 'gone', 1, { ...live, child_pid: deadPid() });
    owe(dir, 'closed-old', 1, { ...live, closed: true });
    owe(dir, 'serving-gone', 1, { ...live, serving_pid: deadPid() });
    owe(dir, 'live', 1, live);
    owe(dir, 'closed-fresh', 1, { ...live, closed: true });
    const old = new Date(Date.now() - 11 * 60_000);
    for (const n of ['closed-old', 'serving-gone']) utimesSync(owedPath(dir, n), old, old);
    worker(dir, epoch, 'o').recover();
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 4 });
    expect(['exited', 'gone', 'closed-old', 'serving-gone'].map((n) => existsSync(owedPath(dir, n)))).toEqual([false, false, false, false]);
    expect(['live', 'closed-fresh'].map((n) => existsSync(owedPath(dir, n)))).toEqual([true, true]);
  });

  test('a closed owed file whose samples are all settled is removed by the owner pass whoever settled them, and settled entries of gone sessions are pruned on a later save', () => {
    const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'done', 2, { closed: true, child_pid: process.ppid });
    passing(dir, epoch, { settled: { done: 2 } });
    const o = worker(dir, epoch, 'o'); o.save();
    expect(existsSync(owedPath(dir, 'done'))).toBe(false);
    o.note('capability_missing', 'tags', 1, false, 1); // a later save
    expect(readWriteTally(dir, epoch)!.settled?.done).toBeUndefined();
  });

  test('the owner pass settles nothing in a retired epoch and never removes a file whose settlement a tally has not shown', () => {
    const dir = tmp(); const e1 = epochOf(dir); const old = worker(dir, e1, 'o1'); owe(dir, 'x', 2, { closed: true, child_exited: true });
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'z' }, NOW.getTime() + 5);
    old.recover(); old.save();
    expect(existsSync(owedPath(dir, 'x'))).toBe(true);
    expect(readWriteTally(dir, e1)?.uncomparable_by_reason?.receipt_orphaned).toBeUndefined();
  });

  test('a failed booking keeps the owed file: nothing is removed until the deficit is on disk and a tally shows it settled', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'kb', 3, { child_exited: true });
    mkdirSync(lostPath(dir, process.pid)); // the booking cannot be appended
    worker(dir, epoch, 'o').recover();
    expect(existsSync(owedPath(dir, 'kb'))).toBe(true);
    rmSync(lostPath(dir, process.pid), { recursive: true });
    worker(dir, epoch, 'o').recover();
    expect(existsSync(owedPath(dir, 'kb'))).toBe(false);
  });

  test('a retired worker\'s batch that an earlier save already landed (directory flush failed) is not credited a second time as a line: the current file\'s applied ledger says so', async () => {
    const dir = tmp(); const e1 = epochOf(dir); passing(dir, e1); owe(dir, 'sq', 2, { child_pid: process.pid });
    const old = worker(dir, e1, 'sq');
    const durable = await import('../src/core/fs-durable.ts');
    const dirFlush = spyOn(durable, 'flushDirectory').mockImplementationOnce(() => { throw new Error('EIO'); });
    old.note('comparable', undefined, 1, false, 1); dirFlush.mockRestore(); // renamed (credit 1 is in the file), flush failed: the batch is kept, sealed
    expect(settledOf(dir, e1, 'sq')).toBe(1);
    const e2 = ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'q' }, NOW.getTime() + 3000).epoch_id; // a newer worker opens another epoch...
    const owner = worker(dir, e2, 'new-owner', OTHER_PID); owner.note('capability_missing', 'tags', 1, false, 0); // ...and saves: settled and the applied cursors are carried
    old.note('comparable', undefined, 1, false, 1); // detects it is retired: both its batches are unsaved in its memory, but the first one the file already took
    old.flush(); owner.save();
    expect(settledOf(dir, e2, 'sq')).toBe(2); // 1 carried + 1 line, never 3
  });

  test('a booking counts the lines a dead client already flushed (not yet folded): the whole deficit is owed less settled less those lines', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    const dead = deadPid(); owe(dir, 'sdl', 5, { child_pid: dead });
    const client = new WriteTally(dir, () => null, () => true, dead, 'sdl');
    client.note('uncomparable', 'moved', 2, false, 2); client.flush(); // two lines reached the file before the worker died
    worker(dir, epoch, 'o').recover();
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_epoch: 2, receipt_orphaned: 3 }); // not 5
    expect(settledOf(dir, epoch, 'sdl')).toBe(5);
  });

  test('a closed session that is not settled yet is never removed by the owner pass, and is removed the moment its settlement is in a tally', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'cl', 3, { closed: true, child_pid: process.ppid });
    passing(dir, epoch, { settled: { cl: 1 } });
    const o = worker(dir, epoch, 'o'); o.save();
    expect(existsSync(owedPath(dir, 'cl'))).toBe(true); // 1 of 3 settled, its worker alive: it is not the pass's to remove
    passing(dir, epoch, { settled: { cl: 3 } }); o.save();
    expect(existsSync(owedPath(dir, 'cl'))).toBe(false);
  });

  for (const foldBetween of [false, true]) {
    test(`E2: a partial append followed by the retry of the whole batch credits each line once (${foldBetween ? 'the owner folds the prefix before the retry' : 'the owner folds after the retry'}): a later missing sample still blocks`, async () => {
      const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'se2', 101); passing(dir, epoch);
      const fs = await import('node:fs');
      const real = fs.appendFileSync; const owner = worker(dir, epoch, 'o');
      const client = new WriteTally(dir, () => null, () => true, process.pid, 'se2'); // a running worker: its numbers stay until it is gone
      client.note('uncomparable', 'moved', 100, false, 100); // 100 verdicts settle 100 of the 101 owed samples
      const partial = spyOn(fs, 'appendFileSync').mockImplementationOnce(((path: string, data: string, opts: unknown) => {
        real(path, data.split('\n').slice(0, 60).join('\n') + '\n', opts as never); // the first 60 lines reach the file, then the write fails (a file-size limit, ENOSPC)
        throw Object.assign(new Error('EFBIG'), { code: 'EFBIG' });
      }) as never);
      expect(client.save()).toBe(false); partial.mockRestore();
      if (foldBetween) { owner.save(); expect(settledOf(dir, epoch, 'se2')).toBe(60); }
      expect(client.save()).toBe(true); // the whole batch is written again
      expect(unfoldedLines(dir, epoch, readWriteTally(dir, epoch)?.lost_applied, readWriteTally(dir, epoch)?.line_seq).bySession).toEqual({ se2: foldBetween ? 40 : 100 }); // was 100 + 60 before the fold: the prefix counted twice
      owner.save();
      expect(settledOf(dir, epoch, 'se2')).toBe(100); // was 160
      expect(stat(dir).outstanding_sessions).toEqual(['write-owed.se2.json']); // 101 owed, 100 settled: the later missing sample still blocks
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason.no_epoch).toBe(100); // outcomes once too
      client.save(); owner.save(); expect(settledOf(dir, epoch, 'se2')).toBe(100);
    });
  }

  test('E3: a manifest that cannot be read for a moment does not retire the worker: it fails the save and tries again, and only a different epoch id retires it', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'se3', 2, { child_pid: process.pid });
    const w = worker(dir, epoch, 'se3');
    const manifest = readFileSync(epochPath(dir), 'utf8');
    writeFileSync(epochPath(dir), '{"version":1,"epo'); // torn for a moment (a rename in progress on another filesystem, a read error)
    expect(w.begin()).toBe(false);
    w.note('comparable', undefined, 1, false, 1);
    expect(settledOf(dir, epoch, 'se3')).toBeUndefined();
    writeFileSync(epochPath(dir), manifest); // readable again
    expect(w.begin()).toBe(true); // was false for the rest of the worker's life: it had been retired
    w.note('comparable', undefined, 1, true, 1);
    expect(settledOf(dir, epoch, 'se3')).toBe(2); // both verdicts, each once
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'e3' }, NOW.getTime() + 9000); // a different epoch id does retire it
    expect(w.begin()).toBe(false);
  });

  test('each worker credits through its own session only: another session\'s verdicts never settle this one', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'p', 1); owe(dir, 'q', 1);
    worker(dir, epoch, 'p').note('comparable', undefined, 1, false, 1);
    expect(settledOf(dir, epoch, 'p')).toBe(1); expect(settledOf(dir, epoch, 'q')).toBeUndefined();
    expect(stat(dir).outstanding_sessions).toEqual(['write-owed.q.json']);
  });
});
const OTHER_PID = process.ppid;

describe('S2c: the shadow child settles its session', () => {
  const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
  const BASE = { loadAddon: ADDON, capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };
  const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never;
  const owner = () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never;

  test('a write line that cannot be read settles the samples its text states, once, so it cannot hold its session open (1 + 1 + 2 owed, nothing booked as lost)', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED);
      writeOwed(dir, { v: 1, session: 'cu', serving_pid: process.pid, owed: 5, closed: true, child_exited: false });
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'cu', addonSha256: () => 'a'.repeat(64), openEngine: owner });
      input.write('{"t":"write","op":"putPage"}\n'); input.write('{"t":"write","op":"putPage","pad":"torn\n'); input.write('{"t":"write","bad":,"dropped":1}\n'); input.write('{"t":"write","op":"putPage"}\n');
      input.end(); await done;
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      expect(t.uncomparable_by_reason).toMatchObject({ no_sample: 2, line_unreadable: 3 });
      expect(t.uncomparable_by_reason.pipe_unflushed).toBeUndefined(); // every owed sample was read (the unreadable lines too), so nothing is booked as lost
      expect(t.settled).toEqual({ cu: 5 });
      expect(existsSync(owedPath(dir, 'cu'))).toBe(false);
    });
  }, 30_000);

  test('a child whose saves keep failing for 60 s with results it could not save exits (the supervisor restarts it, and the next owner books them); one whose saves land does not', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED); let clock = 5_000_000; let exitCode = null as number | null;
      writeOwed(dir, { v: 1, session: 'cx', serving_pid: process.pid, owed: 1, closed: false, child_exited: false });
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'cx', addonSha256: () => 'a'.repeat(64), openEngine: owner, now: () => clock, passMs: 10, exit: (code) => { exitCode = code; } });
      await new Promise((r) => setTimeout(r, 100)); // the epoch is open
      mkdirSync(`${writeTallyPath(dir)}.${process.pid}.tmp`); // every save of this child fails
      input.write('{"t":"write","op":"putPage","outcome":"capability_missing","family":"tags"}\n');
      await new Promise((r) => setTimeout(r, 100));
      expect(exitCode).toBeNull(); // failing, but not for 60 s yet
      clock += 61_000;
      const until = Date.now() + 5_000; while (exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      expect(exitCode as number | null).toBe(1);
      rmSync(`${writeTallyPath(dir)}.${process.pid}.tmp`, { recursive: true });
      input.end(); await done;
    });
  }, 30_000);
});

// Every credit site: each place a verdict is noted settles exactly the weight of the line it stands for (the weight the serving process owed, supervisor.ts sampleWeight): not less (the session would block for its whole life), not more (a false "measured").
describe('S2c: every credit site settles exactly the weight it stands for', () => {
  const SEED_F1 = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never;
  const INPUTS = { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as const;
  const put = (n = 0, over: Partial<WriteEvent> = {}): WriteEvent => ({ t: 'write', op: 'putPage', args: encodeArgs([`people/credit-${n}-example`, { type: 'person', title: 'C', compiled_truth: 'C.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] }, ...over });
  /** The line the sampler writes for `e` carrying `dropped` earlier losses (its last field), and its weight as the serving process counts it. */
  const wire = (e: WriteEvent, dropped = 0): { line: string; event: WriteEvent; weight: number } => {
    const line = dropped ? `${JSON.stringify(e).slice(0, -1)},"dropped":${dropped}}\n` : `${JSON.stringify(e)}\n`;
    return { line, event: JSON.parse(line) as WriteEvent, weight: sampleWeight(line) };
  };
  function rig(over: Parameters<typeof fakeComparer>[1] = {}) {
    const dir = tmp(); const { epoch } = tallyOn(dir);
    const w = new WriteTally(dir, () => epoch, () => true, process.pid, 'cs');
    const c = fakeComparer(dir, { tally: w, ...over });
    const owe = (n: number): void => writeOwed(dir, { v: 1, session: 'cs', serving_pid: process.pid, owed: n, closed: false, child_exited: false });
    const settled = (): number => readWriteTally(dir, epoch)?.settled?.cs ?? 0;
    const status = () => buildFollowStatus(dir, { sample_rate: 0.1 } as never, NOW).write_comparisons;
    return { dir, epoch, w, c, owe, settled, status };
  }
  /** Sends the lines through the comparer, then checks the settled count is exactly their weight, still so after more saves, and that status reads nothing outstanding. */
  async function exact(lines: Array<ReturnType<typeof wire>>, over: Parameters<typeof fakeComparer>[1] = {}, expectCounts?: Record<string, number>): Promise<void> {
    const r = rig(over); const total = lines.reduce((n, l) => n + l.weight, 0); r.owe(total);
    for (const l of lines) r.c.handle(l.event, l.line.length);
    await r.c.idle();
    expect(r.settled()).toBe(total); // not less, not more
    r.w.save(); r.w.save(); expect(r.settled()).toBe(total);
    expect(r.status().outstanding_sessions).toBeUndefined();
    const t = readWriteTally(r.dir, r.epoch)!;
    expect(t.comparable + t.unexplained_difference + t.uncomparable + t.capability_missing).toBe(total); // one outcome per owed sample
    if (expectCounts) expect({ ...t.uncomparable_by_reason, comparable: t.comparable, unexplained_difference: t.unexplained_difference, capability_missing: t.capability_missing }).toMatchObject(expectCounts);
  }

  test('a replay verdict credits its own weight once: comparable, unexplained, and every uncomparable ending of a replay', async () => {
    await exact([wire(put(1))], {}, { comparable: 1 });
    await exact([wire(put(2, { post: { pages: [{ slug: 'x' }], links: [] } }))], {}, { unexplained_difference: 1 });
    await exact([wire(put(3, { moved: true }))], {}, { moved: 1 });
    await exact([wire(put(4))], { put: async () => { throw new Error('boom'); } }, { rust_write_failed: 1 });
    await exact([wire({ ...put(5), op: 'deletePage', args: encodeArgs(['people/credit-5-example']) as unknown[] })], {}, { target_absent: 1 }); // a delete whose page the preimage lacks
    await exact([wire(put(6), 5)], {}, { comparable: 1, send_shed: 5 }); // a replayed sample that carries five earlier losses: 1 + 5, the five at once and the sample with its verdict
  });

  test('the earlier losses a line carries (send_shed) are credited with the note that counts them, and the line itself with its own outcome: neither twice, neither missed', async () => {
    await exact([wire({ t: 'write', op: 'addTag', outcome: 'capability_missing', family: 'tags' }, 7)], {}, { capability_missing: 1, send_shed: 7 });
    await exact([wire({ t: 'write', op: 'putPage', outcome: 'uncomparable', reason: 'preimage_timeout' }, 3)], {}, { preimage_timeout: 1, send_shed: 3 });
    await exact([wire({ t: 'write', op: 'putPage' }, 2)], {}, { no_sample: 1, send_shed: 2 });
    await exact([wire({ t: 'write', op: 'putPage' }, 99_999)], {}, { send_shed: 10_000 }); // the weight is capped at 10,000 on both sides: 1 + 10,000
  });

  test('F1: a dropped count of six digits cannot mint credit: the line weighs 1 on the supervisor\'s side, so the child settles exactly 1, and a hand-made count is no count at all', async () => {
    await exact([wire({ t: 'write', op: 'putPage' }, 100_000)], {}, { no_sample: 1 }); // was 10,001 settled against 1 owed
    await exact([wire({ t: 'write', op: 'putPage' }, 1_000_000)], {}, { no_sample: 1 });
    const { line, event } = wire({ t: 'write', op: 'putPage' }, 0); event.dropped = 12.5; // a count the sampler never writes
    expect(sampleWeight(line)).toBe(1);
    const r = rig(); r.owe(1); r.c.handle(event, line.length); await r.c.idle();
    expect(r.settled()).toBe(1);
  });

  test('F1: droppedWeight is the one rule: whole numbers 1 to 99,999 count, capped at 10,000; anything else is 0; sampleWeight and the child agree', () => {
    expect([0, 1, 9_999, 10_000, 10_001, 99_999, 100_000, 12.5, -3, Number.NaN, '7', undefined].map(droppedWeight)).toEqual([0, 1, 9_999, 10_000, 10_000, 10_000, 0, 0, 0, 0, 0, 0]);
    expect(MAX_DROPPED).toBe(10_000);
    for (const n of [1, 5, 10_000, 10_001, 99_999]) {
      const line = `{"t":"write","op":"putPage","dropped":${n}}\n`; expect(sampleWeight(line)).toBe(1 + droppedWeight(n));
    }
    expect(sampleWeight('{"t":"write","op":"putPage","dropped":100000}\n')).toBe(1 + droppedWeight(100_000)); // 1 on both sides
  });

  test('F1: the sampler carries at most 10,000 refused samples per line and keeps the rest for later lines, so every refused sample is carried once and no line weighs more than it carries', async () => {
    const lines: string[] = []; let refuse = 25_000;
    const sampler = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line) => { if (refuse > 0) { refuse--; return false; } lines.push(line); return true; } }); // no `lost`: a refusal is carried, not journaled
    const fn = async () => 1; const ctx = { engine: {}, inTransaction: false, mayWrite: () => true };
    for (let i = 0; i < 25_000; i++) await (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 4; i++) await (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)(); // accepted lines now
    const carried = lines.map((l) => droppedWeight(Number(/"dropped":(\d+)/.exec(l)?.[1] ?? 0)));
    expect(carried).toEqual([10_000, 10_000, 5_000, 0, 0, 0]); // was [10000, 10000, 5000, 0]: the remainder waited for later sampled writes; now the first accepted send emits loss-only lines until nothing is left (earlier still: one line carried all 25,000 and the rest was cleared)
    expect(carried.reduce((a, b) => a + b, 0)).toBe(25_000); // every refused sample is carried once
    for (const l of lines) expect(sampleWeight(l)).toBe(1 + droppedWeight(Number(/"dropped":(\d+)/.exec(l)?.[1] ?? 0)));
  });

  test('F3: after the first accepted send every refused sample is carried (10,001 unsaid: 10,000 on the line and 1 on a loss-only line in the same flush), unsaid is empty, owed equals settled and nothing is outstanding', async () => {
    const lines: string[] = []; let refuse = 10_001;
    const sampler = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line) => { if (refuse > 0) { refuse--; return false; } lines.push(line); return true; } });
    const fn = async () => 1; const ctx = { engine: {}, inTransaction: false, mayWrite: () => true };
    const wrap = () => (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 10_001; i++) await wrap(); // every send refused, no journal: all 10,001 wait in the sampler
    await wrap(); // one accepted send
    const carriedAfterFirst = lines.map((l) => droppedWeight(Number(/"dropped":(\d+)/.exec(l)?.[1] ?? 0)));
    expect(carriedAfterFirst).toEqual([10_000, 1]); // was [10000]: the remaining 1 sat only in memory until another sampled write
    expect(lines[1]).toContain('"reason":"send_shed"'); expect(lines[1]!.startsWith('{"t":"write"')).toBe(true);
    await wrap(); expect(/"dropped"/.test(lines[2]!)).toBe(false); // unsaid is empty: nothing more to carry
    // the owed count (the supervisor's weight of every line) equals what the worker settles, and nothing is outstanding
    const owed = lines.reduce((n, l) => n + sampleWeight(l), 0);
    const r = rig(); r.owe(owed);
    for (const l of lines) r.c.handle(JSON.parse(l) as WriteEvent, l.length);
    await r.c.idle();
    expect(r.settled()).toBe(owed);
    expect(r.status().outstanding_sessions).toBeUndefined();
    expect(readWriteTally(r.dir, r.epoch)!.uncomparable_by_reason.send_shed).toBe(10_002); // the 10,001 refused samples counted once, plus the loss-only line's own sample (an over-count of one uncomparable, never a loss)
    // a refusal in the middle of the extra lines stops it: the rest stays for the next accepted send
    const more: string[] = []; let accept = 1; refuse = 25_000;
    const again = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line) => { if (refuse > 0) { refuse--; return false; } if (accept-- > 0) { more.push(line); return true; } accept = 0; return false; } });
    const wrapAgain = () => (again.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 25_000; i++) await wrapAgain();
    accept = 2; await wrapAgain(); // the main line and one extra are accepted, the second extra is refused
    const raw = (l: string): number => Number(/"dropped":(\d+)/.exec(l)?.[1] ?? 0);
    expect(more.map(raw)).toEqual([10_000, 10_000]); // each bounded
    accept = 10; await wrapAgain(); // the next accepted send: the remainder (25,000 - 20,000) was kept, not cleared, by the refusal
    expect(more.map(raw)).toEqual([10_000, 10_000, 5_000]);
  });

  test('G1: when an extra loss-only line is refused, the sampler makes the remainder owed (owe(n)) and empties unsaid: nothing waits only in memory', async () => {
    const lines: string[] = []; const owedCalls: number[] = []; let refuse = 10_001; let acceptNext = 1;
    const sampler = createWriteSampler({ rate: 1, random: () => 0, active: () => true,
      send: (line) => { if (refuse > 0) { refuse--; return false; } if (acceptNext-- > 0) { lines.push(line); return true; } return false; }, // the main line is accepted, the extra one refused
      owe: (n) => { owedCalls.push(n); return true; } });
    const fn = async () => 1; const ctx = { engine: {}, inTransaction: false, mayWrite: () => true };
    const wrap = () => (sampler.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 10_001; i++) await wrap();
    await wrap();
    expect(lines.map((l) => droppedWeight(Number(/"dropped":(\d+)/.exec(l)?.[1] ?? 0)))).toEqual([10_000]);
    expect(owedCalls).toEqual([1]); // the one remaining sample is owed, not left in memory (was: nothing recorded it)
    acceptNext = 5; await wrap(); expect(/"dropped"/.test(lines[1]!)).toBe(false); // unsaid is empty: the next line carries nothing
    // an owe that cannot be taken (no session) leaves the remainder in unsaid, as a refused send does
    const keptLines: string[] = []; refuse = 10_001; acceptNext = 1;
    const noOwe = createWriteSampler({ rate: 1, random: () => 0, active: () => true, send: (line) => { if (refuse > 0) { refuse--; return false; } if (acceptNext-- > 0) { keptLines.push(line); return true; } return false; }, owe: () => false });
    const wrapB = () => (noOwe.wrap('addTag', fn, ctx as never) as () => Promise<unknown>)();
    for (let i = 0; i < 10_001; i++) await wrapB();
    await wrapB(); acceptNext = 5; await wrapB();
    expect(keptLines.map((l) => /"dropped":(\d+)/.exec(l)?.[1])).toEqual(['10000', '1']); // the remainder rides the next accepted send
  });

  test('F1: end to end, a line the serving process owed as 1 is settled as 1 by the child, whatever its dropped field says', async () => {
    await withEnv({ GBRAIN_HOME: tmp() }, async () => {
      const dir = tmp(); writeSeedRecord(dir, SEED_F1);
      writeOwed(dir, { v: 1, session: 'cf1', serving_pid: process.pid, owed: 12, closed: true, child_exited: false }); // 2 read, 10 the pipe never delivered
      const input = new PassThrough();
      const done = runShadowChild(dir, { input, writeControl: () => {}, loadAddon: async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never }), capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1', session: 'cf1', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
      input.write('{"t":"write","op":"putPage","dropped":100000}\n'); input.write('{"t":"write","op":"putPage"}\n');
      input.end(); await done;
      const t = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
      expect(t.settled).toEqual({ cf1: 12 }); // was 10,012 (and the 10 undelivered samples went unbooked: the child believed it had read 10,002)
      expect(t.uncomparable_by_reason.pipe_unflushed).toBe(10);
      expect(t.uncomparable_by_reason.send_shed).toBeUndefined();
    });
  }, 30_000);

  test('a sample the queue refuses (queue_full) is credited when it is refused, and the ones that waited are credited at their verdicts: 300 samples, settled 300', async () => {
    const r = rig(); const lines = Array.from({ length: 300 }, (_, n) => wire(put(n))); r.owe(300);
    let release = (): void => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
    const c = fakeComparer(r.dir, { tally: r.w, connect: () => gate });
    for (const l of lines) c.handle(l.event, l.line.length);
    release(); await c.idle();
    expect(r.settled()).toBe(300);
    expect(readWriteTally(r.dir, r.epoch)!.uncomparable_by_reason.queue_full).toBe(44);
    expect(r.status().outstanding_sessions).toBeUndefined();
  }, 30_000);

  test('the exit deadline credits the replays that never ran, and leaves the one that was running unsettled (it keeps its mark)', async () => {
    const r = rig();
    const c = fakeComparer(r.dir, { tally: r.w, connect: () => new Promise<void>(() => {}) }); // the first replay never ends
    r.owe(10); for (let n = 0; n < 10; n++) c.handle(put(n), 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    c.abandon();
    expect(r.settled()).toBe(9); // the nine that waited; not ten: the running replay is not settled
    expect(readWriteTally(r.dir, r.epoch)!.uncomparable_by_reason.child_exit_deadline).toBe(9);
    expect(r.status().outstanding_sessions).toEqual(['write-owed.cs.json']);
  });

  test('an unreadable write line credits the weight its text states, once: a plain line is 1, one that still ends in its dropped count is 1 + that', async () => {
    const r = rig(); r.owe(1 + 6); r.c.unreadable(sampleWeight('{"t":"write","op":"putPage","pad":"cut')); r.c.unreadable(sampleWeight('{"t":"write","op":"putPage","x":1,"dropped":5}\n'));
    await r.c.idle();
    expect(r.settled()).toBe(7);
    expect(readWriteTally(r.dir, r.epoch)!.uncomparable_by_reason).toMatchObject({ line_unreadable: 7 });
    expect(r.status().outstanding_sessions).toBeUndefined();
  });

  test('the samples the pipe never delivered are booked as pipe_unflushed and credited exactly once, whether the child owns the store or not', async () => {
    const r = rig(); r.owe(9); r.c.handle(wire(put(1)).event); await r.c.idle(); r.c.missing(8); await r.c.idle();
    expect(r.settled()).toBe(9); expect(readWriteTally(r.dir, r.epoch)!.uncomparable_by_reason).toMatchObject({ pipe_unflushed: 8 });
    r.c.missing(0); await r.c.idle(); expect(r.settled()).toBe(9);
    // a client child: lines, folded by the owner
    const dir = tmp(); const { tally, epoch } = tallyOn(dir); writeOwed(dir, { v: 1, session: 'cs', serving_pid: process.pid, owed: 4, closed: true, child_exited: false });
    const client = new WriteTally(dir, () => null, () => true, 424242, 'cs'); client.missing(4); client.save(); tally.save();
    expect(readWriteTally(dir, epoch)!.settled).toEqual({ cs: 4 });
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ pipe_unflushed: 4 });
  });

  test('a verdict whose save fails is not credited, and is credited exactly once when a later save lands (a save that may have landed is not added twice)', async () => {
    const r = rig(); r.owe(2);
    const durable = await import('../src/core/fs-durable.ts');
    const dirFlush = spyOn(durable, 'flushDirectory').mockImplementation(() => { throw new Error('EIO'); });
    r.c.handle(wire(put(1)).event); await r.c.idle().catch(() => undefined);
    dirFlush.mockRestore();
    expect(r.status().outstanding_sessions ?? []).not.toEqual([]); // the verdict may be in the file, but its settlement is not known durable: the session is not settled in the eyes of this child
    r.c.handle(wire(put(2)).event); await r.c.idle();
    expect(r.settled()).toBe(2); // each credited once
    expect(r.status().outstanding_sessions).toBeUndefined();
  });

  test('a client or retired worker credits through lines, each verdict once: the credit rides the lines, and uncredited surplus never settles', () => {
    const dir = tmp(); const { tally, epoch } = tallyOn(dir); writeOwed(dir, { v: 1, session: 'cs', serving_pid: process.pid, owed: 3, closed: false, child_exited: false });
    const client = new WriteTally(dir, () => null, () => true, 424242, 'cs');
    client.note('uncomparable', 'a', 2, false, 2); client.note('uncomparable', 'b', 3, false, 1); // three outcomes, one credited: 2 + 1 = 3 settle, 2 are surplus outcomes
    client.save(); tally.save();
    expect(readWriteTally(dir, epoch)!.settled).toEqual({ cs: 3 });
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toMatchObject({ no_epoch: 5 });
  });

  test('a booked orphan deficit credits its session once, and the legacy receipt path credits nobody who owes anything', () => {
    const dir = tmp(); const { tally, epoch } = tallyOn(dir);
    writeFileSync(sentPath(dir, 'old-session'), JSON.stringify({ session: 'old-session', sent: 4, pid: spawnSync(process.execPath, ['-e', '0']).pid }) + '\n');
    tally.recover(); tally.save();
    const t = readWriteTally(dir, epoch)!;
    expect(t.uncomparable_by_reason).toMatchObject({ receipt_orphaned: 4 }); expect(t.legacy_lines).toBeUndefined();
    expect(t.settled?.['old-session']).toBe(4); // credited once, with the booking
    tally.note('capability_missing', 'tags', 1, false, 0); // a later save
    expect(readWriteTally(dir, epoch)!.settled?.['old-session']).toBeUndefined(); // no owed file stands for it: pruned
  });
});

// ---- S2d: a pending marker, and one commit/delete protocol for every owed-file remover ----
describe('S2d: a pending marker blocks status, and every owed-file remover re-reads the record and the marker under the tally lock', () => {
  const STATE = { sample_rate: 0.1 } as never;
  const stat = (dir: string) => buildFollowStatus(dir, STATE, NOW).write_comparisons;
  const INPUTS = { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 1, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' } as const;
  const epochOf = (dir: string): string => ensureEpoch(dir, INPUTS, NOW.getTime()).epoch_id;
  const owe = (dir: string, session: string, owed: number, over: Partial<OwedRecord> = {}): void => writeOwed(dir, { v: 1, session, serving_pid: process.pid, owed, closed: false, child_exited: false, ...over });
  const passing = (dir: string, epoch: string, extra: Record<string, unknown> = {}): void => writeFileSync(writeTallyPath(dir), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [], ...extra }) + '\n');
  const worker = (dir: string, epoch: string, session: string): WriteTally => new WriteTally(dir, () => epoch, () => true, process.pid, session);
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;
  const marker = (dir: string, session: string): string => join(dir, `write-pending.${session}.json`);

  test('D1-F2: an owner pass that judged an old record settled cannot remove the higher record a republish put in its place meanwhile', async () => {
    const dir = tmp(); const epoch = epochOf(dir); const dead = deadPid();
    owe(dir, 'sp', 1, { child_pid: dead }); passing(dir, epoch);
    const durable = await import('../src/core/fs-durable.ts'); const real = durable.flushDirectory; let swapped = false;
    const spy = spyOn(durable, 'flushDirectory').mockImplementation(((path: string, options?: unknown) => {
      (real as (p: string, o?: unknown) => void)(path, options);
      if (!swapped) { swapped = true; owe(dir, 'sp', 2, { child_pid: dead, child_exited: true }); } // the supervisor republishes while the pass is between judging and removing
    }) as never);
    try { worker(dir, epoch, 'owner').recover(); } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(readOwed(dir, 'sp')).toMatchObject({ owed: 2 }); // was removed on its cached count of 1
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 });
  });

  test('D1-F2: the worker\'s own finish() cannot remove a higher record that replaced the one it judged settled', async () => {
    const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'sf2', 1, { closed: true }); passing(dir, epoch, { settled: { sf2: 1 } });
    const fs = await import('node:fs'); const realRead = fs.readFileSync; let swapped = false;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      const out = (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      if (!swapped && String(p) === writeTallyPath(dir)) { swapped = true; owe(dir, 'sf2', 2, { closed: true }); } // a republish lands right after finish() read the tally
      return out;
    }) as never);
    let done: boolean;
    try { done = worker(dir, epoch, 'sf2').finish(); } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(done).toBe(false);
    expect(readOwed(dir, 'sf2')).toMatchObject({ owed: 2 });
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', outstanding_sessions: ['write-owed.sf2.json'] });
  });

  test('D1-F2: a remover that cannot take the tally lock defers and deletes nothing', () => {
    const dir = tmp(); const epoch = epochOf(dir); owe(dir, 'sl', 1, { closed: true }); passing(dir, epoch, { settled: { sl: 1 } });
    let done = true;
    withLock(join(dir, 'write-comparisons.lock'), () => { done = worker(dir, epoch, 'sl').finish(); }); // another process holds the lock
    expect(done).toBe(false);
    expect(readOwed(dir, 'sl')).toMatchObject({ owed: 1 });
    expect(worker(dir, epoch, 'sl').finish()).toBe(true); // the next pass, with the lock free, removes it
  }, 15_000);

  test('a pending marker keeps its session out of every remover and out of the pruning, and status blocks on it by name (counted once)', () => {
    const dir = tmp(); const epoch = epochOf(dir);
    owe(dir, 'sm', 1, { child_exited: true }); passing(dir, epoch, { settled: { sm: 1 } });
    linkSync(owedPath(dir, 'sm'), marker(dir, 'sm')); // what the supervisor makes when a record write fails
    worker(dir, epoch, 'owner').recover(); // the orphan pass: its child exited and everything is settled, which would remove the file
    expect(existsSync(owedPath(dir, 'sm'))).toBe(true);
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1, outstanding_sessions: ['write-pending.sm.json'] });
    rmSync(owedPath(dir, 'sm')); // the worker removed its own file: the marker keeps the credit
    worker(dir, epoch, 'other').note('comparable', undefined, 1, false, 0); // an unrelated owner save runs the pruning
    expect(readWriteTally(dir, epoch)!.settled?.sm).toBe(1); // was pruned: no owed file stood for it
    rmSync(marker(dir, 'sm'));
    expect(stat(dir)).toMatchObject({ state: 'measured' });
  });

  test('the orphan pass books nothing for a marked session: the stale record\'s count is not the obligation, so it is neither booked nor removed', () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch);
    owe(dir, 'sb', 1, { child_exited: true }); linkSync(owedPath(dir, 'sb'), marker(dir, 'sb'));
    worker(dir, epoch, 'owner').recover();
    expect(readWriteTally(dir, epoch)!.uncomparable).toBe(0); // nothing booked on the stale count
    expect(readOwed(dir, 'sb')).toMatchObject({ owed: 1 });
    rmSync(marker(dir, 'sb')); // the marker is cleared (the full record is durable): now the pass books what is unsettled, once
    worker(dir, epoch, 'owner').recover();
    expect(readWriteTally(dir, epoch)!.uncomparable).toBe(1);
  });

  test('a marker that cannot be listed blocks status; it never reads as no markers', async () => {
    const dir = tmp(); const epoch = epochOf(dir); passing(dir, epoch); owe(dir, 'sq', 0);
    const fs = await import('node:fs'); const realList = fs.readdirSync;
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => { if (String(p) === dir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return (realList as (...a: unknown[]) => unknown)(p, ...rest); }) as never);
    try { expect(stat(dir)).toMatchObject({ state: 'capability_missing' }); } finally { spy.mockRestore(); }
  });
});
