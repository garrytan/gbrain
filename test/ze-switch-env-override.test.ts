// v0.41.2.1 — ze-switch env-override safety gate (D3 + D9 #6, #7, #8).
//
// Pinned contracts:
//   - detectEnvOverride pure function (no env mutation; tests pass env arg)
//   - formatEnvOverrideWarning produces ASCII-only box ≤78 cols
//   - applyRetrievalUpgrade gate fires FIRST (NO setConfig calls when refused)
//   - resumeRetrievalUpgrade gate fires FIRST (refused too, no schema mutation)
//   - --ignore-env-override escape hatch bypasses both gates
//   - ApplyResult tagged union extends with {status:'refused', reason, warning}
//
// Hermetic: PGLite + withEnv() per CLAUDE.md R1/R3/R4. No DATABASE_URL needed.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  detectEnvOverride,
  formatEnvOverrideWarning,
  applyRetrievalUpgrade,
  resumeRetrievalUpgrade,
  planRetrievalUpgrade,
  KEY_REQUESTED,
  KEY_APPLIED,
  KEY_PREVIOUS_SNAPSHOT,
  ZE_TARGET_EMBEDDING_MODEL,
  ZE_TARGET_EMBEDDING_DIM,
} from '../src/core/retrieval-upgrade-planner.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ─── detectEnvOverride: pure function tests (no env mutation needed) ────

describe('detectEnvOverride (pure)', () => {
  test('triggered:false when env unset', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {});
    expect(w.triggered).toBe(false);
    expect(w.vars).toEqual([]);
  });

  test('triggered:false when env matches target exactly', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
      GBRAIN_EMBEDDING_DIMENSIONS: '1280',
    });
    expect(w.triggered).toBe(false);
  });

  test('triggered:true on GBRAIN_EMBEDDING_MODEL mismatch (1 var)', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
    });
    expect(w.triggered).toBe(true);
    expect(w.vars).toHaveLength(1);
    expect(w.vars[0].name).toBe('GBRAIN_EMBEDDING_MODEL');
    expect(w.vars[0].current).toBe('openai:text-embedding-3-large');
    expect(w.vars[0].target).toBe('zeroentropyai:zembed-1');
  });

  test('GBRAIN_EMBEDDING_DIMENSIONS string-vs-number comparison works', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_DIMENSIONS: '1536',
    });
    expect(w.triggered).toBe(true);
    expect(w.vars[0].name).toBe('GBRAIN_EMBEDDING_DIMENSIONS');
    expect(w.vars[0].current).toBe('1536');
    expect(w.vars[0].target).toBe('1280');
  });

  test('NaN dim treated as mismatch (defensive)', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_DIMENSIONS: 'not-a-number',
    });
    expect(w.triggered).toBe(true);
    expect(w.vars[0].current).toBe('not-a-number');
  });

  test('both vars set + both mismatched → 2 entries', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '1536',
    });
    expect(w.triggered).toBe(true);
    expect(w.vars).toHaveLength(2);
  });

  test('empty-string env values treated as unset (no false-trigger)', () => {
    const w = detectEnvOverride('zeroentropyai:zembed-1', 1280, {
      GBRAIN_EMBEDDING_MODEL: '',
      GBRAIN_EMBEDDING_DIMENSIONS: '   ',
    });
    expect(w.triggered).toBe(false);
  });
});

// ─── formatEnvOverrideWarning: pure rendering ──────────────────────────

describe('formatEnvOverrideWarning', () => {
  test('produces ASCII-only box (no Unicode box-drawing per repo D10)', () => {
    const out = formatEnvOverrideWarning({
      triggered: true,
      vars: [{ name: 'GBRAIN_EMBEDDING_MODEL', current: 'openai:x', target: 'zeroentropyai:zembed-1' }],
    });
    // Should NOT contain any Unicode box-drawing characters
    expect(out).not.toMatch(/[╔╗╚╝═║╠╣╦╩╬]/);
    // Should contain ASCII box characters
    expect(out).toMatch(/[+|-]/);
  });

  test('every line is ≤ 78 cols (terminal-safe)', () => {
    const out = formatEnvOverrideWarning({
      triggered: true,
      vars: [
        { name: 'GBRAIN_EMBEDDING_MODEL', current: 'openai:text-embedding-3-large', target: 'zeroentropyai:zembed-1' },
        { name: 'GBRAIN_EMBEDDING_DIMENSIONS', current: '1536', target: '1280' },
      ],
    });
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });

  test('names every var by exact key', () => {
    const out = formatEnvOverrideWarning({
      triggered: true,
      vars: [
        { name: 'GBRAIN_EMBEDDING_MODEL', current: 'a', target: 'b' },
        { name: 'GBRAIN_EMBEDDING_DIMENSIONS', current: 'c', target: 'd' },
      ],
    });
    expect(out).toContain('GBRAIN_EMBEDDING_MODEL');
    expect(out).toContain('GBRAIN_EMBEDDING_DIMENSIONS');
  });

  test('includes paste-ready `unset` command listing every var', () => {
    const out = formatEnvOverrideWarning({
      triggered: true,
      vars: [
        { name: 'GBRAIN_EMBEDDING_MODEL', current: 'a', target: 'b' },
        { name: 'GBRAIN_EMBEDDING_DIMENSIONS', current: 'c', target: 'd' },
      ],
    });
    expect(out).toContain('unset GBRAIN_EMBEDDING_MODEL GBRAIN_EMBEDDING_DIMENSIONS');
  });
});

// ─── applyRetrievalUpgrade integration (D9 #7 — gate fires FIRST) ──────

describe('applyRetrievalUpgrade env-gate (D9 #7)', () => {
  test('refused on env-triggered apply; ZERO setConfig calls fired', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large' }, async () => {
      // Spy on engine.setConfig
      const setConfigSpy: string[] = [];
      const realSetConfig = engine.setConfig.bind(engine);
      (engine as unknown as { setConfig: typeof engine.setConfig }).setConfig =
        async (key: string, val: string) => {
          setConfigSpy.push(key);
          return realSetConfig(key, val);
        };

      try {
        // Force an eligible plan by seeding the legacy default + enough pages.
        await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
        // Seed 101 pages to clear the ZE_MIN_PAGES_FOR_OFFER threshold.
        for (let i = 0; i < 101; i++) {
          await engine.putPage(`note/seed-${i}`, {
            type: 'note' as never,
            title: `seed-${i}`,
            compiled_truth: 'x',
            timeline: '',
          });
        }
        // Reset the spy AFTER the setup writes
        setConfigSpy.length = 0;

        const plan = await planRetrievalUpgrade(engine);
        expect(plan.ze_switch_offered).toBe(true);

        const result = await applyRetrievalUpgrade(engine, plan);
        expect(result.status).toBe('refused');
        if (result.status === 'refused') {
          expect(result.reason).toBe('env_override');
          expect(result.warning.triggered).toBe(true);
          expect(result.warning.vars[0].name).toBe('GBRAIN_EMBEDDING_MODEL');
        }
        // THE LOAD-BEARING ASSERTION: no setConfig calls fired during the
        // refused apply. Pre-fix, KEY_PREVIOUS_SNAPSHOT and KEY_REQUESTED
        // were written BEFORE the warning gate, leaving the brain in a
        // half-applied state. Now: zero mutations on refusal.
        expect(setConfigSpy).toEqual([]);

        // Direct evidence: KEY_REQUESTED + KEY_PREVIOUS_SNAPSHOT unset
        const requested = await engine.getConfig(KEY_REQUESTED);
        const snapshot = await engine.getConfig(KEY_PREVIOUS_SNAPSHOT);
        expect(requested).toBeNull();
        expect(snapshot).toBeNull();
      } finally {
        (engine as unknown as { setConfig: typeof engine.setConfig }).setConfig = realSetConfig;
      }
    });
  });

  test('--ignore-env-override proceeds with apply when env triggered', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large' }, async () => {
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
      for (let i = 0; i < 101; i++) {
        await engine.putPage(`note/x-${i}`, {
          type: 'note' as never,
          title: `x-${i}`,
          compiled_truth: 'c',
          timeline: '',
        });
      }
      const plan = await planRetrievalUpgrade(engine);
      const result = await applyRetrievalUpgrade(engine, plan, { ignoreEnvOverride: true });
      expect(result.status).toBe('applied');
      const appliedFlag = await engine.getConfig(KEY_APPLIED);
      expect(appliedFlag).toBe('true');
    });
  });

  test('env not triggered → proceeds silently (no env vars set)', async () => {
    // No env vars at all
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined },
      async () => {
        await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
        for (let i = 0; i < 101; i++) {
          await engine.putPage(`note/y-${i}`, {
            type: 'note' as never,
            title: `y-${i}`,
            compiled_truth: 'c',
            timeline: '',
          });
        }
        const plan = await planRetrievalUpgrade(engine);
        const result = await applyRetrievalUpgrade(engine, plan);
        expect(result.status).toBe('applied');
      },
    );
  });

  test('result tagged union shape pinned (TypeScript discriminator + runtime)', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:other-model' }, async () => {
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
      for (let i = 0; i < 101; i++) {
        await engine.putPage(`note/z-${i}`, {
          type: 'note' as never,
          title: `z-${i}`,
          compiled_truth: 'c',
          timeline: '',
        });
      }
      const plan = await planRetrievalUpgrade(engine);
      const result = await applyRetrievalUpgrade(engine, plan);
      expect(result.status).toBe('refused');
      // Type narrowing: runtime + TS check
      if (result.status === 'refused') {
        expect(result.reason).toBe('env_override');
        expect(Array.isArray(result.warning.vars)).toBe(true);
        expect(result.plan).toBeDefined();
      }
    });
  });
});

// ─── resumeRetrievalUpgrade env-gate (D9 #6 — same gate, no bypass) ────

describe('resumeRetrievalUpgrade env-gate (D9 #6)', () => {
  test('refused on env-triggered resume; ZERO schema-mutation setConfig calls fired', async () => {
    // Set up a half-applied state: requested=true, applied=false.
    // Then run resume with env override set.
    await engine.setConfig(KEY_REQUESTED, 'true');
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');

    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:still-old-model' }, async () => {
      const setConfigSpy: string[] = [];
      const realSetConfig = engine.setConfig.bind(engine);
      (engine as unknown as { setConfig: typeof engine.setConfig }).setConfig =
        async (key: string, val: string) => {
          setConfigSpy.push(key);
          return realSetConfig(key, val);
        };

      try {
        const result = await resumeRetrievalUpgrade(engine);
        expect(result.status).toBe('refused');
        if (result.status === 'refused') {
          expect(result.reason).toBe('env_override');
        }
        // No setConfig calls fired (no schema-completion writes happened)
        expect(setConfigSpy).toEqual([]);
        // APPLIED stays NOT-set
        const applied = await engine.getConfig(KEY_APPLIED);
        expect(applied).toBeNull();
      } finally {
        (engine as unknown as { setConfig: typeof engine.setConfig }).setConfig = realSetConfig;
      }
    });
  });

  test('--ignore-env-override proceeds with resume', async () => {
    await engine.setConfig(KEY_REQUESTED, 'true');
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');

    await withEnv({ GBRAIN_EMBEDDING_MODEL: 'openai:still-old' }, async () => {
      const result = await resumeRetrievalUpgrade(engine, { ignoreEnvOverride: true });
      expect(result.status).toBe('applied');
      const appliedFlag = await engine.getConfig(KEY_APPLIED);
      expect(appliedFlag).toBe('true');
    });
  });
});
