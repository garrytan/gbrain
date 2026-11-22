/**
 * BrainEngine parity — turning managed mode on (persistence/activation.ts `activatePersistence`, skill-activation.ts
 * `activateSharedSkillPersistence`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite and Postgres, activation of a fresh brain turns managed mode on (`persistence_brain.enabled`).
 *    The Rust engine refuses both activations with `engine_capability_missing` (raw_sql, the capability a managed
 *    brain would need) before it reads or writes anything, so managed mode stays off: a managed brain's import, sources add and extract still run raw SQL
 *    there, which the Rust store refuses.
 *  - Regression: the Rust engine turned managed mode on (activation ran to the end), after which import refused all 28
 *    files of a corpus, sources add refused and extract all failed: a brain left half managed.
 *  - Why existing coverage misses it: no parity case activates managed mode; the bound-write cases claim a checkout only.
 *  - Seam: none. Real engines; the Rust arm's refusal is checked here (enabled still false) and then rethrown, so the
 *    harness counts it as the typed stop it is.
 */
import { describe, expect } from 'bun:test';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { readManagedModeTyped } from '../../src/core/persistence/managed-mode.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const refusal = (e: unknown) => ({ code: (e as { code?: unknown }).code, reason: (e as { reason?: unknown }).reason, detail: String((e as { detail?: unknown }).detail ?? '') });

describe('engine parity: turning managed mode on', () => {
  parityTest('activatePersistence turns managed mode on, or refuses by name and leaves it off', {
    methods: ['readManagedModeRows'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const before = await readManagedModeTyped(engine);
    expect(before).toBe(false);
    try {
      await activatePersistence(engine, { confirmQuiesced: true });
    } catch (e) {
      if (backend !== 'rust') throw e;
      expect(refusal(e)).toEqual({ code: 'engine_capability_missing', reason: 'raw_sql', detail: expect.stringContaining('member=activatePersistence') });
      expect(refusal(e).detail).toContain('written=nothing');
      expect(await readManagedModeTyped(engine)).toBe(false);
      throw e;
    }
    expect(backend).not.toBe('rust');
    return { before, after: await readManagedModeTyped(engine) };
  });

  parityTest('activateSharedSkillPersistence refuses by name on an engine that cannot run a managed brain, before it reads anything', {
    methods: ['readManagedModeRows'], requires: 'raw_sql',
  }, async (engine, backend) => {
    let outcome: unknown;
    try {
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      outcome = 'activated';
    } catch (e) {
      if (backend === 'rust') {
        expect(refusal(e)).toEqual({ code: 'engine_capability_missing', reason: 'raw_sql', detail: expect.stringContaining('member=activateSharedSkillPersistence') });
        expect(await readManagedModeTyped(engine)).toBe(false);
        throw e;
      }
      // A fresh brain has no claimed source root, so the SQL engines refuse the shared-skill activation for that.
      outcome = (e as { code?: unknown }).code;
    }
    expect(await readManagedModeTyped(engine)).toBe(false);
    return { outcome };
  });
});
