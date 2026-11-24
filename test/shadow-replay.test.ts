/**
 * Shadow replay, capture and comparison (src/shadow/capture.ts, replay.ts, replay-copy.ts), on in-memory engines.
 *
 * Protects: capture records calls and transaction outcomes and writes nothing when the kill switch is set (env or
 * off marker) and deletes nothing; any new purge-log line, or a purge log that cannot be read, deletes the whole
 * epoch (recording and copies); a rolled-back transaction is never replayed; the replay child blocks network
 * connections and gets no provider key; the report and the summary hold no input string; normalization keeps a
 * wrong stored id and a wrong date as differences; the read-back sweep catches a write an arm dropped while
 * returning the right receipt; two replays of the same epoch write identical reports; a scratch Postgres URL that
 * could leave the machine is refused.
 * Real engines (PGLite, Rust, Postgres) run in test/e2e/shadow-replay.serial.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { appendPurgeIntent } from '../src/core/belief/purge-mirror.ts';
import {
  __setScratchOpenerForTests, attachCapture, deleteEpochData, dropScratchPostgres, resumeInvalidatedCleanup, basesDir, CaptureWriter, epochDir, invalidateIfPurged, readEpoch, readSegment, scratchCleared,
  scratchPendingPath, scratchRecordPath, startEpoch, watchPurges, wrapCaptureEngine, type CaptureRecord,
} from '../src/shadow/capture.ts';
import { captureDir, captureOffMarker, writePrivateJson } from '../src/shadow/capture-state.ts';
import { checkLocalPostgresUrl, FanOutSeedTarget } from '../src/shadow/replay-copy.ts';
import { acquireReplayLock, runNightlyReplay, settleSeededEpoch } from '../src/shadow/replay-run.ts';
import { decodeValue } from '../src/shadow/codec.ts';
import {
  buildUnits, childEnv, classify, firstDiff, NormState, redactPath, runReplayChild, SWEEP_LIMIT, type ArmName, type RunSpec,
} from '../src/shadow/replay.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-replay-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A small in-memory brain. `dropWrites` returns the right receipt but stores nothing (the negative control). */
function fakeEngine(opts: { dropWrites?: boolean; dropSource?: string; alterFrontmatter?: boolean; idPrefix?: string; due?: string; strictRevision?: boolean; wrongTimeline?: boolean; wrongChunks?: boolean } = {}) {
  const chunks = new Map<string, Array<{ chunk_text: string }>>();
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
function recordingCapture(): { cap: string; home: string; shadowDir: string } {
  const root = tmp();
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), '{}');
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

/** A scratch database whose owner marker names `owner` (null: no marker); records every statement in `sql`. */
function ownedScratch(sql: string[], owner: string | null = 'pglite-abc') {
  return async () => ({
    async executeRaw(q: string) { sql.push(q); return (q.includes('to_regclass') ? [{ present: owner !== null }] : q.includes('FROM gbrain_shadow_replay_owner') ? [{ brain: owner }] : []) as never[]; },
    async disconnect() {},
  });
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

describe('capture', () => {
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
    const plan = buildUnits(recs, { before: 0, after: 0 });
    expect(plan.counts.rolled_back).toBe(1);
    expect(JSON.stringify(plan.units)).not.toContain('notes/tx-rolled');
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
    expect(invalidateIfPurged(cap, { home })).toBe(true);
    expect(readEpoch(cap)!.state).toBe('invalidated');
    expect(existsSync(epochDir(cap, id))).toBe(false);
    expect(existsSync(basesDir(cap, id))).toBe(false);
  });

  test('a purge in a recording process deletes the epoch at once, through the purge listener', async () => {
    const { cap, home } = recordingCapture();
    const id = readEpoch(cap)!.id;
    const engine = fakeEngine() as unknown as BrainEngine;
    watchPurges(engine, cap);
    const e = attachCapture(engine, cap);
    appendPurgeIntent({ request: 'r2', request_id: 'q2', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(existsSync(epochDir(cap, id))).toBe(false);
    await e.getPage('x');
  });

  test('a purge drops the scratch Postgres copy in the same step, with capture on or off', async () => {
    for (const enabled of [true, false]) {
      const { cap, home } = recordingCapture();
      writePrivateJson(join(cap, 'state.json'), { version: 1, enabled, turned_on_at: '2026-11-22T00:00:00.000Z' });
      writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/replay_scratch', brain: 'pglite-abc', verified: true });
      const sql: string[] = [];
      __setScratchOpenerForTests(ownedScratch(sql));
      const onDisconnect: Array<() => Promise<void>> = [];
      try {
        watchPurges({ registerBeforeDisconnect: (fn: () => Promise<void>) => onDisconnect.push(fn) } as unknown as BrainEngine, cap);
        appendPurgeIntent({ request: `r${enabled}`, request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
        for (const fn of onDisconnect) await fn();
      } finally { __setScratchOpenerForTests(null); }
      expect(sql).toContain('DROP SCHEMA IF EXISTS public CASCADE');
      expect(existsSync(scratchRecordPath(cap))).toBe(false);
      expect(existsSync(scratchPendingPath(cap))).toBe(false);
    }
  });

  test('a scratch drop that fails stays pending, and the copy counts as not cleared until a drop succeeds', async () => {
    const { cap, home } = recordingCapture();
    writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/replay_scratch', brain: 'pglite-abc', verified: true });
    __setScratchOpenerForTests(async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    try {
      appendPurgeIntent({ request: 'r9', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
      expect(invalidateIfPurged(cap, { home })).toBe(true);
      expect(await scratchCleared(cap)).toBe(false);
      expect(existsSync(scratchPendingPath(cap))).toBe(true);
      __setScratchOpenerForTests(ownedScratch([]));
      expect(await scratchCleared(cap)).toBe(true);
      expect(existsSync(scratchPendingPath(cap))).toBe(false);
    } finally { __setScratchOpenerForTests(null); }
  });

  test('a purge log that cannot be read fails closed', () => {
    const { cap } = recordingCapture();
    const notADir = join(tmp(), 'file');
    writeFileSync(notADir, '');
    expect(invalidateIfPurged(cap, { home: join(notADir, 'home') })).toBe(true);
  });
});

describe('comparison', () => {
  const win = { from: Date.parse('2026-11-22T00:00:00Z'), to: Date.parse('2026-11-23T00:00:00Z') };
  test('generated ids and in-window times map one to one; a wrong stored id or a wrong future date still differs', () => {
    const stored = '11111111-1111-4111-8111-111111111111';
    const n = new NormState(new Set([stored]), win);
    expect(firstDiff({ id: 'aaaaaaaa-0000-4000-8000-000000000001', at: '2026-11-22T10:00:00.123Z' }, { id: 'bbbbbbbb-0000-4000-8000-000000000001', at: '2026-11-22T10:00:00.456Z' }, n)).toBeNull();
    expect(firstDiff({ again: 'aaaaaaaa-0000-4000-8000-000000000001' }, { again: 'cccccccc-0000-4000-8000-000000000001' }, n)).toEqual(['again']);
    expect(firstDiff({ page: stored }, { page: '22222222-2222-4222-8222-222222222222' }, n)).toEqual(['page']);
    expect(firstDiff({ due: '2030-01-01T00:00:00.000Z' }, { due: '2030-01-02T00:00:00.000Z' }, n)).toEqual(['due']);
  });

  test('three arms split a Rust gap from TypeScript disagreement; two arms only say they differ', () => {
    const norm = () => new NormState(new Set(), { from: 0, to: 0 });
    const a = { ok: true as const, value: { n: 1 } };
    const b = { ok: true as const, value: { n: 2 } };
    expect(classify({ pglite: a, postgres: a, rust: b }, { rust: norm(), postgres: norm() }, false).cls).toBe('rust_diff');
    expect(classify({ pglite: a, postgres: b, rust: a }, { rust: norm(), postgres: norm() }, false).cls).toBe('ts_disagree');
    expect(classify({ pglite: a, rust: b }, { rust: norm() }, false).cls).toBe('differs');
    expect(classify({ pglite: a, rust: b }, { rust: norm() }, true).cls).toBe('differs_seed_loss');
    expect(classify({ pglite: a, rust: { ok: false, code: 'engine_capability_missing' } }, { rust: norm() }, false).cls).toBe('capability_missing');
  });
});

async function replayOnFakes(rustOpts: Parameters<typeof fakeEngine>[0] = {}, session: (e: BrainEngine) => Promise<unknown> = async () => {}, allOpts: Parameters<typeof fakeEngine>[0] = {}) {
  const { cap, home } = recordingCapture();
  await recordSession(cap, home, session);
  const runDir = join(tmp(), 'run');
  mkdirSync(runDir, { recursive: true });
  const spec: RunSpec = { version: 1, epoch: readEpoch(cap)!.id, brain_key: 'pglite-abc', hmac_key: 'ab'.repeat(32), arms: { pglite: 'x', rust: 'y' },
    cut: { before: 0, after: 0 }, seed_losses_present: false, segments: epochDir(cap, readEpoch(cap)!.id) };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(spec));
  const run = async () => {
    const report = await runReplayChild(runDir, { blockNetwork: () => {}, openArm: async (arm: ArmName) => fakeEngine(arm === 'rust' ? { ...allOpts, ...rustOpts, idPrefix: 'ffff' } : { ...allOpts, idPrefix: 'aaaa' }) as unknown as BrainEngine }, () => Date.now());
    return { report, text: readFileSync(join(runDir, 'out', 'report.json'), 'utf8'), summary: readFileSync(join(runDir, 'out', 'summary.json'), 'utf8') };
  };
  return { run };
}

describe('replay child (in-memory arms)', () => {
  test('matching arms: nothing differs, and two replays write identical reports', async () => {
    const { run } = await replayOnFakes();
    const first = await run();
    expect(first.report.diffs).toEqual([]);
    expect(first.report.counts.rolled_back).toBe(1);
    expect((await run()).text).toBe(first.text);
  });

  test('a report with differences is byte-identical when the same epoch is replayed at another time', async () => {
    const { run } = await replayOnFakes({ dropWrites: true });
    const first = await run();
    expect(first.report.diffs.length).toBeGreaterThan(0);
    await Bun.sleep(1100);
    expect((await run()).text).toBe(first.text);
  });

  test('the read-back sweep catches a write the Rust arm dropped while returning the right receipt', async () => {
    const { run } = await replayOnFakes({ dropWrites: true });
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getPage')).toBe(true);
  });

  test('the report and the summary hold no input string, field names outside the schema included', async () => {
    const { run } = await replayOnFakes({ alterFrontmatter: true });
    const { text, summary, report } = await run();
    expect(report.diffs.some(d => d.path[0] === 'frontmatter' && d.path[1]?.startsWith('#'))).toBe(true);
    for (const s of [PRIVATE.slug, PRIVATE.title, PRIVATE.body, PRIVATE.key, 'nightjar', 'zelda', 'Secretname']) {
      expect(text.toLowerCase()).not.toContain(s.toLowerCase());
      expect(summary.toLowerCase()).not.toContain(s.toLowerCase());
    }
    expect(Object.keys(JSON.parse(summary))).toEqual(['schema_version', 'coverage', 'arms', 'by_class', 'differences']);
  });
});

describe('review fixes (ship pass 1)', () => {
  test('a frontmatter key that starts with "[" is hashed like any other non-schema field name', () => {
    expect(redactPath(['frontmatter', '[private-client]', 0], Buffer.alloc(32)).join('.')).toMatch(/^frontmatter\.#[0-9a-f]{8}\.\[0\]$/);
  });

  test('an explicit undefined argument replays as undefined, not null', async () => {
    const { cap, home } = recordingCapture();
    const recs = await recordSession(cap, home, e => (e as unknown as { getEmbeddingsByChunkIds(a: unknown, b?: unknown): Promise<unknown> }).getEmbeddingsByChunkIds([1], undefined));
    const rec = recs.find(r => r.member === 'getEmbeddingsByChunkIds')!;
    expect((decodeValue(rec.args) as unknown[]).length).toBe(2);
    expect((decodeValue(rec.args) as unknown[])[1]).toBeUndefined();
  });

  test('a call that succeeded live but fails the same way on every arm is replay_diverged, never a match', async () => {
    const { run } = await replayOnFakes({}, e => e.putPage('notes/a', { title: 'a', compiled_truth: 'b' } as never, { expectedRevision: 'rev-from-live' } as never), { strictRevision: true });
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'putPage' && d.class === 'replay_diverged')).toBe(true);
  });

  test('two different future dates are a difference, not replay noise', async () => {
    const { run } = await replayOnFakes({ due: '2030-01-02T00:00:00.000Z' }, async () => {}, { due: '2030-01-01T00:00:00.000Z' });
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getStats')).toBe(true);
  });

  test('the read-back sweep reads a write in its own source', async () => {
    const { run } = await replayOnFakes({ dropSource: 'other' }, e => e.putPage('notes/same', { title: 'other copy', compiled_truth: 'x' } as never, { sourceId: 'other' } as never));
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getPage')).toBe(true);
  });

  test('a purge deletes recordings and copies a crashed nightly run left behind, not only the current epoch', async () => {
    const { cap, home, shadowDir } = recordingCapture();
    for (const p of [join(cap, 'epoch-old'), join(cap, 'bases', 'old', 'pglite'), join(shadowDir, 'replay', 'run-x', 'segments'), join(shadowDir, 'replay', 'run-x', 'work'), join(shadowDir, 'replay', 'run-x', 'out')]) mkdirSync(p, { recursive: true });
    appendPurgeIntent({ request: 'r7', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect(invalidateIfPurged(cap, { home })).toBe(true);
    for (const p of [join(cap, 'epoch-old'), join(cap, 'bases', 'old'), join(shadowDir, 'replay', 'run-x', 'segments'), join(shadowDir, 'replay', 'run-x', 'work')]) expect(existsSync(p)).toBe(false);
    expect(existsSync(join(shadowDir, 'replay', 'run-x', 'out'))).toBe(true);
  });

  test('cleanup never drops a scratch database the seed did not verify, and never drops one another brain owns', async () => {
    // No marker (verified long ago or not: the database may have been recreated since), or a marker of another brain.
    for (const [record, owner] of [[{ url: 'postgresql://localhost/x', brain: 'pglite-abc' }, null], [{ url: 'postgresql://localhost/x', brain: 'pglite-abc', verified: true }, null], [{ url: 'postgresql://localhost/x', brain: 'pglite-abc', verified: true }, 'pglite-other']] as const) {
      const { cap } = recordingCapture();
      writePrivateJson(scratchRecordPath(cap), record);
      const sql: string[] = [];
      __setScratchOpenerForTests(async () => ({
        async executeRaw(q: string) { sql.push(q); return (q.includes('to_regclass') ? [{ present: owner !== null }] : q.includes('FROM gbrain_shadow_replay_owner') ? [{ brain: owner }] : []) as never[]; },
        async disconnect() {},
      }));
      try { expect(await dropScratchPostgres(cap)).toBe(true); } finally { __setScratchOpenerForTests(null); }
      expect(sql.some(q => q.startsWith('DROP'))).toBe(false);
    }
  });

  test('capture wraps only engine members; other function-valued properties come back untouched', async () => {
    const { cap, home } = recordingCapture();
    const handle = Object.assign((() => 'q') as unknown as Record<string, unknown>, { unsafe: () => 'u', options: { max: 1 } });
    const engine = { ...fakeEngine(), sql: handle } as unknown as BrainEngine;
    const e = wrapCaptureEngine(engine, new CaptureWriter(cap, home, {}));
    expect((e as unknown as { sql: unknown }).sql).toBe(handle);
    expect(typeof (e as unknown as { sql: { unsafe: unknown } }).sql.unsafe).toBe('function');
  });
});

describe('review fixes (ship pass 1, red team)', () => {
  test('retiring a replayed epoch keeps the next recording epoch', () => {
    const { cap } = recordingCapture();
    const next = readEpoch(cap)!.id;
    mkdirSync(join(cap, 'epoch-older'), { recursive: true });
    mkdirSync(join(cap, 'bases', 'older'), { recursive: true });
    deleteEpochData(cap, 'older');
    expect(existsSync(epochDir(cap, next))).toBe(true);
    expect(existsSync(join(cap, 'epoch-older'))).toBe(false);
  });

  test('the replay lock is exclusive: a second run is refused until the first unlocks', () => {
    const dir = tmp();
    const unlock = acquireReplayLock(dir, 60_000);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/shadow_replay_busy/);
    unlock();
    acquireReplayLock(dir, 60_000)();
  });

  test('a purge during a seed deletes the copies the seed went on writing, even when the epoch was already invalidated', async () => {
    const { cap, home } = recordingCapture();
    const next = readEpoch(cap)!;
    appendPurgeIntent({ request: 'r8', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    invalidateIfPurged(cap, { home });
    mkdirSync(join(basesDir(cap, next.id), 'pglite'), { recursive: true }); // the seed kept writing after the first cleanup
    expect(await settleSeededEpoch(cap, next, home)).toBe(false);
    expect(existsSync(basesDir(cap, next.id))).toBe(false);
  });

  test('a stored id the seed copied is compared literally, not treated as replay noise', async () => {
    const stored = '11111111-2222-4333-8444-555555555555';
    const wrong = '99999999-2222-4333-8444-555555555555';
    const { cap, home } = recordingCapture();
    await recordSession(cap, home);
    const runDir = join(tmp(), 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'ids.json'), JSON.stringify([stored]));
    const spec: RunSpec = { version: 1, epoch: readEpoch(cap)!.id, brain_key: 'pglite-abc', hmac_key: 'ab'.repeat(32), arms: { pglite: 'x', rust: 'y' },
      cut: { before: 0, after: 0 }, seed_losses_present: false, segments: epochDir(cap, readEpoch(cap)!.id), seeded_ids: join(runDir, 'ids.json') };
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(spec));
    const report = await runReplayChild(runDir, { blockNetwork: () => {}, openArm: async (arm: ArmName) => ({ ...fakeEngine(), async getStats() { return { revision: arm === 'rust' ? wrong : stored }; } }) as unknown as BrainEngine }, () => Date.now());
    expect(report.diffs.some(d => d.member === 'sweep:getStats')).toBe(true);
  });

  test('when the brain cannot be opened for the seed, the nightly run retires nothing', async () => {
    const { cap, home, shadowDir } = recordingCapture();
    const id = readEpoch(cap)!.id;
    mkdirSync(basesDir(cap, id), { recursive: true });
    writeFileSync(join(basesDir(cap, id), 'manifest.json'), '{}');
    writeFileSync(join(epochDir(cap, id), 'p.jsonl'), '');
    const deps = { shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', env: {}, home,
      openPrimary: async () => { throw Object.assign(new Error('busy'), { code: 'pglite_busy' }); } } as unknown as Parameters<typeof runNightlyReplay>[0];
    await expect(runNightlyReplay(deps)).rejects.toThrow(/shadow_replay_seed_failed.*pglite_busy/);
    expect(readEpoch(cap)).toMatchObject({ id, state: 'recording' });
    expect(existsSync(join(epochDir(cap, id), 'p.jsonl'))).toBe(true);
  });
});

describe('review fixes (ship pass 1, adversarial)', () => {
  test('the nightly run finishes an interrupted purge cleanup before anything else', async () => {
    const { cap, shadowDir } = recordingCapture();
    const pointer = readEpoch(cap)!;
    writePrivateJson(join(cap, 'epoch.json'), { ...pointer, state: 'invalidated', reason: 'purge' });
    mkdirSync(join(cap, 'bases', pointer.id, 'pglite'), { recursive: true }); // left behind by a crash mid-cleanup
    expect(await resumeInvalidatedCleanup(cap)).toBe(true);
    expect(existsSync(epochDir(cap, pointer.id))).toBe(false);
    expect(existsSync(join(cap, 'bases', pointer.id))).toBe(false);
    void shadowDir;
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

  /** A capture dir whose current epoch is seeded (a fake manifest and empty copies) and capture off. */
  function sealedEpoch() {
    const c = recordingCapture();
    const id = readEpoch(c.cap)!.id;
    writePrivateJson(join(c.cap, 'state.json'), { version: 1, enabled: false, turned_on_at: '2026-11-22T00:00:00.000Z' });
    for (const d of ['pglite', 'rust']) mkdirSync(join(basesDir(c.cap, id), d), { recursive: true });
    writeFileSync(join(basesDir(c.cap, id), 'manifest.json'), JSON.stringify({ version: 1, epoch: id, cut: { before: 0, after: 0 }, postgres: false, arms: {},
      seed: { unseeded_gap_rows_total: 0, segmented_pages: 0 } }));
    writeFileSync(join(epochDir(c.cap, id), 'p.jsonl'), '');
    const deps = { shadowDir: c.shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', env: {}, home: c.home,
      spawnChild: () => ({ exited: Promise.resolve(1), kill() {} }) } as unknown as Parameters<typeof runNightlyReplay>[0];
    return { ...c, id, deps };
  }

  test('a replay that fails keeps its recording for one retry, and a second failure retires it', async () => {
    const { cap, id, deps } = sealedEpoch();
    await expect(runNightlyReplay(deps)).rejects.toThrow(/without a report/);
    expect(existsSync(join(epochDir(cap, id), 'p.jsonl'))).toBe(true);
    expect(existsSync(join(basesDir(cap, id), 'manifest.json'))).toBe(true);
    await expect(runNightlyReplay(deps)).rejects.toThrow(/without a report/);
    expect(existsSync(epochDir(cap, id))).toBe(false);
  });

  test('a retried replay runs without the Postgres arm, whose copy was replayed in place and reseeded', async () => {
    const { cap, id, deps } = sealedEpoch();
    const m = JSON.parse(readFileSync(join(basesDir(cap, id), 'manifest.json'), 'utf8'));
    writeFileSync(join(basesDir(cap, id), 'manifest.json'), JSON.stringify({ ...m, postgres: true }));
    writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/replay_scratch', brain: 'pglite-abc', verified: true });
    const specs: RunSpec[] = [];
    const watching = { ...deps, spawnChild: (runDir: string) => { specs.push(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))); return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
    await expect(runNightlyReplay(watching)).rejects.toThrow(/without a report/);
    await expect(runNightlyReplay(watching)).rejects.toThrow(/without a report/);
    expect(specs.map(s => !!s.arms.postgres)).toEqual([true, false]);
  });

  test('a seed that fails reports its own error, not a purge', async () => {
    const { cap, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: true, turned_on_at: '2026-11-22T00:00:00.000Z' });
    rmSync(join(cap, 'bases'), { recursive: true, force: true }); // nothing to replay: only the seed runs
    const seedDeps = { ...deps, openPrimary: async () => fakeEngine() as unknown as BrainEngine,
      loadAddon: async () => ({ ok: false, code: 'addon_missing', reason: 'not installed' }) } as unknown as Parameters<typeof runNightlyReplay>[0];
    await expect(runNightlyReplay(seedDeps)).rejects.toThrow(/shadow_replay_addon_unavailable/);
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

  test('an object key spelled like an array position is still hashed in a report path', () => {
    const n = new NormState(new Set(), { from: 0, to: 0 });
    const path = firstDiff({ frontmatter: { '[0]': 'a' } }, { frontmatter: { '[0]': 'b' } }, n)!;
    expect(redactPath(path, Buffer.alloc(32)).join('.')).toMatch(/^frontmatter\.#[0-9a-f]{8}$/);
    expect(redactPath(firstDiff([1, 2], [1, 3], n)!, Buffer.alloc(32))).toEqual(['[1]']);
  });
});

describe('review fixes (ship pass 1, outside voice)', () => {
  test('a record buffered before a purge never lands in the next epoch', async () => {
    const { cap, home } = recordingCapture();
    const writer = new CaptureWriter(cap, home, {});
    const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
    await e.getPage(PRIVATE.slug); // buffered, not flushed yet
    appendPurgeIntent({ request: 'r10', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    invalidateIfPurged(cap, { home });
    await Bun.sleep(5);
    startEpoch(cap, home);
    await writer.flush();
    expect(JSON.stringify(segmentRecords(cap))).not.toContain(PRIVATE.slug);
  });

  test('shadow stop --delete drops the replay Postgres copy first, and deletes nothing when it cannot', async () => {
    const { cap, shadowDir } = recordingCapture();
    writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/x', brain: 'pglite-abc', verified: true });
    const lines: string[] = [];
    const brain = { key: 'pglite-abc', dir: shadowDir, engine: 'pglite' };
    __setScratchOpenerForTests(async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    try {
      const { __stopForTests } = await import('../src/commands/engine-shadow.ts');
      expect(await __stopForTests(brain, true, (l: string) => lines.push(l))).toBe(1);
      expect(existsSync(shadowDir)).toBe(true);
      const sql: string[] = [];
      __setScratchOpenerForTests(ownedScratch(sql));
      expect(await __stopForTests(brain, true, (l: string) => lines.push(l))).toBe(0);
      expect(sql.some(q => q.startsWith('DROP SCHEMA'))).toBe(true);
      expect(existsSync(shadowDir)).toBe(false);
    } finally { __setScratchOpenerForTests(null); }
  });

  test('with GBRAIN_DIRECT_DATABASE_URL set, the Postgres arm is refused before any scratch connection opens', async () => {
    const { shadowDir, home } = recordingCapture();
    let opened = 0;
    const deps = { shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', home,
      env: { GBRAIN_SHADOW_REPLAY_POSTGRES_URL: 'postgresql://localhost/replay_scratch', GBRAIN_DIRECT_DATABASE_URL: 'postgresql://localhost/brain' },
      openPrimary: async () => fakeEngine() as unknown as BrainEngine, loadAddon: async () => ({ ok: true, addon: {} }),
      openStore: async () => { opened++; throw new Error('must not open'); }, openSql: async () => { opened++; throw new Error('must not open'); },
    } as unknown as Parameters<typeof runNightlyReplay>[0];
    await expect(runNightlyReplay(deps)).rejects.toThrow(/shadow_replay_postgres_not_local.*GBRAIN_DIRECT_DATABASE_URL/);
    expect(opened).toBe(0);
  });

  test('a sweep past its page limit makes the report incomplete', async () => {
    const many = async (e: BrainEngine) => { for (let i = 0; i <= SWEEP_LIMIT; i++) await e.putPage(`notes/p${i}`, { title: 't', compiled_truth: 'b' } as never); };
    const { run } = await replayOnFakes({}, many);
    const { report } = await run();
    expect(report.counts.sweep_skipped).toBeGreaterThan(0);
    expect(report.coverage).toBe('incomplete');
  }, 60_000);
});

describe('review fixes (ship pass 2)', () => {
  test('a batch write is read back for every page its rows name', async () => {
    const { run } = await replayOnFakes({ wrongTimeline: true }, e => (e as unknown as { addTimelineEntriesBatch(r: object[]): Promise<number> }).addTimelineEntriesBatch([{ slug: 'notes/a', summary: 'met' }, { slug: 'notes/b', summary: 'called' }]));
    const { report } = await run();
    expect(report.diffs.filter(d => d.member === 'sweep:getTimeline').length).toBe(2);
    expect(report.counts.writes_not_swept).toBe(0);
  });

  test('a segment with more records than a call takes arguments still loads', async () => {
    const { cap, home } = recordingCapture();
    const dir = epochDir(cap, readEpoch(cap)!.id);
    // The runtime refuses a spread of about a million arguments (500,000 still passes).
    const line = JSON.stringify({ v: 1, proc: 'p', seq: 1, t0: 1, t1: 1, kind: 'gap' });
    writeFileSync(join(dir, 'big.jsonl'), (line + '\n').repeat(1_000_000));
    const runDir = join(tmp(), 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ version: 1, epoch: readEpoch(cap)!.id, brain_key: 'pglite-abc', hmac_key: 'ab'.repeat(32),
      arms: { pglite: 'x', rust: 'y' }, cut: { before: 0, after: 0 }, seed_losses_present: false, segments: dir } satisfies RunSpec));
    const report = await runReplayChild(runDir, { blockNetwork: () => {}, openArm: async () => fakeEngine() as unknown as BrainEngine });
    expect(report.counts.gaps).toBe(1_000_000);
    void home;
  }, 60_000);

  test('the seed lists ids inside JSON text and nested values too, so they are compared as stored values', async () => {
    const id = 'aaaaaaaa-1111-4222-8333-444444444444';
    const rust = { seedPlan: async () => ({}) as never, importRelation: async () => ({ imported: 1, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} }) };
    const fan = new FanOutSeedTarget(rust as never, {});
    await fan.importRelation('s', 'pages', [{ slug: 'a', frontmatter: JSON.stringify({ owner: id.toUpperCase() }), tags: [`x:${id}`] } as never]);
    expect(fan.seededIds.has(id)).toBe(true);
  });

  test('the lock file is never seen empty', () => {
    const dir = tmp();
    const unlock = acquireReplayLock(dir, 60_000);
    expect(readFileSync(join(dir, 'lock'), 'utf8').trim().split(' ').length).toBe(3);
    unlock();
    expect(readdirSync(dir).filter(f => f.startsWith('lock'))).toEqual([]);
  });

});

describe('review fixes (ship final review)', () => {
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
});

describe('review fixes (ship final review, red team)', () => {
  test('a stale lock is never reclaimed automatically; the error names it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'lock'), `999999999 ${Date.now() - 1} old\n`);
    expect(() => acquireReplayLock(dir, 60_000)).toThrow(/stale lock .*remove it/);
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toContain('old');
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

  test('a chunk write is read back with its chunks', async () => {
    const { run } = await replayOnFakes({ wrongChunks: true }, e => e.upsertChunks('notes/c', [{ chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth' }] as never));
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getChunks')).toBe(true);
  });
});

describe('isolation', () => {
  test('the child environment carries no provider key or brain path, only the allowlist and a throwaway home', () => {
    const env = childEnv({ PATH: '/bin', OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', VOYAGE_API_KEY: 'k3', GBRAIN_HOME: '/live', DATABASE_URL: 'postgres://db.example/x', GBRAIN_SHADOW_REPLAY_POSTGRES_URL: 'postgres://localhost/changed-tonight' }, '/run/home', { name: 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL', url: 'postgres://localhost/seeded' });
    expect(Object.keys(env).sort()).toEqual(['GBRAIN_HOME', 'GBRAIN_SHADOW_CAPTURE', 'GBRAIN_SHADOW_CHILD', 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL', 'HOME', 'PATH']);
    expect(env.GBRAIN_HOME).toBe('/run/home');
    // The Postgres arm is the copy the seed recorded, never what the variable names at replay time.
    expect(env.GBRAIN_SHADOW_REPLAY_POSTGRES_URL).toBe('postgres://localhost/seeded');
  });

  test('the child blocks fetch, TCP to any host and Unix sockets outside its run directory', async () => {
    const dir = tmp();
    const script = `
      import net from 'node:net';
      import { blockNetwork } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'replay.ts'))};
      blockNetwork(${JSON.stringify(dir)}, false);
      const out = [];
      try { await fetch('http://example.com/'); out.push('fetch:open'); } catch (e) { out.push('fetch:' + e.code); }
      try { const s = new net.Socket(); s.on('error', () => {}); s.connect(80, '203.0.113.1'); out.push('tcp:open'); s.destroy(); } catch (e) { out.push('tcp:' + e.code); }
      try { const s = net.connect({ path: '/var/run/other.sock' }); s.on('error', () => {}); out.push('unix:open'); s.destroy(); } catch (e) { out.push('unix:' + e.code); }
      const tls = await import('node:tls');
      try { const s = tls.connect({ host: '203.0.113.1', port: 443 }); s.on('error', () => {}); out.push('tls:open'); s.destroy(); } catch (e) { out.push('tls:' + e.code); }
      console.log(out.join(','));`;
    const file = join(dir, 'probe.ts');
    writeFileSync(file, script);
    const proc = Bun.spawnSync([process.execPath, file], { env: { PATH: process.env.PATH ?? '' } });
    expect(proc.stdout.toString().trim()).toBe('fetch:shadow_replay_network_blocked,tcp:shadow_replay_network_blocked,unix:shadow_replay_network_blocked,tls:shadow_replay_network_blocked');
  });

  test('the child lets the local scratch database upgrade its own connection to TLS', async () => {
    const dir = tmp();
    const file = join(dir, 'probe.ts');
    writeFileSync(file, `
      import tls from 'node:tls';
      import { Duplex } from 'node:stream';
      import { blockNetwork } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'replay.ts'))};
      blockNetwork(${JSON.stringify(dir)}, true);
      const out = [];
      try { const s = tls.connect({ socket: new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }) }); s.on('error', () => {}); out.push('upgrade:open'); s.destroy(); } catch (e) { out.push('upgrade:' + e.code); }
      try { const s = tls.connect({ host: '203.0.113.1', port: 5432 }); s.on('error', () => {}); out.push('remote:open'); s.destroy(); } catch (e) { out.push('remote:' + e.code); }
      console.log(out.join(','));`);
    const proc = Bun.spawnSync([process.execPath, file], { env: { PATH: process.env.PATH ?? '' } });
    expect(proc.stdout.toString().trim()).toBe('upgrade:open,remote:shadow_replay_network_blocked');
  });

  test('a scratch Postgres URL that could leave the machine is refused before any row is sent', () => {
    expect(checkLocalPostgresUrl('postgresql://localhost:5433/replay').database).toBe('replay');
    for (const bad of ['postgresql://db.example.com/replay', 'postgresql://localhost,db.example.com/replay', 'postgresql://localhost/replay?host=db.example.com', 'postgresql://10.0.0.5/replay',
      // The driver would not route a socket path (it dials localhost:5432), so socket URLs are refused too.
      'postgresql://localhost/replay?host=/var/run/postgresql']) {
      expect(() => checkLocalPostgresUrl(bad)).toThrow(/shadow_replay_postgres_not_local/);
    }
    expect(() => checkLocalPostgresUrl('postgresql://localhost/brain', 'postgresql://localhost:5432/brain')).toThrow(/shadow_replay_postgres_not_owned/);
  });
});
