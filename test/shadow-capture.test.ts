/**
 * Shadow capture (src/shadow/capture.ts, capture-lock.ts), on in-memory engines.
 *
 * Protects: capture records calls, arguments and transaction outcomes (results only as a hash) and writes nothing
 * when the kill switch is set (env or off marker), deleting nothing; every purge path runs the one purge owner, which
 * deletes every recording, in every epoch state, at once in the purging process, also with capture off and across a
 * reconnect; a record buffered before a purge never lands in the next epoch; the seal handshake waits for every live
 * recorder, so a call that started before the seal is never missing from a sealed epoch without the seal saying so;
 * the replay lock is exclusive and never taken over; capture delete and stop --delete take it first; capture faults
 * and oversized arguments never reach the brain process; a guard test lists every purge and delete path from source.
 * Real PGLite runs in test/shadow-capture.serial.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { appendPurgeIntent } from '../src/core/belief/purge-mirror.ts';
import {
  attachCapture, basesDir, CAPTURE_LIMITS, CaptureWriter, epochDir, purgeIfLogChanged, purgeCapture, retireEpoch, readEpoch, readSegment,
  recordersDir, sealEpoch, startEpoch, watchPurges, wrapCaptureEngine, type CaptureRecord,
} from '../src/shadow/capture.ts';
import { captureDir, captureOffMarker, writePrivateJson } from '../src/shadow/capture-state.ts';
import { acquireReplayLock } from '../src/shadow/capture-lock.ts';
import { decodeValue, encodeArgs } from '../src/shadow/codec.ts';
import { configDir } from '../src/core/config.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-capture-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A small in-memory brain. `dropWrites` returns the right receipt but stores nothing (the negative control). */
function fakeEngine(opts: { wrongRename?: boolean; dropAliases?: boolean; dropWrites?: boolean; dropSource?: string; alterFrontmatter?: boolean; idPrefix?: string; due?: string; strictRevision?: boolean; wrongTimeline?: boolean; wrongChunks?: boolean } = {}) {
  const chunks = new Map<string, Array<{ chunk_text: string }>>();
  const aliases = new Map<string, string[]>();
  const timeline = new Map<string, Array<{ summary: string }>>();
  const pages = new Map<string, { slug: string; title: string; compiled_truth: string; frontmatter: Record<string, unknown>; updated_at: string }>();
  const scoped = new Map<string, { slug: string; title: string }>();
  let n = 0;
  const engine = {
    kind: 'pglite',
    async putPage(slug: string, p: { title: string; compiled_truth: string; frontmatter?: Record<string, unknown> }, o?: { sourceId?: string; expectedRevision?: string }) {
      if (o?.expectedRevision && opts.strictRevision) throw Object.assign(new Error('stale'), { code: 'revision_conflict' });
      if (o?.sourceId) { if (opts.dropSource !== o.sourceId) scoped.set(`${o.sourceId}:${slug}`, { slug, title: p.title }); return { slug }; }
      const fm = opts.alterFrontmatter ? Object.fromEntries(Object.keys(p.frontmatter ?? {}).map(k => [k, 'changed'])) : p.frontmatter ?? {};
      const row = { slug, title: p.title, compiled_truth: p.compiled_truth, frontmatter: fm, updated_at: new Date().toISOString() };
      if (!opts.dropWrites) pages.set(slug, row);
      return { slug, id: `${opts.idPrefix ?? '0000'}${String(++n).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36) };
    },
    async getPage(slug: string, o?: { sourceId?: string }) { return o?.sourceId ? scoped.get(`${o.sourceId}:${slug}`) ?? null : pages.get(slug) ?? null; },
    async refreshPageBody(slug: string, sourceId: string, body: string) {
      if (opts.dropSource !== sourceId) scoped.set(`${sourceId}:${slug}`, { slug, title: body });
    },
    async replaceDerivedAliases(slug: string, sourceId: string, rows: Array<{ alias_norm: string }>) {
      if (!opts.dropAliases) aliases.set(`${sourceId}:${slug}`, rows.map(r => r.alias_norm));
    },
    async setPageAliases(slug: string, sourceId: string, norms: string[]) {
      if (!opts.dropAliases) aliases.set(`${sourceId}:${slug}`, norms);
    },
    async getEmbeddingsByChunkIds(_ids: unknown, column?: unknown) { return { column_given: column !== undefined, column_null: column === null }; },
    async getTags() { return []; },
    async getLinks() { return []; },
    async getBacklinks() { return []; },
    async getTimeline(slug: string) { return timeline.get(slug) ?? []; },
    // Like the real engines: chunks written but not sealed yet are read only with includeUnsealed.
    async getChunks(slug: string, o?: { includeUnsealed?: boolean }) { return o?.includeUnsealed ? chunks.get(slug) ?? [] : []; },
    async upsertChunks(slug: string, rows: Array<{ chunk_text: string }>) { chunks.set(slug, rows.map(r => ({ chunk_text: opts.wrongChunks ? 'other text' : r.chunk_text }))); },
    async addTimelineEntriesBatch(rows: Array<{ slug: string; summary: string }>) {
      for (const r of rows) timeline.set(r.slug, [...(timeline.get(r.slug) ?? []), { summary: opts.wrongTimeline ? 'something else' : r.summary }]);
      return rows.length;
    },
    async updateSlug(oldSlug: string, newSlug: string) {
      const p = pages.get(oldSlug); if (!p) return 0;
      pages.delete(oldSlug); pages.set(opts.wrongRename ? 'notes/wrong' : newSlug, { ...p, slug: newSlug }); return 1;
    },
    async getStats() { return { page_count: pages.size, ...(opts.due ? { due: opts.due } : {}) }; },
    async searchKeyword(q: string) { return [...pages.values()].filter(p => p.compiled_truth.includes(q)).map(p => ({ slug: p.slug })); },
    async transaction<T>(fn: (e: unknown) => Promise<T>) {
      const snapshot = new Map(pages);
      try { return await fn(engine); } catch (e) { pages.clear(); for (const [k, v] of snapshot) pages.set(k, v); throw e; }
    },
    registerBeforeDisconnect() {},
    async disconnect() {},
  };
  return engine;
}

/** A capture dir with a recording epoch and an empty purge-log home. */
/**
 * A capture that is on with a recording epoch. `defaultHome`: its purge baseline comes from the default config home,
 * the one `capture on` reads, for tests that run the command (otherwise a private temporary home).
 */
function recordingCapture(opts: { defaultHome?: boolean } = {}): { cap: string; home: string; shadowDir: string } {
  const root = tmp();
  const home = opts.defaultHome ? configDir() : join(root, 'home');
  if (!opts.defaultHome) { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'config.json'), '{}'); }
  const shadowDir = join(root, 'shadow', 'pglite-abc');
  const cap = captureDir(shadowDir);
  writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: true, turned_on_at: '2026-11-22T00:00:00.000Z' });
  startEpoch(cap, home);
  return { cap, home, shadowDir };
}

function segmentRecords(cap: string): CaptureRecord[] {
  const e = readEpoch(cap)!;
  const dir = epochDir(cap, e.id);
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => readSegment(join(dir, f)).records);
}


const PRIVATE = { slug: 'people/zelda-secretname', title: 'Zelda Secretname', body: 'quarterly plan for project nightjar', key: 'secret_project_key' };

async function recordSession(cap: string, home: string, extra: (e: BrainEngine) => Promise<unknown> = async () => {}): Promise<CaptureRecord[]> {
  const writer = new CaptureWriter(cap, home, {});
  const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
  await extra(e);
  await e.putPage(PRIVATE.slug, { title: PRIVATE.title, compiled_truth: PRIVATE.body, frontmatter: { [PRIVATE.key]: 'x' } } as never);
  await e.transaction(async tx => { await tx.putPage('notes/tx-kept', { title: 'kept', compiled_truth: 'kept body' } as never); });
  await e.transaction(async tx => { await tx.putPage('notes/tx-rolled', { title: 'gone', compiled_truth: 'gone' } as never); throw new Error('abort'); }).catch(() => undefined);
  await e.getPage(PRIVATE.slug);
  await e.searchKeyword('nightjar' as never);
  await writer.flush();
  return segmentRecords(cap);
}

describe('capture and purge', () => {
  test('records calls, arguments and transaction outcomes; results only as a hash', async () => {
    const { cap, home } = recordingCapture();
    const recs = await recordSession(cap, home);
    const kinds = recs.map(r => r.kind === 'tx' ? `tx:${r.phase}` : `${r.kind}:${r.member}`);
    expect(kinds).toContain('engine:putPage');
    expect(kinds).toContain('tx:committed');
    expect(kinds).toContain('tx:rolled_back');
    const get = recs.find(r => r.member === 'getPage')!;
    expect(get.h).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(get)).not.toContain(PRIVATE.body);
    // The rolled-back transaction's calls are recorded inside a group a replay can skip, never as standalone calls.
    const rolled = recs.find(r => r.kind === 'tx' && r.phase === 'rolled_back')!;
    expect(recs.filter(r => r.member === 'putPage' && JSON.stringify(r.args).includes('notes/tx-rolled')).every(r => r.tx === rolled.tx)).toBe(true);
  });
  test('kill switch: the off marker and GBRAIN_SHADOW_CAPTURE=off stop the next flush and delete nothing', async () => {
    const { cap, home } = recordingCapture();
    const before = await recordSession(cap, home);
    expect(before.length).toBeGreaterThan(0);
    writeFileSync(captureOffMarker(cap), 'now');
    const writer = new CaptureWriter(cap, home, {});
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    await e.getPage('a');
    await writer.flush();
    rmSync(captureOffMarker(cap));
    const envOff = new CaptureWriter(cap, home, { GBRAIN_SHADOW_CAPTURE: 'off' });
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, envOff).getPage('b');
    await envOff.flush();
    expect(segmentRecords(cap).length).toBe(before.length);
  });
  test('a new purge-log line deletes the whole epoch: recording and copies', async () => {
    const { cap, home } = recordingCapture();
    await recordSession(cap, home);
    const id = readEpoch(cap)!.id;
    mkdirSync(join(basesDir(cap, id), 'pglite'), { recursive: true });
    appendPurgeIntent({ request: 'r1', request_id: 'q1', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(purgeIfLogChanged(cap, home)).toBe(true);
    expect(readEpoch(cap)!.state).toBe('invalidated');
    expect(existsSync(epochDir(cap, id))).toBe(false);
    expect(existsSync(basesDir(cap, id))).toBe(false);
  });
  test('a purge in a recording process deletes the epoch at once, through the purge listener', async () => {
    const { cap, home } = recordingCapture();
    const id = readEpoch(cap)!.id;
    const engine = fakeEngine() as unknown as BrainEngine;
    watchPurges(cap);
    const e = attachCapture(engine, cap);
    appendPurgeIntent({ request: 'r2', request_id: 'q2', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(existsSync(epochDir(cap, id))).toBe(false);
    await e.getPage('x');
  });
  test('a purge log that cannot be read fails closed', () => {
    const { cap } = recordingCapture();
    const notADir = join(tmp(), 'file');
    writeFileSync(notADir, '');
    expect(purgeIfLogChanged(cap, join(notADir, 'home'))).toBe(true);
  });
  test('an explicit undefined argument replays as undefined, not null', async () => {
    const { cap, home } = recordingCapture();
    const recs = await recordSession(cap, home, e => (e as unknown as { getEmbeddingsByChunkIds(a: unknown, b?: unknown): Promise<unknown> }).getEmbeddingsByChunkIds([1], undefined));
    const rec = recs.find(r => r.member === 'getEmbeddingsByChunkIds')!;
    expect((decodeValue(rec.args) as unknown[]).length).toBe(2);
    expect((decodeValue(rec.args) as unknown[])[1]).toBeUndefined();
  });
  test('a purge deletes recordings and copies a crashed nightly run left behind, not only the current epoch', async () => {
    const { cap, home, shadowDir } = recordingCapture();
    for (const p of [join(cap, 'epoch-old'), join(cap, 'bases', 'old', 'pglite'), join(shadowDir, 'replay', 'run-x', 'segments'), join(shadowDir, 'replay', 'run-x', 'work'), join(shadowDir, 'replay', 'run-x', 'out')]) mkdirSync(p, { recursive: true });
    appendPurgeIntent({ request: 'r7', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(purgeIfLogChanged(cap, home)).toBe(true);
    for (const p of [join(cap, 'epoch-old'), join(cap, 'bases', 'old'), join(shadowDir, 'replay', 'run-x', 'segments'), join(shadowDir, 'replay', 'run-x', 'work')]) expect(existsSync(p)).toBe(false);
    expect(existsSync(join(shadowDir, 'replay', 'run-x', 'out'))).toBe(true);
  });
  test('capture wraps only engine members; other function-valued properties come back untouched', async () => {
    const { cap, home } = recordingCapture();
    const handle = Object.assign((() => 'q') as unknown as Record<string, unknown>, { unsafe: () => 'u', options: { max: 1 } });
    const engine = { ...fakeEngine(), sql: handle } as unknown as BrainEngine;
    const e = wrapCaptureEngine(engine, new CaptureWriter(cap, home, {}));
    expect((e as unknown as { sql: unknown }).sql).toBe(handle);
    expect(typeof (e as unknown as { sql: { unsafe: unknown } }).sql.unsafe).toBe('function');
  });
  test('an argument over the capture budget becomes a gap before it is copied, and the call still answers', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    // 40,000 items of 100 characters (4 MB): encoding must stop near the 1 MiB budget, not walk every item first.
    const items = Array.from({ length: 40_000 }, () => 'x'.repeat(100));
    let read = 0;
    const counted = new Proxy(items, { get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) read++; return Reflect.get(t, k, r); } });
    expect(await e.getPage(counted as never)).toBeNull();
    expect(read).toBeLessThan(items.length / 2);
    await writer.flush();
    const recs = segmentRecords(cap);
    expect(recs.some(r => r.kind === 'gap' && r.reason === 'too_large' && r.member === 'getPage')).toBe(true);
    expect(recs.some(r => r.kind === 'engine' && r.member === 'getPage')).toBe(false);
  });
  test('a record buffered before a purge never lands in the next epoch', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    await e.getPage(PRIVATE.slug); // buffered, not flushed yet
    appendPurgeIntent({ request: 'r10', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    purgeIfLogChanged(cap, home);
    await Bun.sleep(5);
    startEpoch(cap, home);
    await writer.flush();
    expect(JSON.stringify(segmentRecords(cap))).not.toContain(PRIVATE.slug);
  });
  test('calls lost to a disk or budget stop are recorded as a gap once writing resumes', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    const w = writer as unknown as { lowDisk: boolean; freeCheckedAt: number };
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    w.lowDisk = true; w.freeCheckedAt = Date.now();
    await e.getPage('a');
    await writer.flush();
    w.lowDisk = false;
    await e.getPage('b');
    await writer.flush();
    expect(segmentRecords(cap).some(r => r.kind === 'gap' && r.reason === 'budget' && r.count === 1)).toBe(true);
  });
  test('a capture fault in a flush never reaches the brain process', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    (writer as unknown as { target(): never }).target = () => { throw new Error('EACCES'); };
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    expect(await e.getPage('a')).toBeNull();
    expect(() => writer.flushSync()).not.toThrow(); // the exit hook
    expect(await e.getPage('b')).toBeNull();
    await expect(writer.flush()).resolves.toBeUndefined(); // the timer flush
  });
  test('a purge deletes a recording kept for retry even when the current epoch is already invalidated', async () => {
    const { cap, home } = recordingCapture();
    const kept = readEpoch(cap)!.id;
    mkdirSync(join(basesDir(cap, kept), 'pglite'), { recursive: true });
    writePrivateJson(join(cap, 'retry.json'), { pointer: readEpoch(cap), attempts: 1 });
    startEpoch(cap, home); // the next epoch, whose seed then failed
    retireEpoch(cap, 'seed_failed');
    expect(existsSync(epochDir(cap, kept))).toBe(true);
    const e = fakeEngine() as unknown as BrainEngine;
    watchPurges(cap);
    appendPurgeIntent({ request: 'r11', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(existsSync(epochDir(cap, kept))).toBe(false);
    expect(existsSync(basesDir(cap, kept))).toBe(false);
  });
  test('the purge listener survives a reconnect (disconnect then connect on the same engine)', async () => {
    const { cap, home } = recordingCapture();
    const id = readEpoch(cap)!.id;
    // The listener belongs to the process, not to an engine: a reconnect (or a second engine) cannot remove it.
    watchPurges(cap);
    watchPurges(cap);
    appendPurgeIntent({ request: 'r12', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(existsSync(epochDir(cap, id))).toBe(false);
  });
});

describe('replay lock and destructive delete', () => {
  test('the replay lock is exclusive: a second run is refused until the first unlocks', () => {
    const dir = tmp();
    const unlock = acquireReplayLock(dir, 60_000);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/shadow_replay_busy/);
    unlock();
    acquireReplayLock(dir, 60_000)();
  });
  test('the lock file is never seen empty', () => {
    const dir = tmp();
    const unlock = acquireReplayLock(dir, 60_000);
    expect(readFileSync(join(dir, 'lock'), 'utf8').trim().split(' ').length).toBe(3);
    unlock();
    expect(readdirSync(dir).filter(f => f.startsWith('lock'))).toEqual([]);
  });
  test('a stale lock is never reclaimed automatically; the error names it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'lock'), `999999999 ${Date.now() - 1} old\n`);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/stale lock .*remove it/);
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toContain('old');
  });
  test('a contender with a shorter budget cannot take a live run\'s lock, nor a dead one\'s', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'lock'), `${process.pid} ${Date.now() + 3_600_000} tok\n`);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/shadow_replay_busy/);
    writeFileSync(join(dir, 'lock'), `${process.pid} ${Date.now() - 1} tok\n`); // past its deadline but alive
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/shadow_replay_busy/);
    writeFileSync(join(dir, 'lock'), `999999999 ${Date.now() - 1} tok\n`);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/stale lock/);
  });

  test('capture delete refuses while a replay holds the lock, and deletes nothing', async () => {
    const { cap, shadowDir } = recordingCapture();
    const unlock = acquireReplayLock(join(shadowDir, 'replay'), 60_000);
    try {
      const { runShadowCaptureCommand } = await import('../src/commands/engine-shadow-capture.ts');
      const lines: string[] = [];
      const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date(), brain: { key: 'pglite-abc', dir: shadowDir, engine: 'pglite' }, config: () => null, openPrimary: async () => { throw new Error('unused'); } };
      await expect(runShadowCaptureCommand(['delete', '--yes'], io as never)).rejects.toThrow(/shadow_replay_busy/);
      expect(existsSync(epochDir(cap, readEpoch(cap)!.id))).toBe(true);
      expect(existsSync(join(shadowDir, 'replay', 'lock'))).toBe(true);
    } finally { unlock(); }
  });
  test('shadow stop --delete refuses while a replay holds the lock, and deletes nothing', async () => {
    const { cap, shadowDir } = recordingCapture();
    const unlock = acquireReplayLock(join(shadowDir, 'replay'), 60_000);
    try {
      const { __stopForTests } = await import('../src/commands/engine-shadow.ts');
      await expect(__stopForTests({ key: 'pglite-abc', dir: shadowDir, engine: 'pglite' }, true, () => {})).rejects.toThrow(/shadow_replay_busy/);
      expect(existsSync(epochDir(cap, readEpoch(cap)!.id))).toBe(true);
      expect(existsSync(join(shadowDir, 'replay', 'lock'))).toBe(true);
    } finally { unlock(); }
  });
});

describe('seal handshake', () => {
  /** A fake engine whose getPage waits until `release()`. */
  function slowEngine() {
    let release!: () => void;
    const e = { ...fakeEngine(), getPage: () => new Promise(r => { release = () => r(null); }) } as unknown as BrainEngine;
    return { e, release: () => release() };
  }

  test('a call that started before the seal and finishes during it lands in the sealed epoch; the seal waits for it', async () => {
    const { cap, home } = recordingCapture();
    const sealedId = readEpoch(cap)!.id;
    const { e, release } = slowEngine();
    const pending = wrapCaptureEngine(e, new CaptureWriter(cap, home, {})).getPage(PRIVATE.slug);
    await Bun.sleep(5); // the call starts strictly before the seal (a call starting at the seal's own instant belongs to the next epoch)
    const seal = sealEpoch(cap, { home, timeoutMs: 5_000 });
    await Bun.sleep(300);
    expect(readEpoch(cap)!.state).toBe('sealing'); // still waiting for the in-flight call
    release();
    await pending;
    const r = (await seal)!;
    expect(r.unacked).toBe(0);
    const inSealed = readdirSync(epochDir(cap, sealedId)).filter(f => f.endsWith('.jsonl')).flatMap(f => readSegment(join(epochDir(cap, sealedId), f)).records);
    expect(inSealed.some(x => x.member === 'getPage')).toBe(true);
    expect(readEpoch(cap)!.id).toBe(r.next.id);
  });

  test('a recorder that never finishes its call is reported as unacknowledged, never counted as complete', async () => {
    const { cap, home } = recordingCapture();
    const { e } = slowEngine();
    void wrapCaptureEngine(e, new CaptureWriter(cap, home, {})).getPage('notes/stuck');
    await Bun.sleep(5);
    const r = (await sealEpoch(cap, { home, timeoutMs: 400 }))!;
    expect(r.unacked).toBe(1);
  });

  test('a call that starts after the seal began goes to the next epoch, even while the seal still waits', async () => {
    const { cap, home } = recordingCapture();
    const sealedId = readEpoch(cap)!.id;
    const writer = new CaptureWriter(cap, home, {});
    const { e, release } = slowEngine();
    const slow = wrapCaptureEngine(e, writer).getPage('notes/before'); // keeps the seal waiting
    await Bun.sleep(5);
    const seal = sealEpoch(cap, { home, timeoutMs: 5_000 });
    await Bun.sleep(50);
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats(); // starts after the seal began
    await Bun.sleep(200);
    release();
    await slow;
    const r = (await seal)!;
    await writer.flush();
    const records = (id: string) => readdirSync(epochDir(cap, id)).filter(f => f.endsWith('.jsonl')).flatMap(f => readSegment(join(epochDir(cap, id), f)).records);
    expect(records(sealedId).map(x => x.member)).toEqual(['getPage']);
    expect(records(r.next.id).some(x => x.member === 'getStats')).toBe(true);
  });

  test('a recorder registers at its first call, before its first record exists', async () => {
    const { cap, home } = recordingCapture();
    const { e, release } = slowEngine();
    const pending = wrapCaptureEngine(e, new CaptureWriter(cap, home, {})).getPage('notes/x');
    expect(readdirSync(recordersDir(cap)).length).toBe(1);
    release();
    await pending;
  });
});

describe('review round 1: consent, purge retry, seal accounting', () => {
  function slowEngine() {
    let release!: () => void;
    const e = { ...fakeEngine(), getPage: () => new Promise(r => { release = () => r(null); }) } as unknown as BrainEngine;
    return { e, release: () => release() };
  }
  const recordsIn = (cap: string, id: string) => existsSync(epochDir(cap, id))
    ? readdirSync(epochDir(cap, id)).filter(f => f.endsWith('.jsonl')).flatMap(f => readSegment(join(epochDir(cap, id), f)).records) : [];
  const captureIo = (shadowDir: string) => ({ out: () => {}, err: () => {}, now: () => new Date(), brain: { key: 'pglite-abc', dir: shadowDir } });
  /** A pid that no process has: a child that already exited. */
  const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

  test('capture turned off (marker or environment) while a seal waits: the drain writes no argument and says the epoch is incomplete', async () => {
    for (const how of ['marker', 'env'] as const) {
      const { cap, home } = recordingCapture();
      const sealedId = readEpoch(cap)!.id;
      const env: Record<string, string | undefined> = {};
      const { e, release } = slowEngine();
      const pending = wrapCaptureEngine(e, new CaptureWriter(cap, home, env)).getPage(PRIVATE.slug);
      const seal = sealEpoch(cap, { home, timeoutMs: 5_000 });
      if (how === 'marker') writeFileSync(captureOffMarker(cap), 'off\n'); else env.GBRAIN_SHADOW_CAPTURE = 'off';
      release();
      await pending;
      const r = (await seal)!;
      expect(JSON.stringify(recordsIn(cap, sealedId))).not.toContain(PRIVATE.slug);
      expect(r.unacked).toBe(1);
    }
  });

  test('a seal waits for an append still in progress before it is acknowledged', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats();
    let finish!: () => void;
    (writer as unknown as { flushing: Promise<void> | null }).flushing = new Promise<void>(r => { finish = r; }); // an append held by the disk
    const seal = sealEpoch(cap, { home, timeoutMs: 5_000 });
    await Bun.sleep(400);
    expect(readEpoch(cap)!.state).toBe('sealing');
    (writer as unknown as { flushing: Promise<void> | null }).flushing = null;
    finish();
    expect((await seal)!.unacked).toBe(0);
  });

  test('a purge whose pointer cannot be written still deletes every recording', () => {
    const { cap, home } = recordingCapture();
    const id = readEpoch(cap)!.id;
    writeFileSync(join(epochDir(cap, id), 'p.jsonl'), `${JSON.stringify({ args: [PRIVATE.slug] })}\n`);
    mkdirSync(`${join(cap, 'epoch.json')}.${process.pid}.tmp`); // the pointer's temp file cannot be created
    expect(() => purgeCapture(cap)).not.toThrow();
    expect(existsSync(epochDir(cap, id))).toBe(false);
    void home;
  });

  test('a purge whose deletion stopped part way (crash, undeletable file) is finished by the next check and before capture on', async () => {
    for (const via of ['check', 'capture on'] as const) {
      const { cap, shadowDir } = recordingCapture({ defaultHome: true });
      const p = readEpoch(cap)!;
      writeFileSync(join(epochDir(cap, p.id), 'p.jsonl'), `${JSON.stringify({ args: [PRIVATE.slug] })}\n`);
      writePrivateJson(join(cap, 'epoch.json'), { ...p, state: 'invalidated', reason: 'purge' }); // the crash came right after this write
      if (via === 'check') expect(purgeIfLogChanged(cap)).toBe(true);
      else {
        const { runShadowCaptureCommand } = await import('../src/commands/engine-shadow-capture.ts');
        expect(await runShadowCaptureCommand(['on', '--yes'], captureIo(shadowDir) as never)).toBe(0);
      }
      expect(existsSync(epochDir(cap, p.id))).toBe(false);
      expect(purgeIfLogChanged(cap)).toBe(false); // done: not repeated
    }
  });

  test('a data field named signal is recorded; a real cancellation signal is left out', () => {
    const [enc] = encodeArgs([{ frontmatter: { signal: 'buy' }, signal: new AbortController().signal }]) as Array<Record<string, unknown>>;
    expect(enc).toEqual({ frontmatter: { signal: 'buy' } });
  });

  test('a call that started while capture was off is never recorded, even if it finishes after capture is on again', async () => {
    const { cap, shadowDir, home } = recordingCapture({ defaultHome: true });
    writeFileSync(captureOffMarker(cap), 'off\n');
    const writer = new CaptureWriter(cap, home, {});
    const { e, release } = slowEngine();
    const pending = wrapCaptureEngine(e, writer).getPage(PRIVATE.slug);
    const { runShadowCaptureCommand } = await import('../src/commands/engine-shadow-capture.ts');
    await runShadowCaptureCommand(['on', '--yes'], captureIo(shadowDir) as never);
    release();
    await pending;
    await writer.flush();
    expect(JSON.stringify(segmentRecords(cap))).not.toContain(PRIVATE.slug);
  });

  test('capture off then on starts a fresh recording; on while already on keeps it', async () => {
    const { cap, shadowDir } = recordingCapture({ defaultHome: true });
    const first = readEpoch(cap)!.id;
    const { runShadowCaptureCommand } = await import('../src/commands/engine-shadow-capture.ts');
    await runShadowCaptureCommand(['on', '--yes'], captureIo(shadowDir) as never);
    expect(readEpoch(cap)!.id).toBe(first);
    await runShadowCaptureCommand(['off'], captureIo(shadowDir) as never);
    await runShadowCaptureCommand(['on', '--yes'], captureIo(shadowDir) as never);
    expect(readEpoch(cap)!.id).not.toBe(first);
  });

  test('a record buffered before a purge never lands in a new epoch, even one that starts at the same instant or earlier', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getPage(PRIVATE.slug);
    appendPurgeIntent({ request: 'r20', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    purgeIfLogChanged(cap, home);
    startEpoch(cap, home, new Date(Date.now() - 60_000)); // a clock set back
    await writer.flush();
    expect(JSON.stringify(segmentRecords(cap))).not.toContain(PRIVATE.slug);
  });

  test('a disconnected engine stops its seal watcher and unregisters once everything is written', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats();
    expect(readdirSync(recordersDir(cap))).toHaveLength(1);
    await writer.close();
    expect(readdirSync(recordersDir(cap))).toHaveLength(0);
    expect((writer as unknown as { ticker: unknown }).ticker).toBeNull();
    expect(segmentRecords(cap).some(r => r.member === 'getStats')).toBe(true);
  });

  test('a recorder that died without its exit flush is never counted as complete; a clean exit is', async () => {
    const { cap, home } = recordingCapture();
    writePrivateJson(join(recordersDir(cap), 'dead-1.json'), { pid: deadPid() });
    const r1 = (await sealEpoch(cap, { home, timeoutMs: 1_000 }))!;
    expect(r1.unacked).toBe(1);
    // Died after acknowledging a seal: the doubt goes to the next epoch.
    const writer = new CaptureWriter(cap, home, {});
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats();
    await writer.flush();
    const proc = readdirSync(recordersDir(cap)).find(f => f.endsWith('.json'))!;
    writePrivateJson(join(recordersDir(cap), 'dead-2.json'), { pid: deadPid() });
    writeFileSync(join(epochDir(cap, readEpoch(cap)!.id), 'ack-dead-2'), '');
    const r2 = (await sealEpoch(cap, { home, timeoutMs: 1_000 }))!;
    expect(r2.next.unverified).toBe(1);
    // A clean exit removes its registration: the next seal does not wait for it or count it.
    writer.flushSync();
    expect(existsSync(join(recordersDir(cap), proc))).toBe(false);
    expect((await sealEpoch(cap, { home, timeoutMs: 1_000 }))!.unacked).toBe(0);
  });

  test('calls lost while a seal waits are counted in the epoch they belong to, not the sealed one', async () => {
    const { cap, home } = recordingCapture();
    const sealedId = readEpoch(cap)!.id;
    const writer = new CaptureWriter(cap, home, {});
    const { e, release } = slowEngine();
    const slow = wrapCaptureEngine(e, writer).getPage('notes/before');
    const seal = sealEpoch(cap, { home, timeoutMs: 5_000 });
    const limit = CAPTURE_LIMITS.bufferBytes;
    CAPTURE_LIMITS.bufferBytes = 1;
    try { await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats(); } finally { CAPTURE_LIMITS.bufferBytes = limit; }
    release();
    await slow;
    const r = (await seal)!;
    await writer.flush();
    expect(recordsIn(cap, sealedId).some(x => x.kind === 'gap')).toBe(false);
    expect(recordsIn(cap, r.next.id).some(x => x.kind === 'gap' && x.reason === 'buffer_full' && x.count === 1)).toBe(true);
  });
});

describe('final fix round: disconnect faults, consecutive seals, exit with unfinished work, reconnect', () => {
  function slowEngine() {
    let release!: () => void;
    const e = { ...fakeEngine(), getPage: () => new Promise(r => { release = () => r(null); }) } as unknown as BrainEngine;
    return { e, release: () => release() };
  }
  const regs = (cap: string) => existsSync(recordersDir(cap)) ? readdirSync(recordersDir(cap)).filter(f => f.endsWith('.json')).length : 0;

  test('a registration that cannot be removed never fails the disconnect', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    await wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer).getStats();
    const reg = join(recordersDir(cap), `${writer.proc}.json`);
    rmSync(reg);
    mkdirSync(join(reg, 'x'), { recursive: true }); // unlink now fails (a directory), like an unwritable folder
    await expect(writer.close()).resolves.toBeUndefined();
    expect(existsSync(reg)).toBe(true); // kept: a seal counts it, never as complete
  });

  test('the second of two seals in a row waits for a call that started during the first, and keeps its record', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    const a = slowEngine();
    const callA = wrapCaptureEngine(a.e, writer).getPage('notes/a');
    const seal1 = sealEpoch(cap, { home, timeoutMs: 5_000 });
    const b = slowEngine();
    const callB = wrapCaptureEngine(b.e, writer).getPage('notes/b'); // starts during the first seal: the next epoch's
    a.release();
    await callA;
    const r1 = (await seal1)!;
    const seal2 = sealEpoch(cap, { home, timeoutMs: 5_000 });
    await Bun.sleep(300);
    expect(readEpoch(cap)!.state).toBe('sealing'); // still waiting for call B
    b.release();
    await callB;
    expect((await seal2)!.unacked).toBe(0);
    const inR1 = readdirSync(epochDir(cap, r1.next.id)).filter(f => f.endsWith('.jsonl')).flatMap(f => readSegment(join(epochDir(cap, r1.next.id), f)).records);
    expect(inR1.map(x => x.args)).toContainEqual(['notes/b']);
  });

  test('an exit with a call still running keeps the registration, so the next seal does not claim it complete', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    void wrapCaptureEngine(slowEngine().e, writer).getPage('notes/running');
    writer.flushSync();
    expect(regs(cap)).toBe(1);
  });

  test('an engine that clears its disconnect hooks (Rust) still retires the recorder after a reconnect', async () => {
    const root = tmp();
    const cap = captureDir(join(root, 'shadow', 'pglite-abc'));
    writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: true, turned_on_at: '2026-11-22T00:00:00.000Z' });
    startEpoch(cap); // the same purge-log home attachCapture's writer reads
    const hooks = new Set<() => Promise<void>>();
    const base = {
      ...fakeEngine(),
      registerBeforeDisconnect(fn: () => Promise<void>) { hooks.add(fn); return () => { hooks.delete(fn); }; },
      async disconnect() { const stops = [...hooks]; hooks.clear(); for (const f of stops) await f(); },
    };
    const e = attachCapture(base as unknown as BrainEngine, cap);
    await e.getStats();
    expect(regs(cap)).toBe(1);
    await e.disconnect();
    expect(regs(cap)).toBe(0);
    await e.getStats(); // reconnected and used again
    expect(regs(cap)).toBe(1);
    await e.disconnect();
    expect(regs(cap)).toBe(0);
  });
});

describe('purge and delete paths (guard)', () => {
  test('every function that sees a purge calls purgeCapture, only purgeCapture deletes everything, and destructive deletes take the lock', () => {
    const root = join(import.meta.dir, '..', 'src');
    const files = ['shadow/capture.ts', 'shadow/capture-state.ts', 'shadow/capture-lock.ts', 'commands/engine-shadow-capture.ts', 'commands/engine-shadow.ts'];
    const fns: Array<{ file: string; name: string; body: string }> = [];
    for (const f of files) {
      // test-reads-source-ok[structural]: the guarantee covers every purge and delete path in the source, including ones a future change adds, so the guard lists them from the source text.
      const text = readFileSync(join(root, f), 'utf8');
      // Each top-level function runs from its declaration to the next top-level declaration (one-liners included).
      const starts = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
      const decls = [...text.matchAll(/^(?:export )?(?:async )?(?:function|const|let|class|interface|type) /gm)].map(m => m.index!);
      for (const m of starts) fns.push({ file: f, name: m[1]!, body: text.slice(m.index!, decls.find(i => i > m.index!) ?? text.length) });
    }
    const inBody = (f: { body: string }, re: RegExp) => re.test(f.body.slice(f.body.indexOf(')')));
    const named = (re: RegExp) => fns.filter(f => inBody(f, re)).map(f => f.name).sort();
    expect(named(/purgeLogChanged\(|onPurgeIntent\(/)).toEqual(['purgeIfLogChanged', 'watchPurges']);
    for (const f of fns.filter(f => inBody(f, /purgeLogChanged\(|onPurgeIntent\(/))) expect(`${f.name}: ${/purgeCapture\(/.test(f.body)}`).toBe(`${f.name}: true`);
    expect(named(/deleteAllCaptureData\(/)).toEqual(['purgeCapture']);
    expect(named(/deleteReplayState\(/)).toEqual(['runShadowCaptureCommand', 'stop']);
    expect(named(/acquireReplayLock\(/)).toEqual(['deleteReplayState']);
    expect(fns.filter(f => f.file.startsWith('commands/') && /rmSync\([^)]*(brain\.dir|join\(cap)/.test(f.body)).map(f => f.name)).toEqual([]);
  });
});

