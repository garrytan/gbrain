// #2674 — pglite_scratch_probe: distinguish a damaged PGLite store from a
// broken WASM runtime.
//
// The load-bearing fact: PGLite reports only `Aborted()` to JS and prints the
// real PANIC (`could not locate a valid checkpoint record …`) to its own
// stderr, so the init-error classifier can never discriminate the two cases
// from the default path. The scratch-store probe is the only thing that can:
// a throwaway store that opens fine proves the runtime is healthy and the
// REAL store is damaged.
//
// Pinned contracts:
//   - COST GATE: the probe never runs on a routine healthy doctor. It runs
//     only when PGLite init actually failed (engine=null + config engine is
//     pglite + not --fast) or on explicit `--probe-pglite`.
//   - Discrimination messaging: scratch-ok + real-init-failed names the STORE
//     (recovery: reinit-pglite / restore backup; markdown unaffected);
//     scratch-fail names the RUNTIME (report OS + Bun on #223).
//   - Cleanup: the scratch temp dir is removed on success AND failure.
//   - Never-touch-the-real-store guard: overlap with the real store path is
//     refused before any PGLite work.
//   - Cross-surface parity: BOTH buildChecks() and doctorReportRemote() emit
//     the check on the PGLite connection-failure path.
//
// NOTE: the buildChecks / doctorReportRemote tests import only symbols that
// exist on master, so on an unmodified master checkout they fail
// BEHAVIORALLY (the check is absent from the emitted list), not via a
// missing export.

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { buildChecks, doctorReportRemote, type Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

const PROBE_TIMEOUT = 90_000; // PGLite cold start is 5–20s on loaded machines

function findCheck(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

function scratchDirsInTmp(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('gbrain-pglite-probe-')));
}

/** GBRAIN_HOME parent dir whose .gbrain/config.json declares a pglite engine. */
function makePgliteHome(): { home: string; storePath: string } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-probe-home-'));
  const dotGbrain = join(home, '.gbrain');
  mkdirSync(dotGbrain, { recursive: true });
  const storePath = join(dotGbrain, 'brain.pglite');
  writeFileSync(
    join(dotGbrain, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: storePath }),
  );
  return { home, storePath };
}

const NO_DB_ENV = { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined };

describe('pglite_scratch_probe — buildChecks gating (#2674)', () => {
  test(
    'PGLite init failure (engine=null, pglite config) → probe runs; healthy runtime blames THE STORE',
    async () => {
      const { home } = makePgliteHome();
      await withEnv({ ...NO_DB_ENV, GBRAIN_HOME: home }, async () => {
        const before = scratchDirsInTmp();
        const checks = await buildChecks(null, ['--scope=brain'], 'config-file-path');
        const check = findCheck(checks, 'pglite_scratch_probe');
        expect(check).toBeDefined();
        // On this (healthy) machine the scratch store works, so the verdict
        // is: runtime fine, YOUR STORE is damaged.
        expect(check!.status).toBe('fail');
        expect(check!.message).toContain('YOUR STORE is damaged');
        expect(check!.message).toContain('reinit-pglite');
        expect(check!.message).toContain('markdown is unaffected');
        expect(check!.message).not.toContain('cannot run');
        // Cleanup: no leaked scratch dirs.
        const after = scratchDirsInTmp();
        for (const d of after) expect(before.has(d)).toBe(true);
      });
    },
    PROBE_TIMEOUT,
  );

  test('cost gate: --fast never pays the probe, even with a failed pglite engine', async () => {
    const { home } = makePgliteHome();
    await withEnv({ ...NO_DB_ENV, GBRAIN_HOME: home }, async () => {
      const checks = await buildChecks(null, ['--fast', '--scope=brain'], 'config-file-path');
      expect(findCheck(checks, 'pglite_scratch_probe')).toBeUndefined();
    });
  });

  test('cost gate: engine=null with a NON-pglite config does not probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-probe-home-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgres://localhost/nope' }),
    );
    await withEnv({ ...NO_DB_ENV, GBRAIN_HOME: home }, async () => {
      const checks = await buildChecks(null, ['--scope=brain'], 'config-file-path');
      expect(findCheck(checks, 'pglite_scratch_probe')).toBeUndefined();
    });
  });

  test(
    'on demand: --probe-pglite with no init failure reports the runtime as healthy (ok)',
    async () => {
      const { home } = makePgliteHome();
      await withEnv({ ...NO_DB_ENV, GBRAIN_HOME: home }, async () => {
        // --fast keeps the walk cheap; the explicit flag still wins.
        const checks = await buildChecks(null, ['--fast', '--probe-pglite', '--scope=brain'], 'config-file-path');
        const check = findCheck(checks, 'pglite_scratch_probe');
        expect(check).toBeDefined();
        expect(check!.status).toBe('ok');
        expect(check!.message).toContain('runtime healthy');
      });
    },
    PROBE_TIMEOUT,
  );
});

describe('pglite_scratch_probe — doctorReportRemote parity (#2674)', () => {
  test(
    'a dead PGLite connection on the remote surface triggers the probe',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-probe-home-'));
      await withEnv({ ...NO_DB_ENV, GBRAIN_HOME: home }, async () => {
        const stub = {
          kind: 'pglite',
          getStats: async () => {
            throw new Error('Aborted(). Build with -sASSERTIONS for more info.');
          },
        } as unknown as BrainEngine;
        const report = await doctorReportRemote(stub);
        const check = findCheck(report.checks, 'pglite_scratch_probe');
        expect(check).toBeDefined();
        expect(check!.status).toBe('fail');
        expect(check!.message).toContain('YOUR STORE is damaged');
      });
    },
    PROBE_TIMEOUT,
  );

  test('a dead POSTGRES connection on the remote surface does not probe', async () => {
    const stub = {
      kind: 'postgres',
      getStats: async () => {
        throw new Error('connection refused');
      },
    } as unknown as BrainEngine;
    const report = await doctorReportRemote(stub);
    expect(findCheck(report.checks, 'pglite_scratch_probe')).toBeUndefined();
  });
});

describe('probePgliteScratchStore — probe internals (#2674)', () => {
  test('never-touch-the-real-store guard refuses overlap and leaks nothing', async () => {
    const { probePgliteScratchStore } = await import('../src/core/pglite-engine.ts');
    const before = scratchDirsInTmp();
    // The scratch dir lives under tmpdir(), so a "real store" AT tmpdir()
    // must trip the overlap guard before any PGLite work happens.
    await expect(probePgliteScratchStore(tmpdir())).rejects.toThrow(/refusing to probe/);
    const after = scratchDirsInTmp();
    for (const d of after) expect(before.has(d)).toBe(true);
  });

  test('verdict routing: probe failure result surfaces classifier verdict + error', async () => {
    // Message routing via the probeFn test seam — no cold start needed.
    const { checkPgliteScratchProbe } = await import('../src/commands/doctor.ts');

    // real init failed + scratch failed too → runtime is broken, ask for OS/Bun.
    const runtimeBroken = await checkPgliteScratchProbe({
      realInitFailed: true,
      probeFn: async () => ({
        ok: false,
        duration_ms: 1234,
        error: 'Aborted(). Build with -sASSERTIONS for more info.',
        verdict: 'unknown' as const,
      }),
    });
    expect(runtimeBroken.status).toBe('fail');
    expect(runtimeBroken.message).toContain('runtime cannot run');
    expect(runtimeBroken.message).toContain('issues/223');
    expect(runtimeBroken.message).toContain('OS and Bun versions');
    expect(runtimeBroken.message).not.toContain('YOUR STORE is damaged');

    // healthy real store + scratch failed → warn, still runtime-facing.
    const scratchOnly = await checkPgliteScratchProbe({
      realInitFailed: false,
      probeFn: async () => ({ ok: false, duration_ms: 10, error: 'boom' }),
    });
    expect(scratchOnly.status).toBe('warn');
    expect(scratchOnly.message).toContain('real store opened');

    // probeFn throwing (e.g. the overlap guard) → warn, not a diagnosis.
    const guardTrip = await checkPgliteScratchProbe({
      realInitFailed: true,
      probeFn: async () => {
        throw new Error('refusing to probe: overlap');
      },
    });
    expect(guardTrip.status).toBe('warn');
    expect(guardTrip.message).toContain('could not run');
  });
});
