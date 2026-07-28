// v0.41.2.1 — embedding_env_override doctor check (D9 #9).
//
// Pinned contracts:
//   - env unset → ok
//   - env+DB agree → ok
//   - env model OR dim disagrees → warn with `details.mismatches[]`
//   - getConfig throws → warn with "couldn't read DB config" message
//   - Cross-surface parity: BOTH buildChecks() and doctorReportRemote()
//     include the check (source-grep regression guard)
//
// Serial: isolates PGLite and temporarily redirects PMBRAIN_HOME.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, doctorReportRemote, type Check } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { configPath, saveConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
let configHome: string;
let originalPmbrainHome: string | undefined;
let originalGbrainHome: string | undefined;

beforeAll(async () => {
  originalPmbrainHome = process.env.PMBRAIN_HOME;
  originalGbrainHome = process.env.GBRAIN_HOME;
  configHome = mkdtempSync(join(tmpdir(), 'pmbrain-doctor-env-'));
  process.env.PMBRAIN_HOME = configHome;
  delete process.env.GBRAIN_HOME;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  if (originalPmbrainHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalPmbrainHome;
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  rmSync(configPath(), { force: true });
});

function findCheck(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

describe('embedding_env_override check (buildChecks seam)', () => {
  test('env unset → ok', async () => {
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check).toBeDefined();
        expect(check!.status).toBe('ok');
        expect(check!.message).toContain('no embedding env overrides set');
      },
    );
  });

  test('env+legacy DB agree → ok when no canonical file exists', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      {
        GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
        GBRAIN_EMBEDDING_DIMENSIONS: '1280',
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('ok');
        expect(check!.message).toContain('agree with database config');
      },
    );
  });

  test('env model disagrees with DB → warn with details.mismatches', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large' },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string; env: string; db: string }> };
        expect(details.mismatches).toHaveLength(1);
        expect(details.mismatches[0].key).toBe('GBRAIN_EMBEDDING_MODEL');
        expect(details.mismatches[0].env).toBe('openai:text-embedding-3-large');
        expect(details.mismatches[0].db).toBe('zeroentropyai:zembed-1');
        // Message includes paste-ready unset
        expect(check!.message).toContain('unset GBRAIN_EMBEDDING_MODEL');
      },
    );
  });

  test('env dim disagrees with DB → warn with details.mismatches', async () => {
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      { GBRAIN_EMBEDDING_DIMENSIONS: '1536' },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string; env: string; db: string }> };
        expect(details.mismatches).toHaveLength(1);
        expect(details.mismatches[0].key).toBe('GBRAIN_EMBEDDING_DIMENSIONS');
      },
    );
  });

  test('both disagree → 2 mismatches', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1280');
    await withEnv(
      {
        GBRAIN_EMBEDDING_MODEL: 'openai:x',
        GBRAIN_EMBEDDING_DIMENSIONS: '1536',
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        const details = check!.details as { mismatches: Array<{ key: string }> };
        expect(details.mismatches).toHaveLength(2);
        expect(check!.message).toContain('unset GBRAIN_EMBEDDING_MODEL GBRAIN_EMBEDDING_DIMENSIONS');
      },
    );
  });

  test('PMBRAIN aliases are compared with canonical file config, not stale DB rows', async () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
    });
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('embedding_dimensions', '1280');

    await withEnv(
      {
        PMBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
        PMBRAIN_EMBEDDING_DIMENSIONS: '1280',
        GBRAIN_EMBEDDING_MODEL: undefined,
        GBRAIN_EMBEDDING_DIMENSIONS: undefined,
      },
      async () => {
        const checks = await buildChecks(engine, []);
        const check = findCheck(checks, 'embedding_env_override');
        expect(check!.status).toBe('warn');
        expect(check!.message).toContain('config-file config');
        const details = check!.details as {
          config_source: string;
          mismatches: Array<{ key: string; configured: string }>;
        };
        expect(details.config_source).toBe('config-file');
        expect(details.mismatches).toEqual([
          expect.objectContaining({
            key: 'PMBRAIN_EMBEDDING_MODEL',
            configured: 'ollama:qwen3-embedding:0.6b',
          }),
          expect.objectContaining({
            key: 'PMBRAIN_EMBEDDING_DIMENSIONS',
            configured: '1024',
          }),
        ]);
      },
    );
  });

  test('doctorReportRemote() includes the check (cross-surface parity)', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:something' }, async () => {
      await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
      const report = await doctorReportRemote(engine);
      const check = findCheck(report.checks, 'embedding_env_override');
      expect(check).toBeDefined();
      expect(check!.status).toBe('warn');
    });
  });
});

describe('cross-surface parity (source-grep regression guard)', () => {
  test('doctor.ts wires checkEmbeddingEnvOverride into BOTH buildChecks and doctorReportRemote', () => {
    // Static regression assertion: the helper must be called from BOTH surfaces.
    // If a future maintainer removes the call from one surface, this test fails
    // pointing at the asymmetry.
    const src = readFileSync(
      join(import.meta.dir, '../src/commands/doctor.ts'),
      'utf-8',
    );
    // The helper is called as `await checkEmbeddingEnvOverride(engine)`
    const matches = src.match(/await checkEmbeddingEnvOverride\(engine\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
