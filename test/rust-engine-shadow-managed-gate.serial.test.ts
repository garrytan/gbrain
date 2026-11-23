/**
 * `gbrain engine shadow start` refuses a brain that uses managed storage (src/shadow/managed-gate.ts).
 *
 * Protects: the Rust engine never holds managed storage, so a shadow on such a brain measures nothing it could use.
 * The preview, `--plan` and `--yes --expect <hash>` each exit 3 with `engine_swap_refused (managed_storage)` before
 * the addon loads and before any shadow file exists; a brain whose mode cannot be read or opened refuses the same way
 * (never a silent pass); an unmanaged brain still gets its plan. Uses a real PGLite brain on disk and the real default
 * open path (no injected engine). Serial because it sets GBRAIN_HOME.
 * Regression it catches: start that mirrors a managed brain, or that writes state.json before checking.
 * Not covered elsewhere: test/rust-engine-shadow.serial.test.ts covers start on an unmanaged brain with a fake engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow, shadowPlan } from '../src/commands/engine-shadow.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';

let home: string;
let restoreEnv: () => void;
let config: EngineConfig;

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

const MANAGED = 'UPDATE persistence_brain SET enabled=true WHERE singleton=1';
const UNMANAGED = 'UPDATE persistence_brain SET enabled=false WHERE singleton=1';
const shadowDir = (): string => shadowDirFor(shadowBrainKey(config)!);
const planHash = (): string => shadowPlan(shadowBrainKey(config)!, 'pglite', shadowDir(),
  { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND }).hash;
const loadAddonMustNotRun = async (): Promise<never> => { throw new Error('the addon was loaded before the managed-storage check'); };

async function run(args: string[], extra: Record<string, unknown> = {}) {
  const c = capture();
  const code = await runEngineShadow(args, { ...c.deps, config: () => config, loadAddon: loadAddonMustNotRun, ...extra });
  return { code, out: c.out, err: c.err };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-managed-'));
  const saved = { GBRAIN_HOME: process.env.GBRAIN_HOME, GBRAIN_SHADOW_CHILD: process.env.GBRAIN_SHADOW_CHILD, GBRAIN_RUST_ENGINE_ADDON: process.env.GBRAIN_RUST_ENGINE_ADDON };
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_SHADOW_CHILD;
  delete process.env.GBRAIN_RUST_ENGINE_ADDON;
  restoreEnv = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  config = { engine: 'pglite', database_path: join(home, 'brain.pglite') };
  const engine = new PGLiteEngine();
  await engine.connect(config);
  await engine.initSchema();
  await engine.disconnect();
});

afterAll(() => { restoreEnv(); rmSync(home, { recursive: true, force: true }); });

describe('engine shadow start on a managed-storage brain', () => {
  test('--plan, the bare preview and --yes --expect each refuse with exit 3 and write nothing', async () => {
    await onBrain(MANAGED);
    const hash = planHash();
    for (const args of [['start', '--plan'], ['start'], ['start', '--yes', '--expect', hash]]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.err[0], args.join(' ')).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: this brain uses managed storage.');
      const text = r.err.join('\n');
      expect(text).toContain('The Rust engine never holds managed storage, so this brain can never swap to Rust');
      expect(text).toContain('Ask the user');
      expect(text).toContain('Brains made by a default `gbrain init` use managed storage and cannot be shadowed or swapped yet.');
      expect(text).toContain('`gbrain init --db-only`');
      expect(text).toContain('`gbrain sources writer deactivate --dry-run`');
      expect(text).toContain('Nothing was written');
      expect(r.out.join('\n')).not.toContain('plan_hash');
      expect(existsSync(shadowDir()), args.join(' ')).toBe(false);
    }
  });

  test('an unmanaged brain still gets its plan', async () => {
    await onBrain('INSERT INTO persistence_brain(singleton) VALUES (1) ON CONFLICT DO NOTHING');
    await onBrain(UNMANAGED);
    const r = await run(['start', '--plan']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain(`plan_hash: ${planHash()}`);
    expect(existsSync(shadowDir())).toBe(false);
  });

  test('a brain that cannot be opened refuses and names the open error', async () => {
    const r = await run(['start', '--plan'], { openPrimary: async () => { throw new Error('connection refused by the test'); } });
    expect(r.code).toBe(3);
    expect(r.err[0]).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.');
    expect(r.err.join('\n')).toContain('connection refused by the test');
    expect(r.err.join('\n')).not.toMatch(/refused: this brain uses managed storage|This brain uses managed storage/);
    expect(existsSync(shadowDir())).toBe(false);
  });

  test('a busy PGLite brain (another gbrain holds it) is refused honestly, with the stop-serve next step', async () => {
    const busy = Object.assign(new Error('A running gbrain holds the PGLite lock.'), { code: 'pglite_busy' });
    const r = await run(['start', '--plan'], { openPrimary: async () => { throw busy; } });
    expect(r.code).toBe(3);
    expect(r.err[0]).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.');
    const text = r.err.join('\n');
    expect(text).toContain('pglite_busy');
    expect(text).toContain('stop `gbrain serve`');
    expect(text).toContain('restart serve');
    expect(text).not.toMatch(/refused: this brain uses managed storage|This brain uses managed storage/);
    expect(existsSync(shadowDir())).toBe(false);
  });

  test('a configured PGLite path with no brain refuses and is never created', async () => {
    const missing = join(home, 'no-such-brain');
    const r = await run(['start', '--plan'], { config: () => ({ engine: 'pglite', database_path: missing }) });
    expect(r.code).toBe(3);
    expect(r.err[0]).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.');
    expect(r.err.join('\n')).toContain(`no brain exists at ${missing}`);
    expect(existsSync(missing)).toBe(false);
  });

  test('an engine whose mode read throws refuses and is still disconnected', async () => {
    let disconnected = 0;
    const broken = { executeRaw: async () => { throw new Error('relation "persistence_brain" does not exist'); }, disconnect: async () => { disconnected++; } } as unknown as BrainEngine;
    const r = await run(['start', '--plan'], { openPrimary: async () => broken });
    expect(r.code).toBe(3);
    expect(r.err.join('\n')).toContain('persistence_brain" does not exist');
    expect(disconnected).toBe(1);
  });

  test('an engine whose managed-mode row is missing or malformed refuses with persistence_mode_unknown', async () => {
    for (const rows of [[], [{ enabled: 'yes' }]]) {
      let disconnected = 0;
      const odd = { executeRaw: async () => rows, disconnect: async () => { disconnected++; } } as unknown as BrainEngine;
      const r = await run(['start', '--plan'], { openPrimary: async () => odd });
      expect(r.code, JSON.stringify(rows)).toBe(3);
      expect(r.err[0]).toContain('engine_swap_refused (managed_storage)');
      expect(r.err.join('\n')).toContain('persistence_mode_unknown');
      expect(disconnected).toBe(1);
    }
  });

  test('a brain whose managed-mode row is missing cannot even be opened, and refuses (no silent pass)', async () => {
    await onBrain('DELETE FROM persistence_brain WHERE singleton=1');
    const r = await run(['start', '--plan']);
    expect(r.code).toBe(3);
    expect(r.err[0]).toContain('engine_swap_refused (managed_storage)');
    expect(r.err.join('\n')).toContain('storage_error');
    expect(existsSync(shadowDir())).toBe(false);
  });
});
