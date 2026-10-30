import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run a callback with `process.env` mutations applied, then restore the prior
 * values via try/finally. The canonical pattern for env-touching tests in this
 * repo.
 *
 * Why this exists: `process.env` is process-global. Tests that mutate it
 * leak state across files in the same bun test process (the parallel runner
 * loads multiple files into one process per shard). `withEnv` saves the
 * prior value of every key it touches, runs the callback, and restores via
 * try/finally — including when the callback throws.
 *
 * Important caveat: `withEnv` is cross-test-safe but NOT intra-file
 * concurrent-safe. Two `test.concurrent()` calls in the same file both
 * calling withEnv on the same key will race — the global is only one
 * variable. Files that mutate env stay outside the `test.concurrent()`
 * codemod's eligibility filter (the `*.serial.test.ts` quarantine + the
 * codemod's `grep -L "process\.env\."` exclusion handle this).
 *
 * Use:
 *   import { withEnv } from './helpers/with-env.ts';
 *
 *   test('reads OPENAI_API_KEY', async () => {
 *     await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
 *       expect(loadConfig().openai_key).toBe('sk-test');
 *     });
 *   });
 *
 *   // Delete a var (override is undefined):
 *   await withEnv({ GBRAIN_HOME: undefined }, async () => {
 *     expect(process.env.GBRAIN_HOME).toBeUndefined();
 *   });
 *
 *   // Multiple keys:
 *   await withEnv({ A: '1', B: '2', C: undefined }, fn);
 *
 *   // Nested compose: inner restores to outer's value, not original.
 *   await withEnv({ K: 'outer' }, async () => {
 *     await withEnv({ K: 'inner' }, async () => {
 *       expect(process.env.K).toBe('inner');
 *     });
 *     expect(process.env.K).toBe('outer');
 *   });
 */
type EnvFrame = { prior: string | undefined };
const activeFrames = new Map<string, EnvFrame[]>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const frames = Object.keys(overrides).map(key => {
    // Bun keeps the last explicitly set zone when TZ is deleted (bun test pins
    // UTC without setting TZ), so restore an absent TZ as the zone in effect.
    const prior = key === 'TZ' && process.env.TZ === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : process.env[key];
    const frame: EnvFrame = { prior };
    const stack = activeFrames.get(key) ?? [];
    stack.push(frame);
    activeFrames.set(key, stack);
    return [key, stack, frame] as const;
  });
  try {
    for (const [key, value] of Object.entries(overrides)) setEnv(key, value);
    return await fn();
  } finally {
    // Overlapping calls (Promise.all, an un-awaited withEnv) can finish out of
    // order. The last frame restores; an earlier one hands its prior to the
    // frame that captured its override, so the key ends at the value it had
    // before the first call instead of a value one of them set.
    for (const [key, stack, frame] of frames) {
      const at = stack.indexOf(frame);
      if (at === stack.length - 1) setEnv(key, frame.prior);
      else stack[at + 1]!.prior = frame.prior;
      stack.splice(at, 1);
      if (stack.length === 0) activeFrames.delete(key);
    }
  }
}

/**
 * A fresh empty temp dir for `GBRAIN_HOME`, so `loadConfig()` / `configDir()`
 * resolve to a directory with no config.json. Pair with a `withEnv` override
 * (`GBRAIN_HOME: emptyHome()`) on any "no key" assertion: `hasAnthropicKey()`
 * and the Voyage/embedding key probes read BOTH the env var AND the gbrain config
 * file, so clearing only the env var is NOT hermetic on a dev machine whose
 * real `~/.gbrain/config.json` holds a key — the assertion flips and the test
 * fails locally while passing in key-less CI. The dir is tiny and intentionally
 * leaked (test process is short-lived); the OS reaps tmp.
 */
export function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-nokey-home-'));
}
