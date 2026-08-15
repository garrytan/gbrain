/**
 * v0.36.0.0 (T3) — `gbrain ze-switch` CLI tests.
 *
 * Pins:
 *  - --dry-run prints a plan, applies nothing
 *  - --non-interactive without key exits 1 (unless --ignore-missing-key)
 *  - --non-interactive --ignore-missing-key applies + exits 0
 *  - --json envelope shape: {status: ..., plan: {...}}
 *  - --resume completes a half-applied switch
 *  - --undo without snapshot exits 1
 *  - --help exits 0 without touching the engine
 *
 * Engine lifecycle: each test creates + disconnects its own PGLite engine
 * to keep process.exit() semantics clean. The CLI calls process.exit at
 * the end of every path; we intercept via a stub.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runZeSwitch } from '../src/commands/ze-switch.ts';
import {
  KEY_APPLIED,
  KEY_REQUESTED,
  KEY_PREVIOUS_SNAPSHOT,
  ZE_TARGET_EMBEDDING_DIM,
} from '../src/core/retrieval-upgrade-planner.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Helpers: capture stdout/stderr/exitCode without actually exiting.
function captureExit<T>(fn: () => Promise<T>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const origExit = process.exit;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error('__captured_exit__');
    }) as any;
    process.stdout.write = ((chunk: any) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as any;
    console.log = (...args: any[]) => { stdout += args.join(' ') + '\n'; };
    console.error = (...args: any[]) => { stderr += args.join(' ') + '\n'; };
    try {
      await fn();
    } catch (e: any) {
      if (e?.message !== '__captured_exit__') {
        stderr += `Unexpected: ${e?.message ?? String(e)}\n`;
        exitCode = exitCode || 1;
      }
    } finally {
      process.exit = origExit;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origConsoleLog;
      console.error = origConsoleError;
      resolve({ exitCode, stdout, stderr });
    }
  });
}

async function seedPages(n: number) {
  for (let i = 0; i < n; i++) {
    await engine.putPage(`seed/page-${i}`, {
      title: `Seed ${i}`,
      compiled_truth: `Body text ${i} with enough chars to flow through cost math.`,
      timeline: '',
      type: 'note',
    });
  }
}

async function setLegacyConfig() {
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
}

describe('--help', () => {
  test('exits 0 with usage text', async () => {
    const r = await captureExit(() => runZeSwitch(['--help'], engine));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('gbrain ze-switch');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--undo');
  });
});

describe('--dry-run', () => {
  test('human output prints plan, changes nothing', async () => {
    await setLegacyConfig();
    await seedPages(150);

    const r = await captureExit(() => runZeSwitch(['--dry-run'], engine));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Current model');
    expect(r.stdout).toContain('Target model');
    // Nothing changed:
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
  });

  test('--json output emits a planned envelope', async () => {
    await setLegacyConfig();
    await seedPages(150);

    const r = await captureExit(() => runZeSwitch(['--dry-run', '--json'], engine));
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('planned');
    expect(env.plan).toBeDefined();
    expect(env.plan.target_embedding_model).toBe('zeroentropyai:zembed-1');
    expect(env.plan.target_dim).toBe(ZE_TARGET_EMBEDDING_DIM);
  });
});

describe('--non-interactive', () => {
  test('without ZE key + without --ignore-missing-key: exits 1', async () => {
    await setLegacyConfig();
    await seedPages(150);

    // Clear the env var so the test runs the no-key path even when the
    // contributor has ZEROENTROPY_API_KEY set in their shell.
    await withEnv({ ZEROENTROPY_API_KEY: undefined }, async () => {
      const r = await captureExit(() => runZeSwitch(['--non-interactive'], engine));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('ZEROENTROPY_API_KEY');
    });
  });

  test('without ZE key + with --ignore-missing-key: applies, exits 0', async () => {
    await setLegacyConfig();
    await seedPages(150);

    const r = await captureExit(() =>
      runZeSwitch(['--non-interactive', '--ignore-missing-key'], engine),
    );
    expect(r.exitCode).toBe(0);
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
    expect(await engine.getConfig('embedding_model')).toBe('zeroentropyai:zembed-1');
    expect(await engine.getConfig('embedding_dimensions')).toBe(String(ZE_TARGET_EMBEDDING_DIM));
  });

  test('with env ZE key set: applies', async () => {
    await setLegacyConfig();
    await seedPages(150);
    await withEnv({ ZEROENTROPY_API_KEY: 'sk-fake' }, async () => {
      const r = await captureExit(() => runZeSwitch(['--non-interactive'], engine));
      expect(r.exitCode).toBe(0);
      expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
    });
  });

  test('--json + --non-interactive: emits {status: "applied"}', async () => {
    await setLegacyConfig();
    await seedPages(150);
    const r = await captureExit(() =>
      runZeSwitch(['--non-interactive', '--ignore-missing-key', '--json'], engine),
    );
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('applied');
  });
});

describe('--resume', () => {
  test('completes a half-applied switch', async () => {
    await setLegacyConfig();
    await seedPages(150);
    // Simulate crash partway: requested but not applied.
    await engine.setConfig(KEY_REQUESTED, 'true');

    const r = await captureExit(() => runZeSwitch(['--resume'], engine));
    expect(r.exitCode).toBe(0);
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');
    expect(await engine.getConfig('embedding_model')).toBe('zeroentropyai:zembed-1');
  });
});

describe('--undo', () => {
  test('without snapshot exits 1', async () => {
    const r = await captureExit(() =>
      runZeSwitch(['--undo', '--non-interactive', '--confirm-reembed'], engine),
    );
    expect(r.exitCode).toBe(1);
  });

  test('--non-interactive without --confirm-reembed exits 1', async () => {
    const r = await captureExit(() => runZeSwitch(['--undo', '--non-interactive'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('confirm-reembed');
  });

  test('with snapshot + --confirm-reembed: reverses the switch', async () => {
    // Set up: apply switch, then undo.
    await setLegacyConfig();
    await seedPages(150);
    await captureExit(() =>
      runZeSwitch(['--non-interactive', '--ignore-missing-key'], engine),
    );
    expect(await engine.getConfig(KEY_APPLIED)).toBe('true');

    const r = await captureExit(() =>
      runZeSwitch(['--undo', '--non-interactive', '--confirm-reembed'], engine),
    );
    expect(r.exitCode).toBe(0);
    // Reverted to prior model.
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
  });
});
