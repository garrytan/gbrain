/**
 * Shadow replay and comparison (src/shadow/replay.ts, replay-run.ts, replay-copy.ts), on in-memory engines. Capture
 * itself is tested in test/shadow-capture.test.ts.
 *
 * Protects: a rolled-back transaction is never replayed; the replay child blocks network connections and gets no
 * provider key; the report and the summary hold no input string; normalization keeps a wrong stored id and a wrong
 * date as differences; the read-back sweep catches a write an arm dropped while returning the right receipt; writes
 * it cannot read back (aliases, page versions) make the report incomplete; two replays of the same epoch write
 * identical reports; the nightly run seals through the recorders' handshake and passes any recorder it could not
 * verify on as incomplete coverage; an unseeded epoch is never replayed; an unfinished purge stops the run; the
 * Postgres replay arm is refused by name.
 * Real engines (PGLite, Rust) run in test/shadow-replay.serial.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { appendPurgeIntent } from '../src/core/belief/purge-mirror.ts';
import {
  deleteEpochData, basesDir, CaptureWriter, epochDir, purgeIfLogChanged, readEpoch, readSegment, recordersDir,
  startEpoch, wrapCaptureEngine, type CaptureRecord,
} from '../src/shadow/capture.ts';
import { captureDir, writePrivateJson } from '../src/shadow/capture-state.ts';
import { FanOutSeedTarget } from '../src/shadow/replay-copy.ts';
import { runNightlyReplay, settleSeededEpoch } from '../src/shadow/replay-run.ts';
import { appendPurgeIntent as purgeIntent } from '../src/core/belief/purge-mirror.ts';
import { statSync } from 'node:fs';
import { hmacKey } from '../src/shadow/replay.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { decodeValue } from '../src/shadow/codec.ts';
import {
  buildUnits, childEnv, classify, firstDiff, jsonView, NormState, redactPath, runReplayChild, streamSegment, SWEEP_LIMIT, type ArmName, type RunSpec,
} from '../src/shadow/replay.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-replay-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A small in-memory brain. `dropWrites` returns the right receipt but stores nothing (the negative control). */
function fakeEngine(opts: { wrongRename?: boolean; dropAliases?: boolean; dropWrites?: boolean; dropSource?: string; alterFrontmatter?: boolean; idPrefix?: string; due?: string; strictRevision?: boolean; wrongTimeline?: boolean; wrongChunks?: boolean;
  hardDelete?: boolean; wrongOldest?: boolean; failChunks?: boolean } = {}) {
  const chunks = new Map<string, Array<{ chunk_text: string }>>();
  const aliases = new Map<string, string[]>();
  const timeline = new Map<string, Array<{ date: string; summary: string }>>();
  const pages = new Map<string, { slug: string; title: string; compiled_truth: string; frontmatter: Record<string, unknown>; updated_at: string; deleted_at?: string }>();
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
    async getPage(slug: string, o?: { sourceId?: string; includeDeleted?: boolean }) {
      const p = o?.sourceId ? scoped.get(`${o.sourceId}:${slug}`) ?? null : pages.get(slug) ?? null;
      return p && (p as { deleted_at?: string }).deleted_at && !o?.includeDeleted ? null : p;
    },
    // Like the real engines: a soft delete keeps a tombstone that only includeDeleted reads; `hardDelete` loses it.
    async softDeletePage(slug: string) {
      const p = pages.get(slug); if (!p) return null;
      if (opts.hardDelete) pages.delete(slug); else pages.set(slug, { ...p, deleted_at: 'deleted' });
      return { slug };
    },
    async sealChunks() {},
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
    // Like the real engines: newest first, and 100 rows unless a limit is given.
    async getTimeline(slug: string, o?: { limit?: number }) { return [...(timeline.get(slug) ?? [])].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, o?.limit || 100); },
    // Like the real engines: chunks written but not sealed yet are read only with includeUnsealed.
    async getChunks(slug: string, o?: { includeUnsealed?: boolean }) {
      if (opts.failChunks) throw Object.assign(new Error('timeout'), { code: 'replay_timeout' });
      return o?.includeUnsealed ? chunks.get(slug) ?? [] : [];
    },
    async upsertChunks(slug: string, rows: Array<{ chunk_text: string }>) { chunks.set(slug, rows.map(r => ({ chunk_text: opts.wrongChunks ? 'other text' : r.chunk_text }))); },
    async addTimelineEntriesBatch(rows: Array<{ slug: string; summary: string; date?: string }>) {
      const oldest = rows.reduce((m, r) => (r.date && (!m || r.date < m) ? r.date : m), '' as string);
      for (const r of rows) timeline.set(r.slug, [...(timeline.get(r.slug) ?? []), { date: r.date ?? '2026-01-01',
        summary: opts.wrongTimeline || (opts.wrongOldest && r.date === oldest) ? 'something else' : r.summary }]);
      return rows.length;
    },
    async updateSlug(oldSlug: string, newSlug: string) {
      const p = pages.get(oldSlug); if (!p) return 0;
      pages.delete(oldSlug); pages.set(opts.wrongRename ? 'notes/wrong' : newSlug, { ...p, slug: newSlug }); return 1;
    },
    async getStats() { return { page_count: pages.size, ...(opts.due ? { due: opts.due } : {}) }; },
    async createVersion(slug: string) { return { id: 1, slug }; },
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

/** A capture dir whose current epoch is seeded (a fake manifest and empty copies) and capture off. */
function sealedEpoch() {
  const c = recordingCapture();
  const id = readEpoch(c.cap)!.id;
  writePrivateJson(join(c.cap, 'state.json'), { version: 1, enabled: false, turned_on_at: '2026-11-22T00:00:00.000Z' });
  for (const d of ['pglite', 'rust']) mkdirSync(join(basesDir(c.cap, id), d), { recursive: true });
  writeFileSync(join(basesDir(c.cap, id), 'manifest.json'), JSON.stringify({ version: 1, epoch: id, cut: { before: 0, after: 0 }, arms: {},
    seed: { unseeded_gap_rows_total: 0, segmented_pages: 0 } }));
  writeFileSync(join(epochDir(c.cap, id), 'p.jsonl'), '');
  const deps = { shadowDir: c.shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', env: {}, home: c.home,
    spawnChild: () => ({ exited: Promise.resolve(1), kill() {} }) } as unknown as Parameters<typeof runNightlyReplay>[0];
  return { ...c, id, deps };
}

/** A process id no process has: a child that already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

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

  test('a purge during a seed deletes the copies the seed went on writing, even when the epoch was already invalidated', async () => {
    const { cap, home } = recordingCapture();
    const next = readEpoch(cap)!;
    appendPurgeIntent({ request: 'r8', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    purgeIfLogChanged(cap, home);
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
  test('a replay that fails keeps its recording for one retry, and a second failure retires it', async () => {
    const { cap, id, deps } = sealedEpoch();
    await expect(runNightlyReplay(deps)).rejects.toThrow(/without a report/);
    expect(existsSync(join(epochDir(cap, id), 'p.jsonl'))).toBe(true);
    expect(existsSync(join(basesDir(cap, id), 'manifest.json'))).toBe(true);
    await expect(runNightlyReplay(deps)).rejects.toThrow(/without a report/);
    expect(existsSync(epochDir(cap, id))).toBe(false);
  });


  test('a seed that fails reports its own error, not a purge', async () => {
    const { cap, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: true, turned_on_at: '2026-11-22T00:00:00.000Z' });
    rmSync(join(cap, 'bases'), { recursive: true, force: true }); // nothing to replay: only the seed runs
    const seedDeps = { ...deps, openPrimary: async () => fakeEngine() as unknown as BrainEngine,
      loadAddon: async () => ({ ok: false, code: 'addon_missing', reason: 'not installed' }) } as unknown as Parameters<typeof runNightlyReplay>[0];
    await expect(runNightlyReplay(seedDeps)).rejects.toThrow(/shadow_replay_addon_unavailable/);
  });

  test('an object key spelled like an array position is still hashed in a report path', () => {
    const n = new NormState(new Set(), { from: 0, to: 0 });
    const path = firstDiff({ frontmatter: { '[0]': 'a' } }, { frontmatter: { '[0]': 'b' } }, n)!;
    expect(redactPath(path, Buffer.alloc(32)).join('.')).toMatch(/^frontmatter\.#[0-9a-f]{8}$/);
    expect(redactPath(firstDiff([1, 2], [1, 3], n)!, Buffer.alloc(32))).toEqual(['[1]']);
  });
});

describe('review fixes (ship pass 1, outside voice)', () => {
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

});

describe('read-back sweep', () => {
  test('a chunk write is read back with its chunks', async () => {
    const { run } = await replayOnFakes({ wrongChunks: true }, e => e.upsertChunks('notes/c', [{ chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth' }] as never));
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getChunks')).toBe(true);
  });
});

describe('review fixes (ship final review of the queued head)', () => {
  test('every engine member whose second parameter is the source is read back in that source', () => {
    // test-reads-source-ok[structural]: the sweep's positional-source list must cover every such member of the engine interface, including ones a later change adds, so the guard reads the interface.
    const text = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'engine.ts'), 'utf8');
    const positional = [...text.matchAll(/^\s+(\w+)\(\s*slug: string,\s*sourceId: string[,)]/gm)].map(m => m[1]!).filter(n => !/^(get|list|search|find|count|read|resolve)/.test(n)).sort();
    expect(positional).toEqual(['refreshPageBody', 'replaceDerivedAliases', 'setPageAliases', 'updatePageContextualRetrievalState']);
  });

  for (const member of ['refreshPageBody'] as const) {
    test(`the read-back sweep reads a ${member} write in the source its second argument names`, async () => {
      const { run } = await replayOnFakes({ dropSource: 'other' }, e => (e as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!('notes/same', 'other', 'body', '', 'h'));
      const { report } = await run();
      expect(report.diffs.some(d => d.member === 'sweep:getPage')).toBe(true);
    });
  }

  test('alias writes are not read back, so they mark the report incomplete instead of matching', async () => {
    const row = { alias_norm: 'acme', origin: 'declared', case_sensitive: false, alias_text: 'Acme' };
    const { run } = await replayOnFakes({ dropAliases: true }, async e => {
      const x = e as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      await x.replaceDerivedAliases!('companies/acme-example', 'default', [row]);
      await x.setPageAliases!('companies/acme-example', 'default', ['acme']);
    });
    const { report } = await run();
    expect(report.counts.writes_not_swept).toBe(2);
    expect(report.coverage).toBe('incomplete');
  });

  test('a positional-source write whose source cannot be told marks the report incomplete', async () => {
    const { run } = await replayOnFakes({}, e => (e as unknown as { refreshPageBody(...a: unknown[]): Promise<unknown> }).refreshPageBody('notes/x', null, 'body'));
    const { report } = await run();
    expect(report.counts.writes_not_swept).toBe(1);
    expect(report.coverage).toBe('incomplete');
  });
});

describe('read-back sweep', () => {
  test('a rename is read back at its new slug', async () => {
    const { run } = await replayOnFakes({ wrongRename: true }, async e => {
      await e.putPage('notes/old', { title: 't', compiled_truth: 'b' } as never);
      await (e as unknown as { updateSlug(a: string, b: string): Promise<number> }).updateSlug('notes/old', 'notes/new');
    });
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getPage')).toBe(true);
  });
});

describe('isolation', () => {
  test('the child environment carries no provider key, database URL or brain path, only the allowlist and a throwaway home', () => {
    const env = childEnv({ PATH: '/bin', OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', VOYAGE_API_KEY: 'k3', GBRAIN_HOME: '/live', DATABASE_URL: 'postgres://db.example/x', GBRAIN_SHADOW_REPLAY_POSTGRES_URL: 'postgres://localhost/s' }, '/run/home');
    expect(Object.keys(env).sort()).toEqual(['GBRAIN_HOME', 'GBRAIN_SHADOW_CAPTURE', 'GBRAIN_SHADOW_CHILD', 'HOME', 'PATH']);
    expect(env.GBRAIN_HOME).toBe('/run/home');
  });

  test('the Postgres replay arm is refused by name before anything runs, never skipped silently', async () => {
    const { cap, shadowDir, home } = recordingCapture();
    const before = readEpoch(cap);
    const deps = { shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', home, env: { GBRAIN_SHADOW_REPLAY_POSTGRES_URL: 'postgresql://localhost/replay' },
      openPrimary: async () => { throw new Error('must not open'); } } as unknown as Parameters<typeof runNightlyReplay>[0];
    await expect(runNightlyReplay(deps)).rejects.toThrow(/shadow_replay_postgres_unavailable.*postgres replay arm not in this release/);
    expect(readEpoch(cap)).toEqual(before);
    expect(existsSync(join(shadowDir, 'replay', 'lock'))).toBe(false);
  });

  test('the child blocks fetch, TCP to any host and Unix sockets outside its run directory', async () => {
    const dir = tmp();
    const script = `
      import net from 'node:net';
      import { blockNetwork } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'replay.ts'))};
      blockNetwork(${JSON.stringify(dir)});
      const out = [];
      try { await fetch('http://example.com/'); out.push('fetch:open'); } catch (e) { out.push('fetch:' + e.code); }
      try { const s = new net.Socket(); s.on('error', () => {}); s.connect(80, '203.0.113.1'); out.push('tcp:open'); s.destroy(); } catch (e) { out.push('tcp:' + e.code); }
      try { const s = net.connect({ path: '/var/run/other.sock' }); s.on('error', () => {}); out.push('unix:open'); s.destroy(); } catch (e) { out.push('unix:' + e.code); }
      // A sibling folder whose name starts with the run folder's name is outside it too.
      try { const s = new net.Socket(); s.on('error', () => {}); s.connect({ path: ${JSON.stringify(dir)} + '-other/x.sock' }); out.push('sibling:open'); s.destroy(); } catch (e) { out.push('sibling:' + e.code); }
      try { await Bun.connect({ unix: ${JSON.stringify(dir)} + '-other/x.sock', socket: { data() {} } }); out.push('bunsibling:open'); } catch (e) { out.push('bunsibling:' + e.code); }
      const tls = await import('node:tls');
      try { const s = tls.connect({ host: '203.0.113.1', port: 443 }); s.on('error', () => {}); out.push('tls:open'); s.destroy(); } catch (e) { out.push('tls:' + e.code); }
      console.log(out.join(','));`;
    const file = join(dir, 'probe.ts');
    writeFileSync(file, script);
    const proc = Bun.spawnSync([process.execPath, file], { env: { PATH: process.env.PATH ?? '' } });
    expect(proc.stdout.toString().trim()).toBe('fetch:shadow_replay_network_blocked,tcp:shadow_replay_network_blocked,unix:shadow_replay_network_blocked,sibling:shadow_replay_network_blocked,bunsibling:shadow_replay_network_blocked,tls:shadow_replay_network_blocked');
  });


});

describe('nightly seal (PR-2)', () => {
  test('a recorder the seal could not verify reaches the replay as incomplete coverage, with the epoch\'s own doubt', async () => {
    const { cap, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'epoch.json'), { ...readEpoch(cap)!, unverified: 1 }); // a recorder died after the previous seal
    writePrivateJson(join(recordersDir(cap), 'dead-1.json'), { pid: deadPid() }); // died before acknowledging this one
    const specs: RunSpec[] = [];
    const watching = { ...deps, spawnChild: (runDir: string) => { specs.push(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))); return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
    await expect(runNightlyReplay(watching)).rejects.toThrow(/without a report/);
    expect(specs[0]?.tail_unverified).toBe(2);
  });

  test('while capture is on, the seal starts the next epoch linked to the sealed one before the replay runs', async () => {
    const { cap, id, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: true, turned_on_at: '2026-11-22T00:00:00.000Z' });
    let during: ReturnType<typeof readEpoch> = null;
    const on = { ...deps, openPrimary: async () => fakeEngine() as unknown as BrainEngine,
      loadAddon: async () => ({ ok: false, code: 'addon_missing', reason: 'not installed' }),
      spawnChild: () => { during = readEpoch(cap); return { exited: Promise.resolve(1), kill() {} }; } } as unknown as typeof deps;
    await expect(runNightlyReplay(on)).rejects.toThrow();
    expect(during).toMatchObject({ state: 'recording', after: id });
  });

  test('an epoch that capture on started (no copies seeded) is retired, never replayed', async () => {
    const { cap, shadowDir, home } = recordingCapture();
    writePrivateJson(join(cap, 'state.json'), { version: 1, enabled: false, turned_on_at: '2026-11-22T00:00:00.000Z' });
    const id = readEpoch(cap)!.id;
    writeFileSync(join(epochDir(cap, id), 'p.jsonl'), `${JSON.stringify({ args: [PRIVATE.slug] })}\n`);
    let spawned = 0;
    const deps = { shadowDir, brainKey: 'pglite-abc', primaryEngine: 'pglite', env: {}, home,
      spawnChild: () => { spawned++; return { exited: Promise.resolve(1), kill() {} }; } } as unknown as Parameters<typeof runNightlyReplay>[0];
    expect((await runNightlyReplay(deps)).status).toBe('off');
    expect(spawned).toBe(0);
    expect(existsSync(epochDir(cap, id))).toBe(false);
  });

  test('a purge whose deletion is unfinished stops the run before anything is replayed; a finished retry lets it go on', async () => {
    const { cap, id, deps } = sealedEpoch();
    const stuck = join(epochDir(cap, id), 'stuck');
    mkdirSync(stuck);
    writeFileSync(join(stuck, 'x'), PRIVATE.slug);
    writePrivateJson(join(cap, 'epoch.json'), { ...readEpoch(cap)!, state: 'invalidated', reason: 'purge', cleanup: 'pending' });
    let spawned = 0;
    const counting = { ...deps, spawnChild: () => { spawned++; return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
    chmodSync(stuck, 0o500); // the file inside cannot be removed
    try { await expect(runNightlyReplay(counting)).rejects.toThrow(/shadow_replay_purged/); } finally { chmodSync(stuck, 0o700); }
    expect(spawned).toBe(0);
    expect(await runNightlyReplay(counting)).toMatchObject({ status: 'purged' }); // the retry finished the deletion
    expect(existsSync(epochDir(cap, id))).toBe(false);
    expect(spawned).toBe(0);
  });

  test('a page version write is not read back, so it marks the report incomplete', async () => {
    const { run } = await replayOnFakes({}, e => (e as unknown as { createVersion(s: string): Promise<unknown> }).createVersion('notes/v'));
    const { report } = await run();
    expect(report.counts.writes_not_swept).toBe(1);
    expect(report.coverage).toBe('incomplete');
  });
});

describe('fix round (review of aefcd32430)', () => {
  test('#2 the sealed epoch is owed a replay in retry.json before the replay starts, so a crash after the seal keeps it', async () => {
    const { cap, id, deps } = sealedEpoch();
    let owed: unknown = null;
    const watching = { ...deps, spawnChild: () => { owed = JSON.parse(readFileSync(join(cap, 'retry.json'), 'utf8')); return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
    await expect(runNightlyReplay(watching)).rejects.toThrow(/without a report/);
    expect(owed).toEqual([expect.objectContaining({ pointer: expect.objectContaining({ id }), attempts: 1 })]);
  });

  test('#2 recordings and copies no epoch or retry record names (a run died after its seal) are deleted at the next run', async () => {
    const { cap, id, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'epoch.json'), { ...readEpoch(cap)!, id: 'next-epoch', state: 'recording' }); // the pointer moved on
    mkdirSync(epochDir(cap, 'next-epoch'), { recursive: true });
    await runNightlyReplay(deps).catch(() => undefined);
    expect(existsSync(epochDir(cap, id))).toBe(false);
    expect(existsSync(basesDir(cap, id))).toBe(false);
  });

  test('#2 a run that died during the seal still replays that epoch, never purges it', async () => {
    const { cap, id, deps } = sealedEpoch();
    writePrivateJson(join(cap, 'epoch.json'), { ...readEpoch(cap)!, state: 'sealing', sealing_since: new Date().toISOString() });
    const specs: RunSpec[] = [];
    const watching = { ...deps, spawnChild: (runDir: string) => { specs.push(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))); return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
    await expect(runNightlyReplay(watching)).rejects.toThrow(/without a report/);
    expect(specs.map(x => x.epoch)).toEqual([id]);
    expect(specs[0]?.tail_unverified).toBeGreaterThanOrEqual(1);
  });

  test('#2 a purge still deletes everything, owed epochs and orphans included', async () => {
    const { cap, id, deps, home } = sealedEpoch();
    writePrivateJson(join(cap, 'retry.json'), [{ pointer: readEpoch(cap), attempts: 1 }]);
    mkdirSync(join(basesDir(cap, 'orphan'), 'pglite'), { recursive: true });
    purgeIntent({ request: 'r30', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
    expect((await runNightlyReplay(deps)).status).toBe('purged');
    for (const p of [epochDir(cap, id), basesDir(cap, id), basesDir(cap, 'orphan'), join(cap, 'retry.json')]) expect(existsSync(p)).toBe(false);
  });

  test('#3 a hard delete behind a soft-delete receipt differs from a soft delete', async () => {
    const { run } = await replayOnFakes({ hardDelete: true }, async e => {
      await e.putPage('notes/gone', { title: 't', compiled_truth: 'b' } as never);
      await (e as unknown as { softDeletePage(s: string): Promise<unknown> }).softDeletePage('notes/gone');
    });
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getPage')).toBe(true);
  });

  test('#4 a timeline write older than the newest 100 rows is still read back', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ slug: 'notes/t', summary: `entry ${i}`, date: `2026-01-${String(1 + Math.floor(i / 4)).padStart(2, '0')}T0${i % 4}:00:00Z` }));
    const { run } = await replayOnFakes({ wrongOldest: true }, e => (e as unknown as { addTimelineEntriesBatch(r: object[]): Promise<number> }).addTimelineEntriesBatch(rows));
    const { report } = await run();
    expect(report.diffs.some(d => d.member === 'sweep:getTimeline')).toBe(true);
  });

  test('#5 volatile ids pair one to one, equal ones included', () => {
    const n = new NormState(new Set(), { from: 0, to: 0 });
    const a = 'aaaaaaaa-0000-4000-8000-000000000001';
    const b = 'bbbbbbbb-0000-4000-8000-000000000001';
    expect(n.same(a, a)).toBe(true);
    expect(n.same(a, b)).toBe(false);
  });

  test('two writes in one millisecond on one arm and in two on the other still match (stress seed 427335)', () => {
    // The shape that seed hit: the first comparison sees the same time on both arms; the second sees that time on
    // PGLite and the next millisecond on Rust, because Rust's second write landed one millisecond later.
    const t = Date.parse('2026-11-22T00:00:00Z');
    const n = new NormState(new Set(), { from: t, to: t + 1000 });
    const same = new Date(t).toISOString();
    const later = new Date(t + 1).toISOString();
    expect(firstDiff({ updated_at: same }, { updated_at: same }, n)).toBeNull();
    expect(firstDiff({ updated_at: same }, { updated_at: later }, n)).toBeNull();
  });

  test('#6 a user object with a codec-shaped key keeps every field, in a write argument and in a comparison', () => {
    const fm = { $date: '2025-01-01', content: 'correct' };
    const [enc] = encodeArgs([fm]);
    expect(decodeValue(enc)).toEqual(fm);
    const n = new NormState(new Set(), { from: 0, to: 0 });
    const [other] = encodeArgs([{ $date: '2025-01-01', content: 'corrupted' }]);
    expect(firstDiff(jsonView(enc), jsonView(other), n)).not.toBeNull();
  });

  test('#7 a future time the seed copied is a stored value, not replay noise, in any spelling', async () => {
    const rust = { seedPlan: async () => ({}) as never, importRelation: async () => ({ imported: 1, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} }) };
    const fan = new FanOutSeedTarget(rust as never, {});
    await fan.seedPlan();
    await fan.importRelation('s', 'pages', [{ slug: 'a', frontmatter: JSON.stringify({ expires: '2030-01-01T00:00:00.000Z' }) } as never]);
    const n = new NormState(fan.seededIds, { from: 0, to: Date.parse('2031-01-01T00:00:00Z') });
    expect(firstDiff({ at: '2030-01-01 00:00:00+00' }, { at: '2030-01-02T00:00:00.000Z' }, n)).toEqual(['at']);
  });

  test('#8 a read-back that fails the same way on every arm verifies nothing and makes the report incomplete', async () => {
    const { run } = await replayOnFakes({}, e => e.upsertChunks('notes/c', [{ chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth' }] as never), { failChunks: true });
    const { report } = await run();
    expect(report.counts.sweep_failed).toBeGreaterThan(0);
    expect(report.coverage).toBe('incomplete');
  });

  test('#9 a chunk seal is not read back (its seal stamp is not compared), so it makes the report incomplete', async () => {
    const { run } = await replayOnFakes({}, e => (e as unknown as { sealChunks(s: string, c: unknown[]): Promise<void> }).sealChunks('notes/s', []));
    const { report } = await run();
    expect(report.counts.writes_not_swept).toBe(1);
    expect(report.coverage).toBe('incomplete');
  });

  test('#10 a segment is read in blocks within a memory budget; records past it are counted, never silently dropped', () => {
    const dir = tmp();
    const line = (i: number) => JSON.stringify({ v: 1, proc: 'p', seq: i, t0: i, t1: i, kind: 'gap' });
    writeFileSync(join(dir, 's.jsonl'), `${line(1)}\n${line(2)}\n${line(3)}\n{"torn`);
    const into: CaptureRecord[] = [];
    const r = streamSegment(join(dir, 's.jsonl'), into, { left: line(1).length * 2 });
    expect(into.map(x => x.seq)).toEqual([1, 2]);
    expect(r).toEqual({ torn: true, skipped: 1 });
  });
});

describe('the per-brain hash key (review of 3e7a623341)', () => {
  for (const [name, text] of [['an empty', ''], ['a short', 'ab'.repeat(16)], ['a non-hex', 'zz'.repeat(32)]] as const) {
    test(`${name} capture/key stops the nightly run with a named error; no child runs and no summary is written`, async () => {
      const { cap, deps, shadowDir } = sealedEpoch();
      writeFileSync(join(cap, 'key'), text);
      let spawned = 0;
      const counting = { ...deps, spawnChild: () => { spawned++; return { exited: Promise.resolve(1), kill() {} }; } } as typeof deps;
      await expect(runNightlyReplay(counting)).rejects.toThrow(/shadow_replay_key_invalid/);
      expect(spawned).toBe(0);
      const runs = existsSync(join(shadowDir, 'replay')) ? readdirSync(join(shadowDir, 'replay')).filter(f => f.startsWith('run-')) : [];
      for (const r of runs) expect(existsSync(join(shadowDir, 'replay', r, 'out', 'summary.json'))).toBe(false);
    });
  }

  test('a run spec whose key is not 64 hex characters makes the child refuse and write no report or summary', async () => {
    const { cap, home } = recordingCapture();
    await recordSession(cap, home);
    const runDir = join(tmp(), 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ version: 1, epoch: readEpoch(cap)!.id, brain_key: 'pglite-abc', hmac_key: '',
      arms: { pglite: 'x', rust: 'y' }, cut: { before: 0, after: 0 }, seed_losses_present: false, segments: epochDir(cap, readEpoch(cap)!.id) } satisfies RunSpec));
    await expect(runReplayChild(runDir, { blockNetwork: () => {}, openArm: async () => fakeEngine() as unknown as BrainEngine })).rejects.toThrow(/shadow_replay_key_invalid/);
    expect(existsSync(join(runDir, 'out'))).toBe(false);
  });

  test('a new key is written whole, owner-only, with no temp file left behind', () => {
    const cap = join(tmp(), 'capture');
    const key = hmacKey(cap);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(cap, 'key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(cap)).toEqual(['key']);
    expect(hmacKey(cap)).toBe(key);
  });
});
