/**
 * #2589 — cross-source wikilink edges: no more silent zero-edge drops.
 *
 * `resolveCandidateSources` historically returned `null` for a target that
 * exists ONLY in other sources (neither the origin page's source nor
 * 'default') — the same `null` as a missing endpoint, so multi-source graphs
 * went sparse with dead_links stuck at 0 and nothing in the summary. A
 * maintainer repro on current master (hermetic PGLite driving real
 * `gbrain extract links --source db`) re-severitied the issue p3 → P1.
 *
 * Post-fix contract, pinned here:
 *  - cross-source-only targets return the distinguishable sentinel
 *    'cross-source-only' when the flag is off (callers COUNT the drop);
 *  - with `{ crossSource: true }` the edge resolves with a DETERMINISTIC
 *    to_source_id (lexicographically smallest matching source) so repeated
 *    extracts and both engines converge under the (source_id, slug) key;
 *  - same-source and 'default' resolution are byte-for-byte unchanged;
 *  - `isCrossSourceLinksEnabled` follows the #972 ladder: env override >
 *    DB config > default false.
 */

import { describe, test, expect } from 'bun:test';
import { resolveCandidateSources } from '../src/commands/extract.ts';
import { isCrossSourceLinksEnabled } from '../src/core/link-extraction.ts';
import type { LinkCandidate } from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function cand(targetSlug: string, fromSlug?: string): LinkCandidate {
  return {
    targetSlug,
    fromSlug,
    linkType: 'mentions',
    context: 'ctx',
    linkSource: 'markdown',
  } as LinkCandidate;
}

function maps(entries: Record<string, string[]>) {
  const allSlugs = new Set(Object.keys(entries));
  const slugToSources = new Map(Object.entries(entries));
  return { allSlugs, slugToSources };
}

describe('#2589 resolveCandidateSources — cross-source targets', () => {
  test('same-source target unchanged (regression pin)', () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a'],
      'comms/msg-1': ['vault-a'],
    });
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'vault-a', allSlugs, slugToSources);
    expect(r).toEqual({ fromSlug: 'comms/msg-1', fromSourceId: 'vault-a', toSourceId: 'vault-a' });
  });

  test("'default'-source fallback unchanged (regression pin)", () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['default'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources);
    expect(r).toEqual({ fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'default' });
  });

  test('missing endpoint still returns null (distinct from the cross-source sentinel)', () => {
    const { allSlugs, slugToSources } = maps({ 'comms/msg-1': ['comms'] });
    const r = resolveCandidateSources(cand('people/ghost'), 'comms/msg-1', 'comms', allSlugs, slugToSources);
    expect(r).toBeNull();
  });

  test("flag OFF: cross-source-only target returns 'cross-source-only', not null — the literal #2589 repro", () => {
    // The issue's shape: a comms page wikilinks a person whose page lives
    // only in a vault source. Pre-fix this returned null (silent drop).
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources);
    expect(r).toBe('cross-source-only');
    const rExplicitOff = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, { crossSource: false },
    );
    expect(rExplicitOff).toBe('cross-source-only');
  });

  test('flag ON: cross-source edge resolves with the target source', () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, { crossSource: true },
    );
    expect(r).toEqual({ fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'vault-a' });
  });

  test('flag ON: multi-source target picks deterministically (lexicographic min)', () => {
    // Order in the map deliberately reversed vs lexicographic to prove the
    // pick sorts rather than trusting enumeration order — repeated extracts
    // and both engines must converge on the same (source_id, slug) edge.
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-b', 'vault-a'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, { crossSource: true },
    );
    expect(r).toEqual({ fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'vault-a' });
  });

  test('flag ON: same-source still wins over cross-source (no pick when unnecessary)', () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a', 'comms'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, { crossSource: true },
    );
    expect(r).toEqual({ fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'comms' });
  });
});

describe('#2589 isCrossSourceLinksEnabled — #972 resolution ladder', () => {
  function engineWith(dbVal: string | null): BrainEngine {
    return { getConfig: async () => dbVal } as unknown as BrainEngine;
  }

  test('default false (no env, no config)', async () => {
    await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined }, async () => {
      expect(await isCrossSourceLinksEnabled(engineWith(null))).toBe(false);
    });
  });

  test('DB config enables', async () => {
    await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined }, async () => {
      expect(await isCrossSourceLinksEnabled(engineWith('true'))).toBe(true);
      expect(await isCrossSourceLinksEnabled(engineWith('off'))).toBe(false);
    });
  });

  test('env overrides DB config in BOTH directions (operator escape hatch)', async () => {
    await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' }, async () => {
      expect(await isCrossSourceLinksEnabled(engineWith(null))).toBe(true);
    });
    await withEnv({ GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '0' }, async () => {
      expect(await isCrossSourceLinksEnabled(engineWith('true'))).toBe(false);
    });
  });
});
