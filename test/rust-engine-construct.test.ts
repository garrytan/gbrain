/**
 * Selecting `engine: rust` (docs/designs/RUST_ENGINE.md, "PR sequence" step 8): constructEngine builds the Rust engine
 * shell from a verified addon, and a serve process offers no persistence socket on an engine without the persistence
 * journal.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: a rust brain with no or a relative database_path is config_error; a missing or wrong addon is
 *    rust_engine_addon_missing or rust_engine_addon_mismatch from constructEngine, before any engine exists and with
 *    nothing written to the gbrain home; servePersistenceIpcProvider touches nothing on an engine without
 *    persistence_journal and returns no provider, and goes on to the provider on an engine that has it.
 * 2. Credible regressions: constructEngine still rejecting `rust` as an unknown engine; opening the shell with a
 *    relative store path; swallowing a loader refusal; a serve path calling createPersistenceIpcProvider on a Rust
 *    engine, whose writer registration and persistence_brain read are SQL the shell refuses; the gate skipping the
 *    provider on PGLite or Postgres too.
 * 3. Why not already covered: rust-engine-addon-loader.test.ts calls the loader directly and rust-engine-shell.test.ts
 *    calls openRustEngine directly; neither goes through constructEngine or the serve wiring.
 * 4. Production seam: GBRAIN_HOME and GBRAIN_RUST_ENGINE_ADDON (the loader's defaults read them); no new seam.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructEngine } from '../src/core/engine-construct.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { servePersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Runs `fn`, expecting an OperationError, and returns it. */
async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected a refusal');
}

describe('constructEngine with engine: rust', () => {
  test('no database_path, or a relative one, is config_error and loads no addon', async () => {
    const home = tempDir('gbrain-rust-construct-');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: undefined }, async () => {
      for (const database_path of [undefined, '', 'brains/test.rust']) {
        const err = await refusal(() => constructEngine({ engine: 'rust', database_path }));
        expect({ database_path, code: err.code }).toEqual({ database_path, code: 'config_error' });
      }
    });
    expect(readdirSync(home)).toEqual([]);
  });

  test('no cached addon is rust_engine_addon_missing, and the gbrain home stays empty', async () => {
    const home = tempDir('gbrain-rust-construct-');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: undefined }, async () => {
      const err = await refusal(() => constructEngine({ engine: 'rust', database_path: join(home, 'brain.rust') }));
      expect(err.code).toBe('rust_engine_addon_missing');
    });
    expect(readdirSync(home)).toEqual([]);
  });

  test('a development override that is not an addon is rust_engine_addon_mismatch, and no store is created', async () => {
    const home = tempDir('gbrain-rust-construct-');
    const fake = join(home, 'not-an-addon.node');
    writeFileSync(fake, 'not a real addon');
    const dbPath = join(home, 'brain.rust');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: fake }, async () => {
      const err = await refusal(() => constructEngine({ engine: 'rust', database_path: dbPath }));
      expect(err.code).toBe('rust_engine_addon_mismatch');
    });
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(home)).toEqual(['not-an-addon.node']);
  });

  test('an unknown engine still names rust among the supported engines', async () => {
    await expect(constructEngine({ engine: 'sqlite' as never })).rejects.toThrow('Supported engines: postgres, pglite, rust.');
  });
});

describe('servePersistenceIpcProvider (the serve-path persistence socket)', () => {
  /** An engine that records every member read other than `capabilities`, and fails each one. */
  function recordingEngine(capabilities: ReadonlySet<string>): { engine: BrainEngine; touched: string[] } {
    const touched: string[] = [];
    const engine = new Proxy({ capabilities }, {
      get(target, prop) {
        if (prop === 'capabilities') return target.capabilities;
        if (prop === 'then') return undefined;
        touched.push(String(prop));
        throw new Error('engine member touched');
      },
    }) as unknown as BrainEngine;
    return { engine, touched };
  }

  test('the Rust engine shell gets no provider and none of its members is called', async () => {
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 }, databasePath: '/var/brains/test.rust' });
    expect(rust.capabilities.has('persistence_journal')).toBe(false);
    expect(await servePersistenceIpcProvider(rust, { engine: 'rust' })).toBeUndefined();
    const { engine, touched } = recordingEngine(rust.capabilities);
    expect(await servePersistenceIpcProvider(engine, { engine: 'rust' })).toBeUndefined();
    expect(touched).toEqual([]);
  });

  test('an engine with the persistence journal goes on to the provider', async () => {
    const { engine, touched } = recordingEngine(new Set(['persistence_journal']));
    await expect(servePersistenceIpcProvider(engine, { engine: 'pglite' })).rejects.toThrow('engine member touched');
    expect(touched.length).toBeGreaterThan(0);
  });
});
