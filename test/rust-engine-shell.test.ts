/**
 * The Rust engine shell (docs/designs/RUST_ENGINE.md, "PR sequence" step 8). `openRustEngine` takes an addon the
 * loader already verified and returns an engine that declares no capabilities and refuses every unimplemented
 * member with `engine_capability_missing` before any work. SQL-only paths refuse a Rust kind instead of treating it as
 * Postgres. No real addon exists yet, so the tests pass a plain object as the verified addon.
 */
import { describe, expect, test } from 'bun:test';
import { openRustEngine, RustEngine, rustMemberCapability } from '../src/core/rust-engine.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { isSqlEngineKind, sqlEngineKind } from '../src/core/sql-engine-kind.ts';
import { stageBatchBytes, STAGE_BATCH_BYTES } from '../src/core/page-body/limits.ts';
import { CODES } from '../src/core/error-registry.ts';
import { ENGINE_CAPABILITIES } from '../src/core/engine-capabilities.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const addon = { target: 'linux-x64-glibc', engine_abi: 1 };
const open = () => openRustEngine({ addon, databasePath: '/var/brains/test.rust' });

/** Runs `fn`, expecting an OperationError, and returns it. */
async function refusal(fn: () => unknown): Promise<OperationError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected a refusal');
}

describe('openRustEngine', () => {
  test('returns a Rust engine that keeps the verified addon and store path and reports no capabilities', () => {
    const engine = open();
    expect(engine).toBeInstanceOf(RustEngine);
    expect(engine.kind).toBe('rust');
    expect(engine.capabilities.size).toBe(0);
    expect(engine.addon).toBe(addon);
    expect(engine.databasePath).toBe('/var/brains/test.rust');
  });

  test('every unimplemented member refuses engine_capability_missing naming its capability, writing nothing', async () => {
    const engine = open() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const refused = Object.entries(RUST_ENGINE_MEMBERS).filter(([, cls]) => cls !== 'implemented');
    expect(refused.length).toBeGreaterThan(150);
    for (const [member, capability] of refused) {
      expect(typeof engine[member]).toBe('function');
      const error = await refusal(() => engine[member]!());
      expect({ member, code: error.code, reason: error.reason }).toEqual({ member, code: 'engine_capability_missing', reason: capability });
      expect(error.detail).toContain(`member=${member}`);
      expect(error.detail).toContain('written=nothing');
      expect(rustMemberCapability(member)).toBe(capability as never);
    }
    expect(rustMemberCapability('connect')).toBeNull();
  });

  test('every member class is the lifecycle or a named engine capability', () => {
    for (const cls of Object.values(RUST_ENGINE_MEMBERS)) {
      expect(cls === 'implemented' || (ENGINE_CAPABILITIES as readonly string[]).includes(cls)).toBe(true);
    }
  });

  test('connect, reconnect and disconnect run the lifecycle; disconnect runs every registered stop once', async () => {
    const engine = open();
    let stopped = 0;
    engine.registerBeforeDisconnect(async () => { stopped++; });
    const unregister = engine.registerBeforeDisconnect(async () => { stopped += 100; });
    unregister();
    engine.registerBeforeDisconnect(async () => { throw new Error('a failing stop never blocks shutdown'); });
    await engine.reconnect(); // never connected: nothing to restore
    expect(engine.connected).toBe(false);
    await engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    expect(engine.connected).toBe(true);
    await engine.reconnect();
    expect(engine.connected).toBe(true);
    expect(stopped).toBe(1);
    await engine.disconnect();
    expect(engine.connected).toBe(false);
    expect(stopped).toBe(1);
  });

  test('a partial or unknown outcome says what may have been written', () => {
    expect(capabilityMissing('raw_sql', 'x', 'partial').detail).toContain('written=partial');
    expect(capabilityMissing('raw_sql', 'x', 'unknown').message).not.toContain('nothing ran');
  });
});

describe('Rust kind on SQL-only paths', () => {
  test('engine_capability_missing is registered with every engine capability as a reason', () => {
    const rows = CODES as unknown as Record<string, { reasons?: readonly string[] }>;
    expect(rows.engine_capability_missing?.reasons).toEqual([...ENGINE_CAPABILITIES]);
  });

  test('sqlEngineKind and stageBatchBytes refuse a Rust brain instead of treating it as Postgres', async () => {
    expect(isSqlEngineKind('pglite')).toBe(true);
    expect(isSqlEngineKind('rust')).toBe(false);
    expect(sqlEngineKind('postgres', 'x')).toBe('postgres');
    const error = await refusal(() => sqlEngineKind('rust', 'gbrain migrate'));
    expect([error.code, error.reason]).toEqual(['engine_capability_missing', 'raw_sql']);
    expect(stageBatchBytes('pglite')).toBe(STAGE_BATCH_BYTES.pglite);
    const staged = await refusal(() => stageBatchBytes('rust'));
    expect(staged.code).toBe('engine_capability_missing');
  });
});
