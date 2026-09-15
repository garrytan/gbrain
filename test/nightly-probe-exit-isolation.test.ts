import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(script: string) {
  const home = mkdtempSync(join(tmpdir(), 'probe-exit-home-'));
  try {
    return spawnSync(process.execPath, ['-e', script], {
      cwd: join(import.meta.dir, '..'),
      encoding: 'utf-8',
      timeout: 90_000,
      env: { ...process.env, GBRAIN_HOME: home, GBRAIN_MODEL: '', GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('embedded nightly probe failures (#5095)', () => {
  test('missing chat configuration is audited before embedding work and rate-limited', () => {
    const child = run(`
      import { configureGateway } from './src/core/ai/gateway.ts';
      import { runLongMemEvalForProbe } from './src/core/cycle/nightly-probe-adapters.ts';
      import { runNightlyQualityProbe } from './src/core/cycle/nightly-quality-probe.ts';
      configureGateway({ env: {} });
      const deps = {
        isEnabled: () => true,
        hasEmbeddingProvider: () => true,
        resolveMaxUsd: () => 0,
        resolveRepoRoot: () => process.cwd(),
        runLongMemEval: runLongMemEvalForProbe,
        runCrossModalBatch: async () => { throw new Error('judge must not run'); },
        now: () => new Date(),
      };
      console.log(JSON.stringify(await runNightlyQualityProbe(deps)));
      console.log(JSON.stringify(await runNightlyQualityProbe(deps)));
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('"outcome":"error"');
    expect(child.stdout).toContain('"outcome":"rate_limited"');
    expect(child.stdout).toContain('chat provider not configured');
    expect(child.stderr).not.toContain('connecting in-memory brain');
  }, 90_000);

  test('the real adapter rejects an invalid fixture without exiting its host', () => {
    const child = run(`
      import { runLongMemEvalForProbe } from './src/core/cycle/nightly-probe-adapters.ts';
      try {
        await runLongMemEvalForProbe({ fixturePath: '/nonexistent-nightly-fixture.jsonl', outputPath: '/unused.jsonl' });
      } catch (error) {
        console.log('HOST_SURVIVED', String(error));
      }
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('HOST_SURVIVED');
  }, 90_000);

  test('an all-error embedded evaluation rejects instead of terminating the host', () => {
    const child = run(`
      import { runEvalLongMemEval } from './src/commands/eval-longmemeval.ts';
      try {
        await runEvalLongMemEval([
          './test/fixtures/longmemeval-mini.jsonl', '--keyword-only', '--no-trajectory', '--limit', '2'
        ], {
          exitOnError: false,
          client: { create: async () => { throw new Error('synthetic provider unavailable'); } }
        });
      } catch (error) {
        console.log('HOST_SURVIVED', String(error));
      }
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toContain('FAIL every question errored (2/2)');
    expect(child.stderr).toContain('synthetic provider unavailable');
    expect(child.stdout).toContain('HOST_SURVIVED');
  }, 90_000);
});
