/**
 * #3688 — GBRAIN_GUARDRAILS_MODULE operator wiring.
 *
 * Before this fix, registerGuardrailProvider existed only in-module + docs:
 * the package exports map lacked './core/guardrails' and nothing in cli.ts
 * ever loaded a provider, so runGuardrails no-op'd forever (providers.size
 * === 0) — the documented firewall was unreachable. Covers:
 *   - unset env → no-op, stays inert
 *   - default-export provider, provider array, guardrailProviders, register()
 *   - fail-CLOSED: unloadable module throws GuardrailLoadError
 *   - fail-CLOSED: module that registers nothing throws GuardrailLoadError
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  __resetGuardrailProvidersForTests,
  hasGuardrails,
  loadGuardrailProvidersFromEnv,
  runGuardrails,
  GuardrailLoadError,
} from '../src/core/guardrails.ts';

// One fresh mkdtemp per fixture: bun caches a directory's listing after the
// first dynamic import from it, so a second module written into the SAME dir
// resolves as "Cannot find module" mid-run.
const dirs: string[] = [];

afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => __resetGuardrailProvidersForTests());

/** Write a fixture module into its own temp dir; returns the absolute path. */
function fixture(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-3688-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, source);
  return p;
}

describe('loadGuardrailProvidersFromEnv (#3688)', () => {
  test('unset env var → no-op, distribution stays inert', async () => {
    const out = await loadGuardrailProvidersFromEnv({});
    expect(out.loaded).toBe(0);
    expect(out.modulePath).toBeNull();
    expect(hasGuardrails()).toBe(false);
  });

  test('default-exported provider registers and receives classify calls', async () => {
    const p = fixture('default-provider.mjs', `
      globalThis.__gr3688_calls = [];
      export default {
        id: 'fixture-default',
        classify(input) { globalThis.__gr3688_calls.push(input); },
      };
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
    await runGuardrails({ hook: 'file_storage.markdown', content: 'hello world' });
    const calls = (globalThis as Record<string, unknown>).__gr3688_calls as Array<{ hook: string; content: string }>;
    expect(calls.length).toBe(1);
    expect(calls[0].hook).toBe('file_storage.markdown');
    expect(calls[0].content).toBe('hello world');
  });

  test('default-exported provider ARRAY registers every provider', async () => {
    const p = fixture('array-provider.mjs', `
      export default [
        { id: 'fixture-a', classify() {} },
        { id: 'fixture-b', classify() {} },
      ];
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(2);
  });

  test('named guardrailProviders array registers', async () => {
    const p = fixture('named-providers.mjs', `
      export const guardrailProviders = [{ id: 'fixture-named', classify() {} }];
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
  });

  test('register(fn) callback shape registers (async supported)', async () => {
    const p = fixture('register-fn.mjs', `
      export async function register(registerGuardrailProvider) {
        registerGuardrailProvider({ id: 'fixture-register', classify() {} });
      }
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
  });

  test('fail-closed: unloadable module throws GuardrailLoadError', async () => {
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: join(tmpdir(), 'gbrain-3688-does-not-exist.mjs') }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(hasGuardrails()).toBe(false);
  });

  test('fail-closed: module that registers nothing throws GuardrailLoadError', async () => {
    const p = fixture('empty-module.mjs', `export const unrelated = 42;`);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(hasGuardrails()).toBe(false);
  });

  test('fail-closed: default export that is not a valid provider throws', async () => {
    const p = fixture('bad-shape.mjs', `export default { id: 'no-classify' };`);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
  });
});

describe('#3688 residual — top-level side-effect registration counts', () => {
  test('a module that registers at import time is accepted, not rejected as zero-provider', async () => {
    const guardrailsUrl = new URL('../src/core/guardrails.ts', import.meta.url).href;
    const p = fixture('side-effect-provider.mjs', `
      import { registerGuardrailProvider } from '${guardrailsUrl}';
      registerGuardrailProvider({ id: 'fixture-side-effect', classify() {} });
      export default undefined;
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
  });

  test('a same-id REPLACEMENT counts as a registration, not zero', async () => {
    const guardrailsUrl = new URL('../src/core/guardrails.ts', import.meta.url).href;
    // Pre-register the id, then load a module that replaces it: providers.size
    // stays constant, so a size-delta count would misread the load as empty.
    const { registerGuardrailProvider } = await import('../src/core/guardrails.ts');
    registerGuardrailProvider({ id: 'fixture-replace', classify() {} });
    const p = fixture('replace-provider.mjs', `
      export default { id: 'fixture-replace', classify() {} };
    `);
    const out = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: p });
    expect(out.loaded).toBe(1);
    expect(hasGuardrails()).toBe(true);
  });
});
