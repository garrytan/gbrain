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

import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { homedir, tmpdir } from 'os';
import {
  __resetGuardrailProvidersForTests,
  hasGuardrails,
  loadGuardrailProvidersFromEnv,
  runGuardrails,
  GuardrailLoadError,
} from '../src/core/guardrails.ts';
import { withEnv } from './helpers/with-env.ts';

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

describe('cwd-relative specs and cwd-.env-assigned specs are refused', () => {
  /** Fixture whose TOP LEVEL drops a marker — proves the module was never imported. */
  function markerFixture(): { path: string; marker: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-relspec-'));
    dirs.push(dir);
    const marker = join(dir, 'PROBE_RAN');
    const path = join(dir, 'probe.mjs');
    writeFileSync(path, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`);
    return { path, marker, dir };
  }

  test('a cwd-relative spec (./, ../, bare .) throws GuardrailLoadError WITHOUT importing', async () => {
    const { marker } = markerFixture();
    for (const spec of ['./probe.mjs', '../probe.mjs', '.']) {
      const err = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: spec }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GuardrailLoadError);
      expect((err as Error).message).toContain('absolute');
    }
    expect(existsSync(marker)).toBe(false);
    expect(hasGuardrails()).toBe(false);
  });

  test('an absolute spec that a cwd .env file assigns is refused (opts.cwd)', async () => {
    const { path, marker, dir } = markerFixture();
    writeFileSync(join(dir, '.env'), 'GBRAIN_GUARDRAILS_MODULE=${PWD}/probe.mjs\n');
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: path }, { cwd: dir }),
    ).rejects.toBeInstanceOf(GuardrailLoadError);
    expect(existsSync(marker)).toBe(false);
    // Same spec, a cwd WITHOUT a .env assigning the key → loads normally.
    const clean = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-clean-cwd-'));
    dirs.push(clean);
    await expect(
      loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: path }, { cwd: clean }),
    ).rejects.toBeInstanceOf(GuardrailLoadError); // imported (marker) but registers nothing
    expect(existsSync(marker)).toBe(true);
  });

  test('process.env path: the cwd check applies when env is process.env', async () => {
    const { path, marker, dir } = markerFixture();
    writeFileSync(join(dir, '.env'), 'GBRAIN_GUARDRAILS_MODULE=./probe.mjs\n');
    await withEnv({ GBRAIN_GUARDRAILS_MODULE: path }, async () => {
      await expect(loadGuardrailProvidersFromEnv(process.env, { cwd: dir })).rejects.toBeInstanceOf(GuardrailLoadError);
    });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('bare package specifiers are refused (A3)', () => {
  /**
   * In the compiled binary a bare specifier resolves through Bun's module
   * walk-up FROM THE CWD, so a hostile checkout's node_modules/<name>/ is what
   * gets loaded. Only absolute and `~/` paths name a module the operator chose.
   */
  function cwdWithPackage(name: string): { dir: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-barespec-'));
    dirs.push(dir);
    const marker = join(dir, 'PROBE_RAN');
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(
      join(pkgDir, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nmodule.exports = { id: 'fixture-bare', classify() {} };\n`,
    );
    return { dir, marker };
  }

  test('a bare name, a scoped name and a subpath all throw GuardrailLoadError BEFORE any import', async () => {
    for (const spec of ['gbrain-fixture-guardrail', '@fixture-scope/guardrail', 'gbrain-fixture-guardrail/register']) {
      const { dir, marker } = cwdWithPackage(spec.startsWith('@') ? spec : spec.split('/')[0]!);
      const err = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: spec }, { cwd: dir }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GuardrailLoadError);
      expect((err as Error).message).toContain('must be an absolute path or a ~/ path');
      expect((err as Error).message).toContain("node_modules");
      expect(existsSync(marker)).toBe(false);
    }
    expect(hasGuardrails()).toBe(false);
  });

  test('the relative-spec message no longer advertises package names', async () => {
    const err = await loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: './x.mjs' }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).not.toContain('package name');
  });
});

describe('zero-arg library call: env defaults to process.env, cwd to process.cwd() (A8)', () => {
  test('loadGuardrailProvidersFromEnv() refuses a spec that the cwd .env assigns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-guardrails-zeroarg-'));
    dirs.push(dir);
    const marker = join(dir, 'PROBE_RAN');
    const path = join(dir, 'probe.mjs');
    writeFileSync(path, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`);
    writeFileSync(join(dir, '.env'), 'GBRAIN_GUARDRAILS_MODULE=${PWD}/probe.mjs\n');
    // Never process.chdir() in a shared test process — mock the cwd read instead.
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await withEnv({ GBRAIN_GUARDRAILS_MODULE: path }, async () => {
        const err = await loadGuardrailProvidersFromEnv().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(GuardrailLoadError);
        expect((err as Error).message).toContain('assigned by a .env file in the current directory');
      });
    } finally {
      cwdSpy.mockRestore();
    }
    expect(existsSync(marker)).toBe(false);
    expect(hasGuardrails()).toBe(false);
  });
});

// The `~/` branch now goes through STATIC node:path / node:url / node:os
// imports (the runtime dynamic imports were removed alongside the origin
// checks). Pin that a `~/` spec still expands against the home dir and is
// imported. Bun caches os.homedir() at first call, so a HOME override cannot
// drive this: the probe is written into a cleaned-up temp dir under the REAL
// home (skipped when that home is not writable, e.g. a read-only CI HOME).
// Computed ONCE at module scope so the skip decision is visible in the report
// instead of a silent early return inside the test body.
const canWriteHome = (() => {
  try {
    const probe = mkdtempSync(join(homedir(), '.gbrain-guardrails-tilde-probe-'));
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe('~/ specs expand against the home directory', () => {
  test.skipIf(!canWriteHome)('a ~/ spec resolves under homedir() and is imported (then fail-closed on zero providers)', async () => {
    const home = mkdtempSync(join(homedir(), '.gbrain-guardrails-tilde-'));
    try {
      const marker = join(home, 'PROBE_RAN');
      writeFileSync(
        join(home, 'probe.mjs'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default undefined;\n`,
      );
      const spec = '~/' + relative(homedir(), join(home, 'probe.mjs'));
      await expect(loadGuardrailProvidersFromEnv({ GBRAIN_GUARDRAILS_MODULE: spec }))
        .rejects.toBeInstanceOf(GuardrailLoadError);
      expect(existsSync(marker)).toBe(true); // expanded + imported; the rejection is the zero-provider rule
      expect(hasGuardrails()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
