/**
 * `managedStorageRefusal` (src/shadow/managed-gate.ts): the one check `gbrain engine shadow start` and `seed` share.
 *
 * Protects: a managed-storage brain (persistence_brain.enabled = true) gets the `engine_shadow_refused` /
 * `managed_storage` refusal (consent class, exit 3, ask the user); an unmanaged brain gets null; any failure to read
 * the mode (query error, missing, duplicated or non-boolean singleton) is also a refusal that carries the read error,
 * never a pass. Regression it catches: a gate that lets a brain through because its mode could not be read.
 * Not covered elsewhere: test/rust-engine-shadow-managed-gate.serial.test.ts drives the CLI end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { managedStorageRefusal } from '../src/shadow/managed-gate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { toAgentError, cliRenderContext } from '../src/core/agent-output.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const engineReading = (rows: unknown): BrainEngine => ({ executeRaw: async () => rows }) as unknown as BrainEngine;
const engineThrowing = (e: Error): BrainEngine => ({ executeRaw: async () => { throw e; } }) as unknown as BrainEngine;

describe('managedStorageRefusal', () => {
  test('a managed brain is refused with the consent shape', async () => {
    const e = (await managedStorageRefusal(engineReading([{ enabled: true }])))!;
    expect(e).not.toBeNull();
    expect(e.code).toBe('engine_shadow_refused');
    expect(e.reason).toBe('managed_storage');
    expect(e.message).toBe('Shadow mode is refused: this brain uses managed storage.');
    expect(e.why).toBe('This brain uses managed storage. The Rust engine never holds managed storage, so this brain can never swap to Rust and a shadow on it measures nothing it could use.');
    expect(e.suggestion).toContain('Ask the user');
    expect(e.suggestion).toContain('nothing was written');
    expect(e.detail).toBeUndefined();
    expect(e.fix).toMatchObject({ ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--probe', '--json'] } });
    const envelope = toAgentError(e, { transport: 'cli', command: 'engine shadow', render: cliRenderContext() });
    expect(envelope.code).toBe('engine_shadow_refused');
    expect(envelope.class).toBe('consent');
    expect(exitCodeForCode(envelope.code, envelope.reason)).toBe(3);
    expect(envelope.fix?.next).toBe('ask_user');
  });

  test('an unmanaged brain passes', async () => {
    expect(await managedStorageRefusal(engineReading([{ enabled: false }]))).toBeNull();
  });

  test('every way the mode cannot be read is a refusal that carries the read error', async () => {
    const cases: Array<[string, BrainEngine, string]> = [
      ['query error', engineThrowing(new Error('connection terminated')), 'connection terminated'],
      ['no singleton row', engineReading([]), 'persistence_mode_unknown'],
      ['duplicated rows', engineReading([{ enabled: false }, { enabled: false }]), 'persistence_mode_unknown'],
      ['non-boolean enabled', engineReading([{ enabled: 'false' }]), 'persistence_mode_unknown'],
    ];
    for (const [name, engine, expected] of cases) {
      const e = (await managedStorageRefusal(engine))!;
      expect(e, name).not.toBeNull();
      expect(e.reason, name).toBe('managed_storage');
      expect(e.detail, name).toContain(expected);
    }
  });

  describe('a real PGLite brain', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    });
    afterAll(async () => { await engine.disconnect(); });
    beforeEach(async () => { await resetPgliteState(engine); });

    test('enabled=true refuses and enabled=false passes', async () => {
      expect(await managedStorageRefusal(engine)).toBeNull();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await managedStorageRefusal(engine))?.reason).toBe('managed_storage');
    });
  });
});
