/**
 * `gbrain engine shadow seed` refuses a brain that uses managed storage (src/shadow/managed-gate.ts).
 *
 * Protects: the Rust engine never holds managed storage, so seeding a store from such a brain copies data nothing
 * can use. `seed` and `seed --json` exit 3 with `engine_swap_refused (managed_storage)` before the shadow directory
 * is created, before the Rust store opens and before the seed's snapshot transaction starts, so a refused seed
 * leaves no directory, no store and no seed.json. A brain whose mode cannot be read or opened refuses the same way
 * (never a pass), and an unmanaged brain still seeds. Real PGLite primary.
 * Regression it catches: a seed that creates the store first or reads a managed brain before refusing.
 * Not covered elsewhere: test/shadow-seed.test.ts covers seed on an unmanaged brain; the start gate has its own tests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readSeedRecord } from '../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { fillSeedFixture } from './helpers/shadow-seed-fixture.ts';

let primary: PGLiteEngine;
const homes: string[] = [];

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
});
afterAll(async () => { await primary.disconnect(); });
beforeEach(async () => { await resetPgliteState(primary); });
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const MANAGED = 'UPDATE persistence_brain SET enabled=true WHERE singleton=1';

interface Run { code: number; out: string[]; err: string[]; dir: string; storeOpens: number; addonLoads: number; transactions: number; disconnects: number }

/** Runs `gbrain engine shadow <args>` in a temporary home against `engine` (kept connected after the command). */
async function seedCommand(args: string[], engine: BrainEngine | (() => Promise<BrainEngine>)): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-gate-'));
  homes.push(home);
  const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
  const r: Run = { code: -1, out: [], err: [], dir: '', storeOpens: 0, addonLoads: 0, transactions: 0, disconnects: 0 };
  const watched = typeof engine === 'function' ? null : Object.create(engine, {
    transaction: { value: (...a: unknown[]) => { r.transactions++; return (engine.transaction as (...x: unknown[]) => unknown)(...a); } },
    disconnect: { value: async () => { r.disconnects++; } },
  }) as BrainEngine;
  await withEnv({ GBRAIN_HOME: home }, async () => {
    r.dir = shadowDirFor(shadowBrainKey(config)!);
    r.code = await runEngineShadow(args, {
      config: () => config, out: l => r.out.push(l), err: l => r.err.push(l),
      loadAddon: async () => { r.addonLoads++; return { ok: true as const, addon: {} as never }; },
      // A locked store ends the command at once with exit 1, so a brain that passes the gate stops here without seeding.
      openStore: async () => { r.storeOpens++; throw Object.assign(new Error('locked by the test'), { code: 'rust_store_locked' }); },
      openPrimary: typeof engine === 'function' ? engine : async () => watched!,
    });
  });
  return r;
}

describe('engine shadow seed on a managed-storage brain', () => {
  test('seed and seed --json refuse with exit 3 and create nothing', async () => {
    await fillSeedFixture(primary);
    await primary.executeRaw(MANAGED);
    for (const args of [['seed'], ['seed', '--json']]) {
      const r = await seedCommand(args, primary);
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.err[0], args.join(' ')).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: this brain uses managed storage.');
      expect(r.err.join('\n')).toContain('The Rust engine never holds managed storage, so this brain can never swap to Rust');
      expect(r.err.join('\n')).toContain('Brains made by a default `gbrain init` use managed storage and cannot be shadowed or swapped yet.');
      expect(r.err.join('\n')).toContain('`gbrain init --db-only`');
      expect(r.err.join('\n')).toContain('`gbrain sources writer deactivate --dry-run`');
      expect(r.err.join('\n')).toContain('Nothing was written');
      expect(existsSync(r.dir), args.join(' ')).toBe(false);
      expect(readSeedRecord(r.dir)).toBeNull();
      expect(r.storeOpens).toBe(0);
      expect(r.addonLoads).toBe(0);
      expect(r.transactions).toBe(0);
      expect(r.disconnects).toBe(1);
      if (args.includes('--json')) {
        const body = JSON.parse(r.out.join('\n'));
        expect(body).toMatchObject({ error: 'engine_swap_refused', code: 'engine_swap_refused', reason: 'managed_storage', class: 'consent' });
        expect(body.fix.next).toBe('ask_user');
      } else {
        expect(r.out).toEqual([]);
      }
    }
  });

  test('a brain whose mode cannot be read or opened refuses and names the error', async () => {
    const broken = { executeRaw: async () => { throw new Error('connection terminated by the test'); }, disconnect: async () => undefined } as unknown as BrainEngine;
    const read = await seedCommand(['seed'], async () => broken);
    expect(read.code).toBe(3);
    expect(read.err[0]).toContain('could not confirm that this brain does not use managed storage');
    expect(read.err.join('\n')).toContain('connection terminated by the test');
    expect(existsSync(read.dir)).toBe(false);
    const opened = await seedCommand(['seed'], async () => { throw new Error('could not connect, said the test'); });
    expect(opened.code).toBe(3);
    expect(opened.err[0]).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.');
    expect(opened.err.join('\n')).toContain('could not connect, said the test');
    expect(opened.err.join('\n')).not.toMatch(/refused: this brain uses managed storage|This brain uses managed storage/);
    expect(existsSync(opened.dir)).toBe(false);
    expect(opened.storeOpens).toBe(0);
  });

  // Value: protects=the refusal never prints a database address or password a failed open or mode read carried; fails_when=the error text reaches either stream unredacted;
  // why_new=the refusal tests only check that the error text is named; seam=none; no_claim=redaction of text the database error never carried.
  test('a failed open or mode read is named without its connection address or password, in text and --json', async () => {
    const leaky = (what: string) => `${what}: connection to server at "db.example.internal" (10.1.2.3), port 5432 failed: postgresql://db.example.internal:5432/brain?password=CANARYVALUE`;
    const broken = { executeRaw: async () => { throw new Error(leaky('read')); }, disconnect: async () => undefined } as unknown as BrainEngine;
    for (const args of [['seed'], ['seed', '--json']]) {
      for (const engine of [async () => broken, async () => { throw new Error(leaky('open')); }]) {
        const r = await seedCommand(args, engine);
        expect(r.code, args.join(' ')).toBe(3);
        const text = [...r.err, ...r.out].join('\n');
        expect(text).toContain('connection to server at');
        expect(text).not.toContain('CANARYVALUE');
        expect(text).not.toContain('10.1.2.3');
        expect(existsSync(r.dir)).toBe(false);
      }
    }
  });

  test('a busy PGLite brain (another gbrain holds it) is refused honestly, with the stop-serve next step', async () => {
    const busy = Object.assign(new Error('A running gbrain holds the PGLite lock.'), { code: 'pglite_busy' });
    for (const args of [['seed'], ['seed', '--json']]) {
      const r = await seedCommand(args, async () => { throw busy; });
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.err[0]).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.');
      const text = r.err.join('\n');
      expect(text).toContain('pglite_busy');
      expect(text).toContain('stop `gbrain serve`');
      expect(text).toContain('restart serve');
      expect(text).not.toMatch(/refused: this brain uses managed storage|This brain uses managed storage/);
      expect(existsSync(r.dir)).toBe(false);
      expect(r.storeOpens).toBe(0);
      if (args.includes('--json')) expect(JSON.parse(r.out.join('\n')).message).toContain('could not confirm');
    }
  });

  test('an unmanaged brain passes the gate and goes on to open the store', async () => {
    await fillSeedFixture(primary);
    const r = await seedCommand(['seed'], primary);
    expect(r.storeOpens).toBe(1);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).not.toContain('engine_swap_refused');
    expect(r.disconnects).toBe(1);
  });
});
