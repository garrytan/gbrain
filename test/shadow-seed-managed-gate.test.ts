/**
 * `gbrain engine shadow seed` on a brain that uses managed storage (src/shadow/managed-gate.ts).
 *
 * Protects: shadow mode seeds managed brains too; only the swap refuses them. `seed` and `seed --json` on a managed
 * brain exit 0, copy the rows, print "this brain cannot swap while it uses managed storage", and record
 * `storage: { managed: true, checked_at }` in seed.json (also in `status --json` and the report). A mode that cannot be
 * read (a busy PGLite brain, a missing or malformed mode row) does not block the seed: it records `managed: null` with a
 * reason code. A brain that cannot be opened at all is an error that writes nothing. Nothing here emits
 * `engine_swap_refused`. The seed leaves the primary untouched: every `persistence_*` row and the content root are
 * byte-identical before and after. Real PGLite primary and the real Rust store.
 * Regression it catches: a seed that refuses over the storage mode, drops the record, or writes to the primary.
 * Not covered elsewhere: test/shadow-seed.test.ts seeds an unmanaged brain; the Postgres twin is test/e2e/shadow-seed-managed-gate.test.ts.
 *
 * Needs the addon `bun run rust:build` writes and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import { readSeedRecord } from '../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { snapshotPersistence, snapshotTree } from './helpers/primary-snapshot.ts';
import { withEnv } from './helpers/with-env.ts';
import { fillSeedFixture } from './helpers/shadow-seed-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const LINE = 'this brain cannot swap while it uses managed storage';
const READ_LINE = 'could not read whether this brain uses managed storage; the swap will check it';
const MANAGED = 'UPDATE persistence_brain SET enabled=true WHERE singleton=1';
const NOW = new Date('2026-03-04T05:06:07.000Z');

let primary: PGLiteEngine;
let addon: RustAddon;
let contentRoot: string;
const homes: string[] = [];

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
  if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
});
afterAll(async () => { await primary.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(primary);
  contentRoot = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-content-'));
  homes.push(contentRoot);
  mkdirSync(join(contentRoot, 'people'), { recursive: true });
  writeFileSync(join(contentRoot, 'people', 'a.md'), '# a\n');
  writeFileSync(join(contentRoot, 'index.md'), '# index\n');
});
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

interface Run { code: number; out: string[]; err: string[]; dir: string; home: string; text: string }

/** Runs `gbrain engine shadow <args>` in a fresh home against `engine` (kept connected after the command). */
async function shadow(args: string[], engine: BrainEngine | (() => Promise<BrainEngine>) = primary, home?: string): Promise<Run> {
  const h = home ?? mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-gate-'));
  if (!home) homes.push(h);
  const config = { engine: 'pglite' as const, database_path: join(h, 'brain.pglite') };
  const out: string[] = [];
  const err: string[] = [];
  const kept = typeof engine === 'function' ? engine : async () => Object.create(engine, { disconnect: { value: async () => undefined } }) as BrainEngine;
  const dir = await withEnv({ GBRAIN_HOME: h }, async () => {
    const d = shadowDirFor(shadowBrainKey(config)!);
    await runEngineShadow(args, {
      config: () => config, out: l => out.push(l), err: l => err.push(l), now: () => NOW,
      loadAddon: async () => ({ ok: true as const, addon }), openPrimary: kept,
    }).then(code => { codes.set(out, code); });
    return d;
  });
  return { code: codes.get(out)!, out, err, dir, home: h, text: [...out, ...err].join('\n') };
}
const codes = new WeakMap<string[], number>();

const snapshot = async () => ({ tables: await snapshotPersistence(primary), files: snapshotTree(contentRoot) });

describe('engine shadow seed on a managed-storage brain', () => {
  withAddon('seed and seed --json succeed, print the line, record managed: true, and leave the primary byte-identical', async () => {
    await fillSeedFixture(primary);
    await primary.executeRaw(MANAGED);
    const before = await snapshot();
    expect(before.tables.persistence_brain!.some(r => r.includes('"enabled":true'))).toBe(true);
    expect(Object.keys(before.files)).toContain('people/a.md');
    for (const args of [['seed'], ['seed', '--json']]) {
      const r = await shadow(args);
      expect(r.code, `${args.join(' ')}: ${r.text}`).toBe(0);
      expect(r.text).not.toContain('engine_swap_refused');
      const rec = readSeedRecord(r.dir)!;
      expect(rec.storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
      expect(rec.relations.pages?.imported).toBe(2);
      if (args.includes('--json')) expect(JSON.parse(r.out.join('\n')).storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
      else expect(r.out).toContain(`  storage: ${LINE}`);
      const after = await snapshot();
      expect(after.tables, args.join(' ')).toEqual(before.tables);
      expect(after.files, args.join(' ')).toEqual(before.files);
    }
  }, 120_000);

  withAddon('status --json and the provisional report carry the recorded storage', async () => {
    await fillSeedFixture(primary);
    await primary.executeRaw(MANAGED);
    const r = await shadow(['seed']);
    expect(r.code).toBe(0);
    const [status, reportMd] = await withEnv({ GBRAIN_HOME: r.home }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(r.home, 'brain.pglite') };
      const st: string[] = [];
      await runEngineShadow(['status', '--json'], { config: () => config, out: l => st.push(l), err: () => undefined });
      const stText: string[] = [];
      await runEngineShadow(['status'], { config: () => config, out: l => stText.push(l), err: () => undefined });
      return [{ json: JSON.parse(st.join('\n')), text: stText }, renderProvisionalMarkdown(buildProvisionalReport(r.dir, 'b', null, NOW))] as const;
    });
    expect(status.json.seed.storage).toEqual({ managed: true, checked_at: NOW.toISOString(), note: LINE });
    expect(status.text).toContain(`  storage: ${LINE}`);
    expect(buildProvisionalReport(r.dir, 'b', null, NOW).seed?.storage).toEqual({ managed: true, checked_at: NOW.toISOString(), note: LINE });
    expect(reportMd).toContain(`Storage: ${LINE}.`);
  }, 120_000);

  withAddon('an unmanaged brain records managed: false and prints no storage line', async () => {
    await fillSeedFixture(primary);
    const r = await shadow(['seed']);
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('storage:');
    expect(readSeedRecord(r.dir)?.storage).toEqual({ managed: false, checked_at: NOW.toISOString() });
  }, 120_000);
});

describe('a brain whose storage mode cannot be read does not block the seed', () => {
  const unread = (reason: string) => ({ managed: null, checked_at: NOW.toISOString(), reason });
  /** The brain, except that its first raw query (the seed's mode read, made right before the snapshot) answers as `first`; every later query is the real one. */
  const readFailing = (first: () => Promise<unknown>): (() => Promise<BrainEngine>) => async () => {
    let calls = 0;
    return Object.create(primary, {
      executeRaw: { value: (...a: unknown[]) => (calls++ === 0 ? first() : (primary.executeRaw as (...x: unknown[]) => unknown)(...a)) },
      transaction: { value: (...a: unknown[]) => (primary.transaction as (...x: unknown[]) => unknown)(...a) },
      disconnect: { value: async () => undefined },
    }) as BrainEngine;
  };

  withAddon('a busy PGLite brain: seed proceeds and records null with pglite_busy', async () => {
    await fillSeedFixture(primary);
    const busy = Object.assign(new Error('A running gbrain holds the PGLite lock.'), { code: 'pglite_busy' });
    const r = await shadow(['seed'], readFailing(async () => { throw busy; }));
    expect(r.code, r.text).toBe(0);
    expect(r.text).not.toContain('engine_swap_refused');
    expect(r.out).toContain(`  storage: ${READ_LINE} (pglite_busy)`);
    expect(readSeedRecord(r.dir)?.storage).toEqual(unread('pglite_busy'));
    expect(readSeedRecord(r.dir)?.relations.pages?.imported).toBe(2);
  }, 120_000);

  withAddon('a missing mode row or a failing query: seed proceeds and records null with a reason code', async () => {
    await fillSeedFixture(primary);
    const missing = await shadow(['seed', '--json'], readFailing(async () => []));
    expect(missing.code, missing.text).toBe(0);
    expect(readSeedRecord(missing.dir)?.storage).toEqual(unread('storage_error'));
    const broken = await shadow(['seed'], readFailing(async () => { throw new Error('connection terminated by the test'); }));
    expect(broken.code, broken.text).toBe(0);
    expect(readSeedRecord(broken.dir)?.storage).toEqual(unread('read_failed'));
    expect(JSON.stringify(readSeedRecord(broken.dir))).not.toContain('connection terminated');
  }, 120_000);

  test('a brain that cannot be opened is an error that writes nothing (exit 1, no refusal code, no connection text)', async () => {
    for (const args of [['seed'], ['seed', '--json']]) {
      const leaky = new Error('connection to server at "db.example.internal" failed: postgresql://db.example.internal/brain?app=CANARYVALUE');
      const r = await shadow(args, async () => { throw leaky; });
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err[0]).toBe('engine shadow: could not open the brain (open_failed). Nothing was written.');
      expect(r.text).not.toContain('engine_swap_refused');
      expect(r.text).not.toContain('CANARYVALUE');
      expect(r.out).toEqual([]);
      expect(existsSync(r.dir)).toBe(false);
    }
    const busy = await shadow(['seed'], async () => { throw Object.assign(new Error('held'), { code: 'pglite_busy' }); });
    expect(busy.code).toBe(1);
    expect(busy.err.join('\n')).toContain('(pglite_busy)');
    expect(busy.err.join('\n')).toContain('Stop `gbrain serve`');
    expect(existsSync(busy.dir)).toBe(false);
  });

  test('help says a brain that cannot be opened stops the seed with exit 1, the way the command behaves', async () => {
    const lines: string[] = [];
    expect(await runEngineShadow(['--help'], { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
    const help = lines.join('\n').replace(/\s+/g, ' ');
    expect(help).toContain('a mode it cannot read does not stop the seed');
    expect(help).toContain('A brain that cannot be opened stops the seed: exit 1, `could not open the brain (pglite_busy)` while another process holds a PGLite brain, and nothing is written.');
  });
});

describe('engine shadow seed opens the configured brain without writing to it', () => {
  let home: string;
  let config: { engine: 'pglite'; database_path: string };
  beforeAll(async () => {
    // A real PGLite brain on disk, found the way `seed` finds it: through the config file under GBRAIN_HOME (no injected engine).
    home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-open-'));
    config = { engine: 'pglite', database_path: join(home, 'brain.pglite') };
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    const fresh = new PGLiteEngine();
    await fresh.connect(config);
    await fresh.initSchema();
    await fillSeedFixture(fresh);
    await fresh.disconnect();
  });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });
  const onBrain = async <T>(fn: (e: PGLiteEngine) => Promise<T>): Promise<T> => {
    const e = new PGLiteEngine();
    await e.connectForRestore(config); // this test's own opens must not record roots either
    try { return await fn(e); } finally { await e.disconnect(); }
  };

  const onBrainOpen = async (): Promise<PGLiteEngine> => {
    const e = new PGLiteEngine();
    await e.connectForRestore(config);
    return e;
  };

  withAddon('a registered source checkout gets no ownership marker and no registry entry, and persistence_* and the content root stay identical', async () => {
    // Registering a source is allowed only while the brain is unmanaged.
    await onBrain(e => e.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES('checkout','checkout',$1,'{}') ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path`, [contentRoot]));
    await onBrain(e => e.executeRaw(MANAGED));
    const markers = [join(contentRoot, '.gbrain-managed'), join(config.database_path, '.gbrain-managed')];
    const registry = join(home, '.gbrain', 'persistence');
    for (const m of markers) rmSync(m, { force: true });
    rmSync(registry, { recursive: true, force: true });
    const watched = async () => ({
      tables: await onBrain(snapshotPersistence),
      files: snapshotTree(contentRoot),
      registry: existsSync(registry) ? snapshotTree(registry) : {},
    });
    const before = await watched();
    expect(before.tables.persistence_brain!.some(r => r.includes('"enabled":true'))).toBe(true);
    expect(Object.keys(before.files)).toContain('people/a.md');
    expect(markers.filter(m => existsSync(m))).toEqual([]);

    const out: string[] = [];
    const err: string[] = [];
    const code = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
      runEngineShadow(['seed'], { out: l => out.push(l), err: l => err.push(l), now: () => NOW, loadAddon: async () => ({ ok: true as const, addon }) }));
    expect(code, [...out, ...err].join('\n')).toBe(0);
    expect(out).toContain(`  storage: ${LINE}`);

    expect(markers.filter(m => existsSync(m))).toEqual([]);
    const after = await watched();
    expect(after.registry).toEqual(before.registry);
    expect(after.files).toEqual(before.files);
    expect(after.tables).toEqual(before.tables);
  }, 120_000);

  withAddon('a brain with an open repair episode is not opened: the seed refuses, and the repair file and every backup stay as they were', async () => {
    // A healthy open closes an open repair episode and prunes older repair backups; a seed must not do either.
    const dir = config.database_path;
    const sidecar = `${dir}.wal-repair-attempt.json`;
    const backups = [1, 2, 3, 4].map(n => `${dir}.wal-repair-backup-${1_700_000_000_000 + n}`);
    for (const b of backups) { mkdirSync(join(b, 'pg_wal'), { recursive: true }); writeFileSync(join(b, 'pg_wal', 'x'), b); }
    writeFileSync(sidecar, JSON.stringify({ episodeStartedAt: 1_700_000_000_000, episodeBackupPath: backups[0], attempts: [] }));
    const watched = (): string[] => [readFileSync(sidecar, 'utf8'), ...backups.map(b => String(existsSync(join(b, 'pg_wal', 'x'))))];
    const before = watched();
    const out: string[] = [];
    const err: string[] = [];
    try {
      let storeDir = '';
      const code = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => {
        storeDir = shadowDirFor(shadowBrainKey(config)!);
        rmSync(storeDir, { recursive: true, force: true }); // the test above already seeded this brain
        return runEngineShadow(['seed'], { out: l => out.push(l), err: l => err.push(l), now: () => NOW, loadAddon: async () => ({ ok: true as const, addon }) });
      });
      expect(code, [...out, ...err].join('\n')).toBe(1);
      expect(err.join('\n')).toContain('could not open the brain (repair_episode_open)');
      expect(err.join('\n')).toContain('Nothing was written.');
      expect(watched()).toEqual(before);
      expect(before.slice(1)).toEqual(['true', 'true', 'true', 'true']);
      expect(existsSync(storeDir)).toBe(false);
    } finally {
      rmSync(sidecar, { force: true });
      for (const b of backups) rmSync(b, { recursive: true, force: true });
    }
  }, 120_000);

  withAddon('a repair episode recorded while the seed waits for the datastore lock is still left open, with every backup', async () => {
    // The refusal above checks before the open takes the lock; a repair that finishes while the seed waits records its episode later.
    const dir = config.database_path;
    const sidecar = `${dir}.wal-repair-attempt.json`;
    const backups = [1, 2, 3, 4].map(n => `${dir}.wal-repair-backup-${1_700_000_000_000 + n}`);
    const watched = (): string[] => [readFileSync(sidecar, 'utf8'), ...backups.map(b => String(existsSync(join(b, 'pg_wal', 'x'))))];
    const holder = await onBrainOpen();
    const out: string[] = [];
    const err: string[] = [];
    let held = true;
    try {
      const seeding = withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => {
        rmSync(shadowDirFor(shadowBrainKey(config)!), { recursive: true, force: true }); // the tests above already seeded this brain
        return runEngineShadow(['seed'], { out: l => out.push(l), err: l => err.push(l), now: () => NOW, loadAddon: async () => ({ ok: true as const, addon }) });
      });
      await new Promise(r => setTimeout(r, 800)); // the seed has passed its check and is waiting for the lock
      for (const b of backups) { mkdirSync(join(b, 'pg_wal'), { recursive: true }); writeFileSync(join(b, 'pg_wal', 'x'), b); }
      writeFileSync(sidecar, JSON.stringify({ episodeStartedAt: 1_700_000_000_000, episodeBackupPath: backups[0], attempts: [] }));
      const before = watched();
      await holder.disconnect();
      held = false;
      const code = await seeding;
      // On a machine too slow to reach the lock within the pause, the seed's own check sees the episode and refuses; either way nothing changes.
      expect(code === 0 || (code === 1 && err.join('\n').includes('repair_episode_open')), [...out, ...err].join('\n')).toBe(true);
      expect(watched()).toEqual(before);
      expect(before.slice(1)).toEqual(['true', 'true', 'true', 'true']);
    } finally {
      if (held) await holder.disconnect();
      rmSync(sidecar, { force: true });
      for (const b of backups) rmSync(b, { recursive: true, force: true });
    }
  }, 120_000);
});
