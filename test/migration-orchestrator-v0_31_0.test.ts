/**
 * v0.31.2 (B3 ship-blocker fix) — orchestrator gate test.
 *
 * The v0_31_0 orchestrator's phaseASchema is the precondition check
 * `gbrain post-upgrade` runs. It must:
 *   - Reject brains at schema_version < 45 (facts table not yet created).
 *   - Pass brains at schema_version >= 45 with the facts table present.
 *   - Surface a useful operator-facing message that names the version
 *     and the recovery command (`gbrain apply-migrations --yes`).
 *
 * Pre-fix, the gate had been demoted to `v < 40` with a misleading
 * "+ notability" claim. v40 brains passed the precondition without
 * having the facts table, then crashed on the post-condition check
 * three lines later. Restored here to `v < 45` (table-existence
 * precondition); column shape is enforced by migration v46 alone.
 *
 * Lifecycle: one shared PGLite engine (beforeAll, in-memory) replaces the
 * prior fresh-engine-per-test boot. phaseASchema takes the engine argument
 * directly and never calls loadConfig(), so no GBRAIN_HOME / config.json
 * fixture is required; the engine override stays set as the orchestrator-path
 * backstop. resetPgliteState truncates `config`, wiping the `version` stamp
 * initSchema wrote — the DB-backed describe's beforeEach re-stamps it to
 * LATEST_VERSION so each test starts at the post-initSchema state. The two
 * engine-free short-circuit tests run hook-less (no reset).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { __testing, __setTestEngineOverride } from '../src/commands/migrations/v0_31_0.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('v0.31.0 orchestrator — phaseASchema gate', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setTestEngineOverride(engine);
  });

  afterAll(async () => {
    __setTestEngineOverride(null);
    await engine.disconnect();
  });

  describe('DB-backed', () => {
    beforeEach(async () => {
      await resetPgliteState(engine);
      // resetPgliteState truncates `config`; restore the `version` stamp
      // initSchema left (getConfig('version') must read LATEST, not null).
      await engine.setConfig('version', String(LATEST_VERSION));
    });

    test('schema_version < 45 fails with operator-facing message naming v45 + recovery command', async () => {
      // Roll the version backwards to simulate a brain stuck at pre-v45.
      await engine.setConfig('version', '40');

      const result = await __testing.phaseASchema(engine, { yes: true, dryRun: false, noAutopilotInstall: true });

      expect(result.name).toBe('schema');
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('version >= 45');
      expect(result.detail).toContain('apply-migrations');
      // Negative: must NOT mention 'v40' as the gate version (the prior bug).
      expect(result.detail).not.toContain('version >= 40');
      // Negative: must NOT carry the misleading "+ notability" claim from
      // the prior gate text — column shape is enforced by v46, not gated here.
      expect(result.detail).not.toContain('notability');
    });

    test('schema_version >= 45 with facts table present → status complete', async () => {
      // Brain is at LATEST: initSchema (beforeAll) applied every migration —
      // v45 + v46 landed and the facts table exists — and the beforeEach
      // re-stamped `version` to LATEST_VERSION. The prior
      // runMigrationsUpTo(engine, LATEST_VERSION) was a provable no-op after
      // initSchema (current = LATEST → pending = []); deleted.
      const result = await __testing.phaseASchema(engine, { yes: true, dryRun: false, noAutopilotInstall: true });

      expect(result.status).toBe('complete');
      expect(result.detail).toContain('facts table present');
    });
  });

  // Short-circuits return before any DB read — no per-test reset needed.
  describe('engine-free short-circuits', () => {
    test('dryRun short-circuits before any DB read', async () => {
      const result = await __testing.phaseASchema(engine, { yes: true, dryRun: true, noAutopilotInstall: true });

      expect(result.status).toBe('skipped');
      expect(result.detail).toBe('dry-run');
    });

    test('null engine short-circuits with no_brain_configured', async () => {
      const result = await __testing.phaseASchema(null, { yes: true, dryRun: false, noAutopilotInstall: true });

      expect(result.status).toBe('skipped');
      expect(result.detail).toBe('no_brain_configured');
    });
  });
});
