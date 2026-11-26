/**
 * `gbrain engine shadow start` on a brain that uses managed storage.
 *
 * Protects: shadow mode gathers evidence on managed brains too; only the swap refuses them. The preview, `--plan` and
 * `--yes --expect <hash>` all succeed on a managed brain, print the line "this brain cannot swap while it uses managed
 * storage", and record `storage: { managed: true, checked_at }` in state.json; `status --json` and the report carry it.
 * A mode that cannot be read (open or read failure, a busy PGLite brain, no brain at the path) never blocks start: it is
 * recorded as `managed: null` with a reason. Nothing on this path emits `engine_swap_refused`. And start leaves the
 * primary untouched: every `persistence_*` table and the content root beside the brain are byte-identical before and after.
 * Uses a real PGLite brain on disk and the real default open path (no injected engine) unless a test injects a failure.
 * Serial because it sets GBRAIN_HOME.
 * Regression it catches: start that refuses over the storage mode, drops the record, or writes to the primary.
 * Not covered elsewhere: test/rust-engine-shadow.serial.test.ts covers start on an unmanaged brain with a fake engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow, shadowPlan } from '../src/commands/engine-shadow.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, DEFAULT_SHADOW_WRITE_SAMPLE_RATE, OPT_IN_WRITE_SAMPLE_RATE, readShadowState, shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import { snapshotPersistence, snapshotTree } from './helpers/primary-snapshot.ts';

const LINE = 'this brain cannot swap while it uses managed storage';
let home: string;
let restoreEnv: () => void;
let config: EngineConfig;
let contentRoot: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Run `sql` on the brain on disk, then close it again so each command opens it the way a real run does. */
async function onBrain(sql: string): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect(config);
  try { await engine.executeRaw(sql); } finally { await engine.disconnect(); }
}

/** Every persistence table of the brain, plus the content root beside it (the checkout a managed brain keeps its files in): paths, sizes, mtimes and SHA-256. */
async function snapshotPrimary(): Promise<{ tables: Record<string, string[]>; files: Record<string, string> }> {
  const engine = new PGLiteEngine();
  await engine.connect(config);
  try {
    return {
      tables: await snapshotPersistence(engine),
      files: snapshotTree(contentRoot),
    };
  } finally { await engine.disconnect(); }
}

const MANAGED = 'UPDATE persistence_brain SET enabled=true WHERE singleton=1';
const UNMANAGED = 'UPDATE persistence_brain SET enabled=false WHERE singleton=1';
const shadowDir = (): string => shadowDirFor(shadowBrainKey(config)!);
/** The plan hash `start` shows: a managed brain keeps the default write sample rate, an unmanaged one compares every write. */
const planHash = (managed = true): string => shadowPlan(shadowBrainKey(config)!, 'pglite', shadowDir(),
  { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND, writeSampleRate: managed ? DEFAULT_SHADOW_WRITE_SAMPLE_RATE : OPT_IN_WRITE_SAMPLE_RATE }).hash;
const okAddon = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1' } as never });
const NOW = new Date('2026-03-04T05:06:07.000Z');

async function run(args: string[], extra: Record<string, unknown> = {}) {
  const c = capture();
  const code = await runEngineShadow(args, { ...c.deps, config: () => config, loadAddon: okAddon, now: () => NOW, ...extra });
  // `start --yes` also warns when the Rust store is not seeded; that warning is not what these tests are about.
  const err = c.err.filter((l) => !l.startsWith('engine shadow: warning: the Rust store is not seeded'));
  return { code, out: c.out, err, text: [...c.out, ...c.err].join('\n') };
}

const reset = (): void => { rmSync(shadowDir(), { recursive: true, force: true }); };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-managed-'));
  const saved = { GBRAIN_HOME: process.env.GBRAIN_HOME, GBRAIN_SHADOW_CHILD: process.env.GBRAIN_SHADOW_CHILD, GBRAIN_RUST_ENGINE_ADDON: process.env.GBRAIN_RUST_ENGINE_ADDON };
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_SHADOW_CHILD;
  delete process.env.GBRAIN_RUST_ENGINE_ADDON;
  restoreEnv = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  config = { engine: 'pglite', database_path: join(home, 'brain.pglite') };
  contentRoot = join(home, 'content-root');
  mkdirSync(join(contentRoot, 'people'), { recursive: true });
  writeFileSync(join(contentRoot, 'people', 'a.md'), '# a\n');
  writeFileSync(join(contentRoot, 'index.md'), '# index\n');
  const engine = new PGLiteEngine();
  await engine.connect(config);
  await engine.initSchema();
  await engine.disconnect();
});

afterAll(() => { restoreEnv(); rmSync(home, { recursive: true, force: true }); });

describe('engine shadow start on a managed-storage brain', () => {
  test('--plan, the bare preview and --yes --expect all succeed, print the line, and record managed: true', async () => {
    await onBrain(MANAGED);
    const plan = await run(['start', '--plan']);
    expect(plan.err).toEqual([]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(`  storage: ${LINE}`);
    expect(plan.out.join('\n')).toContain(`plan_hash: ${planHash()}`);
    expect(existsSync(shadowDir())).toBe(false);

    const preview = await run(['start']);
    expect(preview.code).toBe(3); // the preview exits 3 until --yes, as for an unmanaged brain
    expect(preview.out).toContain(`  storage: ${LINE}`);
    expect(preview.err).toEqual([]);
    expect(existsSync(shadowDir())).toBe(false);

    const go = await run(['start', '--yes', '--expect', planHash()]);
    expect(go.err).toEqual([]);
    expect(go.code).toBe(0);
    expect(go.out).toContain(`storage: ${LINE}`);
    expect(go.text).not.toContain('engine_swap_refused');
    const state = readShadowState(shadowDir())!;
    expect(state.enabled).toBe(true);
    expect(state.storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
    // A managed brain cannot opt in to the swap: its shadow keeps the general write sample rate.
    expect(state.write_sample_rate).toBe(DEFAULT_SHADOW_WRITE_SAMPLE_RATE);
    expect(JSON.parse(readFileSync(join(shadowDir(), 'state.json'), 'utf8')).storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
  });

  test('status --json and the markdown status and report show the line', async () => {
    await onBrain(MANAGED);
    expect((await run(['start', '--yes', '--expect', planHash()])).code).toBe(0); // this test sets up its own shadow state
    const json = await run(['status', '--json']);
    expect(JSON.parse(json.out.join('\n')).storage).toEqual({ managed: true, checked_at: NOW.toISOString(), note: LINE });
    expect((await run(['status'])).out).toContain(`  storage: ${LINE}`);
    const report = await run(['report']);
    expect(report.out.join('\n')).toContain(`Storage: ${LINE}.`);
    const reportJson = JSON.parse((await run(['report', '--json'])).out.join('\n'));
    expect(reportJson.storage).toEqual({ managed: true, checked_at: NOW.toISOString(), note: LINE });
    expect(reportJson.verdict).toBe('NOT READY');
    reset();
  });

  test('start leaves the primary untouched: every persistence table and the content root are byte-identical', async () => {
    await onBrain(MANAGED);
    const before = await snapshotPrimary();
    expect(Object.keys(before.tables)).toContain('persistence_brain');
    expect(before.tables.persistence_brain!.some((r) => r.includes('"enabled":true'))).toBe(true);
    expect(Object.keys(before.files)).toContain('people/a.md');
    const hash = planHash();
    for (const args of [['start', '--plan'], ['start'], ['start', '--yes', '--expect', hash], ['status', '--json'], ['report']]) {
      expect((await run(args)).err, args.join(' ')).toEqual([]);
    }
    expect(readShadowState(shadowDir())?.storage?.managed).toBe(true);
    const after = await snapshotPrimary();
    expect(after.tables).toEqual(before.tables);
    expect(after.files).toEqual(before.files);
    reset();
  });

  test('the preview and start write nothing when the brain has a registered source checkout: no ownership marker, no registry entry', async () => {
    await onBrain(UNMANAGED); // registering a source is allowed only while the brain is unmanaged
    await onBrain(`INSERT INTO sources(id,name,local_path,config) VALUES('checkout','checkout','${contentRoot}','{}') ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path`);
    await onBrain(MANAGED);
    const watched = (): { tree: Record<string, string>; registry: Record<string, string> } => ({
      tree: snapshotTree(contentRoot),
      registry: existsSync(join(home, '.gbrain', 'persistence')) ? snapshotTree(join(home, '.gbrain', 'persistence')) : {},
    });
    const markers = (): string[] => [join(contentRoot, '.gbrain-managed'), join(config.database_path!, '.gbrain-managed')].filter((p) => existsSync(p));
    for (const p of [join(contentRoot, '.gbrain-managed'), join(config.database_path!, '.gbrain-managed')]) rmSync(p, { force: true });
    rmSync(join(home, '.gbrain', 'persistence'), { recursive: true, force: true });
    const before = watched();
    for (const args of [['start', '--plan'], ['start'], ['start', '--yes', '--expect', planHash()]]) {
      expect((await run(args)).err, args.join(' ')).toEqual([]);
    }
    expect(readShadowState(shadowDir())?.storage?.managed).toBe(true);
    expect(markers()).toEqual([]);
    expect(watched()).toEqual(before);
    reset();
    await onBrain(UNMANAGED);
    await onBrain(`DELETE FROM sources WHERE id='checkout'`);
    rmSync(join(home, '.gbrain', 'persistence'), { recursive: true, force: true });
    for (const p of [join(contentRoot, '.gbrain-managed'), join(config.database_path!, '.gbrain-managed')]) rmSync(p, { force: true });
  });

  test('the preview and start leave an open repair episode and its backups alone, and record the mode as unread', async () => {
    const dir = config.database_path!;
    const sidecar = `${dir}.wal-repair-attempt.json`;
    const backups = [1, 2, 3, 4].map((n) => `${dir}.wal-repair-backup-${1_700_000_000_000 + n}`);
    for (const b of backups) { mkdirSync(join(b, 'pg_wal'), { recursive: true }); writeFileSync(join(b, 'pg_wal', 'x'), b); }
    writeFileSync(sidecar, JSON.stringify({ episodeStartedAt: 1_700_000_000_000, episodeBackupPath: backups[0], attempts: [] }));
    const watched = (): string[] => [readFileSync(sidecar, 'utf8'), ...backups.map((b) => String(existsSync(join(b, 'pg_wal', 'x'))))];
    const before = watched();
    for (const args of [['start', '--plan'], ['start'], ['start', '--yes', '--expect', planHash()]]) {
      expect((await run(args)).err, args.join(' ')).toEqual([]);
    }
    expect(readShadowState(shadowDir())?.storage).toEqual({ managed: null, checked_at: NOW.toISOString(), reason: 'repair_episode_open' });
    expect(watched()).toEqual(before);
    expect(before.slice(1)).toEqual(['true', 'true', 'true', 'true']);
    reset();
    rmSync(sidecar, { force: true });
    for (const b of backups) rmSync(b, { recursive: true, force: true });
  });

  test('a repair episode recorded while start waits for the datastore lock is still left open, with every backup', async () => {
    // The check for an open episode runs before the open takes the lock; a repair that finishes while start waits records its episode later.
    const dir = config.database_path!;
    const sidecar = `${dir}.wal-repair-attempt.json`;
    const backups = [1, 2, 3, 4].map((n) => `${dir}.wal-repair-backup-${1_700_000_000_000 + n}`);
    const watched = (): string[] => [readFileSync(sidecar, 'utf8'), ...backups.map((b) => String(existsSync(join(b, 'pg_wal', 'x'))))];
    const holder = new PGLiteEngine();
    await holder.connectForRestore(config);
    let held = true;
    try {
      const starting = run(['start', '--plan']);
      await new Promise((r) => setTimeout(r, 400)); // start has passed its check and is waiting for the lock
      for (const b of backups) { mkdirSync(join(b, 'pg_wal'), { recursive: true }); writeFileSync(join(b, 'pg_wal', 'x'), b); }
      writeFileSync(sidecar, JSON.stringify({ episodeStartedAt: 1_700_000_000_000, episodeBackupPath: backups[0], attempts: [] }));
      const before = watched();
      await holder.disconnect();
      held = false;
      const result = await starting;
      expect(result.code, result.text).toBe(0);
      expect(watched()).toEqual(before);
      expect(before.slice(1)).toEqual(['true', 'true', 'true', 'true']);
    } finally {
      if (held) await holder.disconnect();
      rmSync(sidecar, { force: true });
      for (const b of backups) rmSync(b, { recursive: true, force: true });
    }
  }, 120_000);

  test('an unmanaged brain records managed: false and prints no storage line', async () => {
    await onBrain(UNMANAGED);
    const plan = await run(['start', '--plan']);
    expect(plan.code).toBe(0);
    expect(plan.text).not.toContain('storage:');
    const go = await run(['start', '--yes', '--expect', planHash(false)]);
    expect(go.code).toBe(0);
    expect(go.text).not.toContain('storage:');
    expect(readShadowState(shadowDir())?.storage).toEqual({ managed: false, checked_at: NOW.toISOString() });
    const status = JSON.parse((await run(['status', '--json'])).out.join('\n'));
    expect(status.storage).toEqual({ managed: false, checked_at: NOW.toISOString(), note: null });
    reset();
  });

  test('a state file written before the field existed still reads, and reports storage: null', async () => {
    await onBrain(UNMANAGED);
    await run(['start', '--yes', '--expect', planHash(false)]);
    const file = join(shadowDir(), 'state.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    delete old.storage;
    writeFileSync(file, JSON.stringify(old));
    expect(readShadowState(shadowDir())?.enabled).toBe(true);
    const status = await run(['status', '--json']);
    expect(JSON.parse(status.out.join('\n')).storage).toBeNull();
    expect((await run(['status'])).text).not.toContain('storage:');
    reset();
  });
});

describe('a brain whose storage mode cannot be read does not block start', () => {
  const unread = (reason: string) => ({ managed: null, checked_at: NOW.toISOString(), reason });
  const READ_LINE = 'could not read whether this brain uses managed storage';

  async function startsWith(extra: Record<string, unknown>, reason: string, cfg?: EngineConfig) {
    const c = cfg ?? config;
    const key = shadowBrainKey(c)!;
    const dir = shadowDirFor(key);
    // An unread mode may hide a brain that can opt in, so it compares every write (D1): the hash is the rate-1.0 plan.
    const hash = shadowPlan(key, 'pglite', dir, { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND, writeSampleRate: OPT_IN_WRITE_SAMPLE_RATE }).hash;
    const opts = { ...extra, ...(cfg ? { config: () => cfg } : {}) };
    const plan = await run(['start', '--plan'], opts);
    expect(plan.err).toEqual([]);
    expect(plan.code).toBe(0);
    const text = plan.out.join('\n');
    expect(text).toContain(`  storage: ${READ_LINE}; the swap will check it (${reason})`);
    expect(text).toContain(`  write comparisons: storage could not be read (${reason}); every write is compared (rate ${OPT_IN_WRITE_SAMPLE_RATE})`);
    expect(text).toContain('if this brain uses managed storage, each save is about 2x slower until gbrain engine shadow start runs again and reads the mode');
    expect(text).toContain(`plan_hash: ${hash}`);
    const go = await run(['start', '--yes', '--expect', hash], opts);
    expect(go.err).toEqual([]);
    expect(go.code).toBe(0);
    expect(go.text).not.toContain('engine_swap_refused');
    expect(readShadowState(dir)?.enabled).toBe(true);
    expect(readShadowState(dir)?.storage).toEqual(unread(reason));
    expect(readShadowState(dir)?.write_sample_rate).toBe(OPT_IN_WRITE_SAMPLE_RATE);
    const status = JSON.parse((await run(['status', '--json'], opts)).out.join('\n'));
    expect(status.storage).toEqual({ ...unread(reason), note: `${READ_LINE}; the swap will check it` });
    rmSync(dir, { recursive: true, force: true });
  }

  test('--write-sample-rate still sets the rate when the mode is unread, and the plan prints no every-write line', async () => {
    const key = shadowBrainKey(config)!;
    const dir = shadowDirFor(key);
    const opts = { openPrimary: async () => { throw new Error('connection refused by the test'); } };
    const plan = await run(['start', '--plan', '--write-sample-rate', '0.2'], opts);
    expect(plan.code).toBe(0);
    expect(plan.text).not.toContain('every write is compared');
    const hash = shadowPlan(key, 'pglite', dir, { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND, writeSampleRate: 0.2 }).hash;
    expect((await run(['start', '--yes', '--expect', hash, '--write-sample-rate', '0.2'], opts)).code).toBe(0);
    expect(readShadowState(dir)?.write_sample_rate).toBe(0.2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a brain that cannot be opened', async () => {
    await startsWith({ openPrimary: async () => { throw new Error('connection refused by the test'); } }, 'open_failed');
  });

  test('a busy PGLite brain (another gbrain holds it)', async () => {
    await startsWith({ openPrimary: async () => { throw Object.assign(new Error('A running gbrain holds the PGLite lock.'), { code: 'pglite_busy' }); } }, 'pglite_busy');
  });

  test('a configured PGLite path with no brain: start succeeds and never creates the brain', async () => {
    const missing = join(home, 'no-such-brain');
    const cfg: EngineConfig = { engine: 'pglite', database_path: missing };
    await startsWith({}, 'no_brain', cfg);
    expect(existsSync(missing)).toBe(false);
  });

  test('an engine whose mode read throws is still disconnected', async () => {
    let disconnected = 0;
    const broken = { executeRaw: async () => { throw new Error('relation "persistence_brain" does not exist'); }, disconnect: async () => { disconnected++; } } as unknown as BrainEngine;
    await startsWith({ openPrimary: async () => broken }, 'read_failed');
    expect(disconnected).toBe(2); // the preview and --yes each open and close it
  });

  test('a missing or malformed managed-mode row is unread (storage_error), never unmanaged', async () => {
    for (const rows of [[], [{ enabled: 'yes' }]]) {
      const odd = { executeRaw: async () => rows, disconnect: async () => undefined } as unknown as BrainEngine;
      await startsWith({ openPrimary: async () => odd }, 'storage_error');
    }
  });

  test('a real brain whose managed-mode row was deleted is unread, and start still succeeds', async () => {
    await onBrain('DELETE FROM persistence_brain WHERE singleton=1');
    await startsWith({}, 'storage_error');
  });
});
