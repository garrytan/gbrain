/**
 * v0.36.1.0 (T14 / E8 + D18) — cross-brain calibration query tests.
 *
 * Hermetic. Mock engines stand in for local + mounted brains. The four
 * D18 e2e test cases are pinned here so cross-brain leak surfaces don't
 * regress silently.
 *
 * Tests cover:
 *  D18-1: published=false profile on mount → returns null (no leak)
 *  D18-2: published=true but consumer lacks mount-read scope → null (subagent)
 *  D18-3: subagent context attempts mount fallback → returns local-only
 *  D18-4: attribution: profile returns with source_brain_id surfaced
 *  + local-first ordering (rule 1)
 *  + mount priority order (first match wins)
 *  + null when neither local nor mount has it
 *  + canReadMountsForCtx classifier table
 */

import { describe, test, expect } from 'bun:test';
import {
  queryAcrossBrains,
  canReadMountsForCtx,
  attributionSuffix,
  type CrossBrainQueryOpts,
} from '../src/core/calibration/cross-brain.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CalibrationProfileRow } from '../src/commands/calibration.ts';

function buildProfile(opts: { published: boolean; source_id?: string; holder?: string } = { published: false }): CalibrationProfileRow {
  return {
    id: 1,
    source_id: opts.source_id ?? 'default',
    holder: opts.holder ?? 'garry',
    wave_version: 'v0.36.1.0',
    generated_at: '2026-05-17T00:00:00Z',
    published: opts.published,
    total_resolved: 12,
    brier: 0.21,
    accuracy: 0.6,
    partial_rate: 0.1,
    grade_completion: 1.0,
    pattern_statements: ['some pattern'],
    active_bias_tags: ['over-confident-geography'],
    voice_gate_passed: true,
    voice_gate_attempts: 1,
    model_id: 'claude-sonnet-4-6',
  };
}

function buildEngine(profile: CalibrationProfileRow | null): BrainEngine {
  return {
    kind: 'pglite',
    async executeRaw<T>(_sql: string): Promise<T[]> {
      return profile ? ([profile] as unknown as T[]) : ([] as T[]);
    },
  } as unknown as BrainEngine;
}

// ─── D18-1: published=false on mount → null ────────────────────────

describe('D18-1: published=false profile on mount stays hidden', () => {
  test('returns null when local empty AND only mount profile has published=false', async () => {
    const localEngine = buildEngine(null);
    const mountEngine = buildEngine(buildProfile({ published: false, source_id: 'mount-team' }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => [{ brainId: 'team-brain', engine: mountEngine }],
    });
    expect(out).toBeNull();
  });
});

// ─── D18-2 / D18-3: subagent context cannot read mounts ────────────

describe('D18-2/3: subagent context cannot fall back to mounts', () => {
  test('canReadMounts=false short-circuits to null when local has no profile', async () => {
    const localEngine = buildEngine(null);
    const mountEngine = buildEngine(buildProfile({ published: true }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: false,
      mountResolver: async () => [{ brainId: 'team-brain', engine: mountEngine }],
    });
    expect(out).toBeNull();
  });

  test('canReadMounts=false but local hit → local result still returned', async () => {
    const localEngine = buildEngine(buildProfile({ published: false }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: false,
    });
    expect(out).not.toBeNull();
    expect(out!.from_mount).toBe(false);
    expect(out!.source_brain_id).toBe('garry-personal');
  });
});

// ─── D18-4: attribution surfaces source_brain_id ───────────────────

describe('D18-4: cross-brain attribution', () => {
  test('mount answer carries from_mount=true + source_brain_id', async () => {
    const localEngine = buildEngine(null);
    const mountEngine = buildEngine(buildProfile({ published: true, source_id: 'team-default' }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => [{ brainId: 'partners-team', engine: mountEngine }],
    });
    expect(out).not.toBeNull();
    expect(out!.from_mount).toBe(true);
    expect(out!.source_brain_id).toBe('partners-team');
  });

  test('local hit carries from_mount=false + local brain id', async () => {
    const localEngine = buildEngine(buildProfile({ published: false }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
    });
    expect(out!.from_mount).toBe(false);
    expect(out!.source_brain_id).toBe('garry-personal');
  });

  test('attributionSuffix emits "from mounted brain" only when from_mount=true', () => {
    const mountResult = {
      ...buildProfile({ published: true }),
      source_brain_id: 'team-brain',
      from_mount: true,
    };
    expect(attributionSuffix(mountResult)).toContain('from mounted brain: team-brain');

    const localResult = {
      ...buildProfile({ published: false }),
      source_brain_id: 'garry-personal',
      from_mount: false,
    };
    expect(attributionSuffix(localResult)).toBe('');
  });
});

// ─── Rule 1: LOCAL-FIRST ordering ──────────────────────────────────

describe('local-first ordering (D18 rule 1)', () => {
  test('local hit short-circuits — mountResolver NOT called', async () => {
    const localEngine = buildEngine(buildProfile({ published: false }));
    let mountResolverCalls = 0;
    const opts: CrossBrainQueryOpts = {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => {
        mountResolverCalls++;
        return [];
      },
    };
    await queryAcrossBrains(localEngine, opts);
    expect(mountResolverCalls).toBe(0);
  });

  test('local empty + mount populated → mountResolver IS called', async () => {
    const localEngine = buildEngine(null);
    const mountEngine = buildEngine(buildProfile({ published: true }));
    let mountResolverCalls = 0;
    await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => {
        mountResolverCalls++;
        return [{ brainId: 'team', engine: mountEngine }];
      },
    });
    expect(mountResolverCalls).toBe(1);
  });
});

// ─── Mount priority order: first match wins ────────────────────────

describe('mount priority order', () => {
  test('first published=true mount in the list wins', async () => {
    const localEngine = buildEngine(null);
    const mountA = buildEngine(buildProfile({ published: false, source_id: 'a' }));
    const mountB = buildEngine(buildProfile({ published: true, source_id: 'b' }));
    const mountC = buildEngine(buildProfile({ published: true, source_id: 'c' }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => [
        { brainId: 'mount-a', engine: mountA },
        { brainId: 'mount-b', engine: mountB },
        { brainId: 'mount-c', engine: mountC },
      ],
    });
    // mount-a has published=false, skipped; mount-b is first published=true.
    expect(out!.source_brain_id).toBe('mount-b');
  });

  test('all mounts have published=false → returns null', async () => {
    const localEngine = buildEngine(null);
    const mountA = buildEngine(buildProfile({ published: false }));
    const mountB = buildEngine(buildProfile({ published: false }));
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
      mountResolver: async () => [
        { brainId: 'a', engine: mountA },
        { brainId: 'b', engine: mountB },
      ],
    });
    expect(out).toBeNull();
  });

  test('no mounts configured + local empty → null without throwing', async () => {
    const localEngine = buildEngine(null);
    const out = await queryAcrossBrains(localEngine, {
      holder: 'garry',
      localBrainId: 'garry-personal',
      canReadMounts: true,
    });
    expect(out).toBeNull();
  });
});

// ─── canReadMountsForCtx classifier ────────────────────────────────

describe('canReadMountsForCtx classifier', () => {
  test('local CLI (remote=false) → true', () => {
    expect(canReadMountsForCtx({ remote: false })).toBe(true);
  });

  test('MCP non-subagent (remote=true, viaSubagent=undefined) → true', () => {
    expect(canReadMountsForCtx({ remote: true })).toBe(true);
  });

  test('subagent without trusted-workspace prefixes → false (D18 rule 4)', () => {
    expect(
      canReadMountsForCtx({ remote: true, viaSubagent: true, allowedSlugPrefixes: [] }),
    ).toBe(false);
  });

  test('subagent with trusted-workspace prefixes (cycle synthesize/patterns) → true', () => {
    expect(
      canReadMountsForCtx({
        remote: true,
        viaSubagent: true,
        allowedSlugPrefixes: ['wiki/agents/synthesize/*'],
      }),
    ).toBe(true);
  });
});
