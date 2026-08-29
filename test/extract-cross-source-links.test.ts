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
 *  - cross-source-only targets return the distinguishable
 *    { ok: false, reason: 'cross_source' } when the flag is off (callers
 *    COUNT the drop — #2589's reasoned-failure shape);
 *  - with `{ crossSource: true }` the edge resolves with a DETERMINISTIC
 *    to_source_id (lexicographically smallest matching source) so repeated
 *    extracts and both engines converge under the (source_id, slug) key;
 *  - same-source and 'default' resolution are byte-for-byte unchanged for a
 *    FEDERATED origin (train port: #3478 landed first and gates the ambient
 *    'default' fallback on `allowCrossSource`; the explicit #2589 opt-in
 *    supersedes that gate, and isolated-origin drops are counted too);
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
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'vault-a', allSlugs, slugToSources, true);
    expect(r).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'vault-a', toSourceId: 'vault-a' });
  });

  test("'default'-source fallback unchanged (regression pin)", () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['default'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true);
    expect(r).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'default' });
  });

  test("missing endpoint returns reason 'missing_target' (distinct from a cross-source drop)", () => {
    const { allSlugs, slugToSources } = maps({ 'comms/msg-1': ['comms'] });
    const r = resolveCandidateSources(cand('people/ghost'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true);
    expect(r).toEqual({ ok: false, reason: 'missing_target' });
  });

  test("flag OFF: cross-source-only target returns reason 'cross_source', not a missing-target drop — the literal #2589 repro", () => {
    // The issue's shape: a comms page wikilinks a person whose page lives
    // only in a vault source. Pre-fix this returned null (silent drop).
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true);
    expect(r).toEqual({ ok: false, reason: 'cross_source' });
    const rExplicitOff = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true, { crossSource: false },
    );
    expect(rExplicitOff).toEqual({ ok: false, reason: 'cross_source' });
  });

  test('flag ON: cross-source edge resolves with the target source', () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true, { crossSource: true },
    );
    expect(r).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'vault-a' });
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
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true, { crossSource: true },
    );
    expect(r).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'vault-a' });
  });

  test('flag ON: same-source still wins over cross-source (no pick when unnecessary)', () => {
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['vault-a', 'comms'],
      'comms/msg-1': ['comms'],
    });
    const r = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, true, { crossSource: true },
    );
    expect(r).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'comms' });
  });

  test('isolated origin (#3478 gate): flag OFF counts the drop, flag ON resolves', () => {
    // Composition pin for the wave-k train merge: an ISOLATED (non-federated)
    // origin never grows ambient cross-source edges — including the 'default'
    // fallback — but the drop is COUNTED, and the explicit #2589 opt-in
    // supersedes the gate (it exists to stop default-on silent regrowth).
    const { allSlugs, slugToSources } = maps({
      'people/alice-example': ['default'],
      'comms/msg-1': ['comms'],
    });
    const off = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, false,
    );
    expect(off).toEqual({ ok: false, reason: 'cross_source' });
    const on = resolveCandidateSources(
      cand('people/alice-example'), 'comms/msg-1', 'comms', allSlugs, slugToSources, false, { crossSource: true },
    );
    expect(on).toEqual({ ok: true, fromSlug: 'comms/msg-1', fromSourceId: 'comms', toSourceId: 'default' });
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
