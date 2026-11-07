import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { exportDatabaseContent } from '../src/core/shared-skills/migration-export.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

/*
 * Value: a failed bind can resume an unchanged, unbound DB export at a new root.
 * Regression: the retry currently refuses every root change, even when the old
 * export is intact and the source has no binding.
 * Existing coverage checks same-root interruption and edits, not recovery at a
 * different root. This uses the real export path and needs no production seam.
 */
let base: string;
let engine: BrainEngine;
let closeEngine: (() => Promise<void>) | undefined;

beforeAll(async () => {
  await withEnv({ TMPDIR: undefined, TMP: undefined, TEMP: undefined }, async () => {
    base = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-export-root-retry-'));
    await withEnv({ GBRAIN_HOME: base, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      engine = isolated.engine;
      closeEngine = isolated.close;
    });
  });
});

afterAll(async () => {
  await closeEngine?.();
  rmSync(base, { recursive: true, force: true });
});

test('an unbound, verified export checkpoint can continue at a new root', async () => {
  await withEnv({ TMPDIR: undefined, TMP: undefined, TEMP: undefined, GBRAIN_HOME: base, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const originalRoot = join(base, 'initial-content'), retryRoot = join(base, 'private-content');
    const options = { sourceId: 'default', root: originalRoot, confirmQuiesced: true, backup: 'operator_verified' as const };
    const setConfig = engine.setConfig.bind(engine);
    let interrupted = false;
    engine.setConfig = async (key, value) => {
      if (!interrupted && key.startsWith('shared_skills.export.') && JSON.parse(value).stage === 'exported') {
        interrupted = true;
        throw new Error('simulated interruption before source binding');
      }
      return setConfig(key, value);
    };
    try {
      await expect(exportDatabaseContent(ctx, options)).rejects.toThrow('simulated interruption before source binding');
    } finally {
      engine.setConfig = setConfig;
    }

    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const checkpoint = JSON.parse((await engine.getConfig(`shared_skills.export.v1.default.${incarnation}`))!) as { stage: string; status: string };
    expect(checkpoint).toMatchObject({ stage: 'exported', status: 'action_required' });
    expect(existsSync(originalRoot)).toBe(true);

    let outcome: { kind: 'returned'; result: { status: string; root: string } } | { kind: 'threw'; error: { code?: unknown; message: string } };
    try {
      const result = await exportDatabaseContent(ctx, { ...options, root: retryRoot });
      outcome = { kind: 'returned', result };
    } catch (error) {
      outcome = { kind: 'threw', error: { code: (error as { code?: unknown }).code, message: String(error) } };
    }

    expect(outcome).toMatchObject({ kind: 'returned', result: { status: 'complete', root: retryRoot } });
    expect(existsSync(originalRoot)).toBe(true);
    expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBe(retryRoot);
  });
}, 120_000);
