/**
 * v0.46.3 — `gbrain ze-switch` CLI tests (post-sunset-refusal contract).
 *
 * ZeroEntropy shuts down 2026-09-04, so switching a brain ONTO it is
 * disabled. Pins:
 *  - forward switch (bare / --non-interactive / --force) REFUSES, exit 1,
 *    with the migrate-embeddings escape route in the message
 *  - --resume ALSO refuses (resuming a half-applied forward switch would
 *    strand the brain on the dying provider)
 *  - --json refusal envelope: {status: 'refused', reason: 'provider_sunset'}
 *  - --dry-run still prints a read-only plan, changes nothing
 *  - --undo still works (it moves brains OFF the provider) — snapshot seeded
 *    directly since the forward path can no longer create one
 *  - --help exits 0 without touching the engine
 *
 * Engine lifecycle: one PGLite engine, state reset per test; process.exit is
 * intercepted via a stub.
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

/** Seed the state a pre-v0.46.3 forward switch would have left behind, so the
 *  --undo path (which must survive until the September removal) is testable
 *  without the now-refused forward path. Mirrors applyRetrievalUpgrade's
 *  snapshot + config writes (retrieval-upgrade-planner.ts). */
async function seedAppliedSwitch() {
  await engine.setConfig(
    KEY_PREVIOUS_SNAPSHOT,
    JSON.stringify({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      search_reranker_enabled: false,
      search_reranker_model: null,
    }),
  );
  await engine.setConfig(KEY_REQUESTED, 'true');
  await engine.setConfig(KEY_APPLIED, 'true');
  await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
  await engine.setConfig('embedding_dimensions', String(ZE_TARGET_EMBEDDING_DIM));
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

describe('--dry-run (read-only, still allowed)', () => {
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
});

describe('forward switch — REFUSED (provider sunset)', () => {
  test('--non-interactive refuses with exit 1 and the escape route', async () => {
    await setLegacyConfig();
    await seedPages(150);
    await withEnv({ ZEROENTROPY_API_KEY: 'sk-fake' }, async () => {
      const r = await captureExit(() => runZeSwitch(['--non-interactive'], engine));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('2026-09-04');
      expect(r.stderr).toContain('gbrain migrate embeddings --to voyage:voyage-4');
      // Nothing was applied:
      expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
      expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    });
  });

  test('--ignore-missing-key does not bypass the refusal', async () => {
    await setLegacyConfig();
    await seedPages(150);
    const r = await captureExit(() =>
      runZeSwitch(['--non-interactive', '--ignore-missing-key'], engine),
    );
    expect(r.exitCode).toBe(1);
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
  });

  test('--force does not bypass the refusal either', async () => {
    await setLegacyConfig();
    const r = await captureExit(() => runZeSwitch(['--force'], engine));
    expect(r.exitCode).toBe(1);
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
  });

  test('--json refusal envelope carries reason provider_sunset', async () => {
    await setLegacyConfig();
    const r = await captureExit(() =>
      runZeSwitch(['--non-interactive', '--ignore-missing-key', '--json'], engine),
    );
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('refused');
    expect(env.reason).toBe('provider_sunset');
  });

  test('--resume of a half-applied forward switch ALSO refuses', async () => {
    await setLegacyConfig();
    await seedPages(150);
    // Simulate crash partway: requested but not applied.
    await engine.setConfig(KEY_REQUESTED, 'true');

    const r = await captureExit(() => runZeSwitch(['--resume'], engine));
    expect(r.exitCode).toBe(1);
    expect(r.stderr + r.stdout).toContain('migrate embeddings');
    // Still not applied — resuming onto a dying provider is the harm the
    // refusal exists to prevent.
    expect(await engine.getConfig(KEY_APPLIED)).toBeNull();
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
  });
});

describe('--undo (moves brains OFF the provider — still works)', () => {
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
    await seedPages(150);
    await seedAppliedSwitch();
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

describe('--dry-run --json (read-only plan still allowed until removal)', () => {
  test('emits the planned envelope with the ZE target', async () => {
    await setLegacyConfig();
    await seedPages(150);
    const r = await captureExit(() => runZeSwitch(['--dry-run', '--json'], engine));
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe('planned');
    expect(env.plan).toBeDefined();
    expect(env.plan.target_dim).toBe(ZE_TARGET_EMBEDDING_DIM);
  });
});
