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
  __setScratchOpenerForTests, attachCapture, basesDir, CaptureWriter, epochDir, invalidateIfPurged, readEpoch, readSegment, scratchCleared,
  scratchPendingPath, scratchRecordPath, startEpoch, watchPurges, wrapCaptureEngine, type CaptureRecord,
} from '../src/shadow/capture.ts';
import { captureDir, captureOffMarker, writePrivateJson } from '../src/shadow/capture-state.ts';
import { checkLocalPostgresUrl } from '../src/shadow/replay-copy.ts';
import {
  buildUnits, childEnv, classify, firstDiff, NormState, runReplayChild, type ArmName, type RunSpec,
} from '../src/shadow/replay.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-replay-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A small in-memory brain. `dropWrites` returns the right receipt but stores nothing (the negative control). */
function fakeEngine(opts: { dropWrites?: boolean; alterFrontmatter?: boolean; idPrefix?: string } = {}) {
  const pages = new Map<string, { slug: string; title: string; compiled_truth: string; frontmatter: Record<string, unknown>; updated_at: string }>();
  let n = 0;
  const engine = {
    kind: 'pglite',
    async putPage(slug: string, p: { title: string; compiled_truth: string; frontmatter?: Record<string, unknown> }) {
      const fm = opts.alterFrontmatter ? Object.fromEntries(Object.keys(p.frontmatter ?? {}).map(k => [k, 'changed'])) : p.frontmatter ?? {};
      const row = { slug, title: p.title, compiled_truth: p.compiled_truth, frontmatter: fm, updated_at: new Date().toISOString() };
      if (!opts.dropWrites) pages.set(slug, row);
      return { slug, id: `${opts.idPrefix ?? '0000'}${String(++n).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36) };
    },
    async getPage(slug: string) { return pages.get(slug) ?? null; },
    async getTags() { return []; },
    async getLinks() { return []; },
    async getBacklinks() { return []; },
    async getTimeline() { return []; },
    async getStats() { return { page_count: pages.size }; },
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

async function recordSession(cap: string, home: string): Promise<CaptureRecord[]> {
  const writer = new CaptureWriter(cap, home, {});
  const e = wrapCaptureEngine(fakeEngine() as unknown as BrainEngine, writer);
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
      writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/replay_scratch', brain: 'pglite-abc' });
      const sql: string[] = [];
      __setScratchOpenerForTests(async () => ({ async executeRaw(q: string) { sql.push(q); return [] as never[]; }, async disconnect() {} }));
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
    writePrivateJson(scratchRecordPath(cap), { url: 'postgresql://localhost/replay_scratch', brain: 'pglite-abc' });
    __setScratchOpenerForTests(async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    try {
      appendPurgeIntent({ request: 'r9', request_id: 'q', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] }, home);
      expect(invalidateIfPurged(cap, { home })).toBe(true);
      expect(await scratchCleared(cap)).toBe(false);
      expect(existsSync(scratchPendingPath(cap))).toBe(true);
      __setScratchOpenerForTests(async () => ({ async executeRaw() { return [] as never[]; }, async disconnect() {} }));
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

async function replayOnFakes(rustOpts: { dropWrites?: boolean; alterFrontmatter?: boolean } = {}) {
  const { cap, home } = recordingCapture();
  await recordSession(cap, home);
  const runDir = join(tmp(), 'run');
  mkdirSync(runDir, { recursive: true });
  const spec: RunSpec = { version: 1, epoch: readEpoch(cap)!.id, brain_key: 'pglite-abc', hmac_key: 'ab'.repeat(32), arms: { pglite: 'x', rust: 'y' },
    cut: { before: 0, after: 0 }, seed_losses_present: false, segments: epochDir(cap, readEpoch(cap)!.id) };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(spec));
  const run = async () => {
    const report = await runReplayChild(runDir, { blockNetwork: () => {}, openArm: async (arm: ArmName) => fakeEngine(arm === 'rust' ? { ...rustOpts, idPrefix: 'ffff' } : { idPrefix: 'aaaa' }) as unknown as BrainEngine }, () => Date.now() - 60_000);
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

describe('isolation', () => {
  test('the child environment carries no provider key or brain path, only the allowlist and a throwaway home', () => {
    const env = childEnv({ PATH: '/bin', OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', VOYAGE_API_KEY: 'k3', GBRAIN_HOME: '/live', DATABASE_URL: 'postgres://db.example/x', GBRAIN_SHADOW_REPLAY_POSTGRES_URL: 'postgres://localhost/s' }, '/run/home', 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL');
    expect(Object.keys(env).sort()).toEqual(['GBRAIN_HOME', 'GBRAIN_SHADOW_CAPTURE', 'GBRAIN_SHADOW_CHILD', 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL', 'HOME', 'PATH']);
    expect(env.GBRAIN_HOME).toBe('/run/home');
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
      console.log(out.join(','));`;
    const file = join(dir, 'probe.ts');
    writeFileSync(file, script);
    const proc = Bun.spawnSync([process.execPath, file], { env: { PATH: process.env.PATH ?? '' } });
    expect(proc.stdout.toString().trim()).toBe('fetch:shadow_replay_network_blocked,tcp:shadow_replay_network_blocked,unix:shadow_replay_network_blocked');
  });

  test('a scratch Postgres URL that could leave the machine is refused before any row is sent', () => {
    expect(checkLocalPostgresUrl('postgresql://localhost:5433/replay').database).toBe('replay');
    expect(checkLocalPostgresUrl('postgresql:///replay?host=/var/run/postgresql').host).toBe('/var/run/postgresql');
    for (const bad of ['postgresql://db.example.com/replay', 'postgresql://localhost,db.example.com/replay', 'postgresql://localhost/replay?host=db.example.com', 'postgresql://10.0.0.5/replay']) {
      expect(() => checkLocalPostgresUrl(bad)).toThrow(/shadow_replay_postgres_not_local/);
    }
    expect(() => checkLocalPostgresUrl('postgresql://localhost/brain', 'postgresql://localhost:5432/brain')).toThrow(/shadow_replay_postgres_not_owned/);
  });
});
