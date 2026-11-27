/**
 * Selecting `engine: rust` (docs/designs/RUST_ENGINE.md, "PR sequence" step 8): constructEngine builds the Rust engine
 * shell from a verified addon, and a serve process offers no persistence socket on an engine without the persistence
 * journal.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: a rust brain with no or a relative database_path is config_error; a missing or wrong addon is
 *    rust_engine_addon_missing or rust_engine_addon_mismatch from constructEngine, before any engine exists and with
 *    nothing written to the gbrain home; servePersistenceIpcProvider returns no provider on an engine without
 *    persistence_journal, after registering the cli and stdio local writers through the typed registration members
 *    alone, and goes on to the provider on an engine that has it.
 * 2. Credible regressions: constructEngine still rejecting `rust` as an unknown engine; opening the shell with a
 *    relative store path; swallowing a loader refusal; a serve path calling createPersistenceIpcProvider on a Rust
 *    engine, which starts a SQL consumer the store refuses; a Rust serve that registers no local writer, so every
 *    remote write-request read answers writer_registration_required; the gate skipping the provider on PGLite or
 *    Postgres too.
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
import { readLocalWriter } from '../src/core/persistence/identity.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { HELD_FOR_CALLERS, MULTIUSER_WITHHELD, storeCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
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

  /**
   * An engine that serves only the three typed writer-registration members, from memory, and records every other member
   * read (each of which fails): a serve that reaches for SQL or any other member shows up in `touched`.
   */
  function registrationEngine(capabilities: ReadonlySet<string>): { engine: BrainEngine; touched: string[]; rows: Map<string, { lane: string }> } {
    const touched: string[] = [];
    const rows = new Map<string, { lane: string; credential_hash: string; grant_ceiling: unknown; revoked_at: null }>();
    const members: Record<string, unknown> = {
      capabilities,
      readPersistenceBrainId: async () => 'b0000000-0000-4000-8000-0000000000aa',
      readLocalWriterRow: async (id: string) => rows.get(id),
      insertLocalWriterRow: async (row: { id: string; lane: string; credentialHash: string; grant: unknown }) => {
        if (rows.has(row.id)) return false;
        rows.set(row.id, { lane: row.lane, credential_hash: row.credentialHash, grant_ceiling: row.grant, revoked_at: null });
        return true;
      },
    };
    const engine = new Proxy(members, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Symbol keys are the per-engine cache lookups (engine-key.ts), not engine members.
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        touched.push(String(prop));
        throw new Error('engine member touched');
      },
    }) as unknown as BrainEngine;
    return { engine, touched, rows };
  }

  test('an engine without the persistence journal gets no provider, and its local writers are registered through the typed members only', async () => {
    // The explicit no-journal fixture: the store reports the journal now, so this instance takes it off.
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 }, databasePath: '/var/brains/test.rust' });
    for (const capability of ['persistence_journal', 'managed_persistence'] as const) (rust.capabilities as Set<string>).delete(capability);
    expect(rust.capabilities.has('persistence_journal')).toBe(false);
    const home = tempDir('gbrain-rust-serve-writers-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const { engine, touched, rows } = registrationEngine(rust.capabilities);
      expect(await servePersistenceIpcProvider(engine, { engine: 'rust' })).toBeUndefined();
      // A second serve start finds both registrations and leaves them as they are.
      expect(await servePersistenceIpcProvider(engine, { engine: 'rust' })).toBeUndefined();
      expect(touched).toEqual([]);
      expect([...rows.values()].map(row => row.lane).sort()).toEqual(['cli', 'stdio']);
      const brain = 'b0000000-0000-4000-8000-0000000000aa';
      // The registration lock directory (persistence/locks) sits next to the credential files.
      expect(readdirSync(join(home, '.gbrain', 'persistence')).filter(name => name !== 'locks').sort()).toEqual([`${brain}.cli.json`, `${brain}.stdio.json`]);
      // The registration a remote caller's write and receipt reads run under: readLocalWriter finds it.
      const local = await readLocalWriter(engine, 'stdio');
      expect(rows.has(local.id)).toBe(true);
    });
  });

  // The flip released persistence_journal; slice 2 (lane LM) released managed_persistence for a single-host store.
  test('the Rust engine reports persistence_journal', () => {
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 }, databasePath: '/var/brains/test.rust' });
    expect(rust.capabilities.has('persistence_journal')).toBe(true);
  });

  test('the Rust engine reports managed_persistence and holds nothing back, on a single-host and on a multi-user store (slice 3)', async () => {
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 }, databasePath: '/var/brains/test.rust' });
    expect(rust.capabilities.has('managed_persistence')).toBe(true);
    expect(HELD_FOR_CALLERS).toEqual({});
    expect(MULTIUSER_WITHHELD).toEqual([]);
    expect(storeCapabilities({ multiuser: false }).has('managed_persistence')).toBe(true);
    expect(storeCapabilities({ multiuser: true }).has('managed_persistence')).toBe(true);
    // The parity arm table says the same as the engine, on and off the switch.
    const { armCapabilities } = await import('./engine-parity/arm-capabilities.ts');
    expect(armCapabilities('rust', {}).has('managed_persistence')).toBe(true);
    expect(armCapabilities('rust', { GBRAIN_RUST_MULTIUSER: '1' }).has('managed_persistence')).toBe(true);
  });

  test('an engine with the persistence journal goes on to the provider', async () => {
    const { engine, touched } = recordingEngine(new Set(['persistence_journal']));
    await expect(servePersistenceIpcProvider(engine, { engine: 'pglite' })).rejects.toThrow('engine member touched');
    expect(touched.length).toBeGreaterThan(0);
  });
});
