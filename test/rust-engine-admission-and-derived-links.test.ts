/**
 * Two Rust-engine members that must keep the SQL engines' behaviour where the parity suite cannot compare answers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) `readAdmissionSource` on a guest source (config guest: true) refuses with
 *    `engine_capability_missing`, as `readGuestSourceRow` does, because the store keeps no guest_sources row and
 *    admission would otherwise read the guest source as an ordinary one; an ordinary source still returns its row.
 *    (2) `replaceDerivedLinks` primes the pack relation semantics when the caller did not (`semanticsPrimed` unset),
 *    as derived-links.ts does on PGLite and Postgres, and skips the priming when the caller says it primed them.
 *  - Regression: a guest source admitted with `guest_writers: null` (the guest writer and attribution checks skipped),
 *    and derived edges published under stale relation semantics.
 *  - Why existing coverage misses it: the SQL engines return a guest row the Rust store cannot build, so no parity case
 *    can compare the two; and the semantics are process-wide state no parity answer exposes.
 *  - Seam: spyOn on the repo's own `primeRelationSemantics` export, which the Rust member imports by name.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import * as semanticsPack from '../src/core/link-semantics-pack.ts';
import { createRustSource, openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

describe.skipIf(!rustArmRequested())('Rust engine: guest admission and derived-link semantics', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    const opened = await openRustBrain();
    engine = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
    await createRustSource(engine, 'guest-src', { guest: true });
    await createRustSource(engine, 'plain-src', {});
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
    removeBrainDir(dir);
  });

  test('readAdmissionSource refuses a guest source and serves an ordinary one', async () => {
    const refused = await engine.readAdmissionSource('guest-src').then(() => null, (e: { code?: string }) => e);
    expect(refused?.code).toBe('engine_capability_missing');
    const plain = await engine.readAdmissionSource('plain-src');
    expect(plain).not.toBeNull();
    expect(plain!.guest_writers ?? null).toBeNull();
    expect(await engine.readAdmissionSource('no-such-source')).toBeNull();
  });

  describe('replaceDerivedLinks relation semantics', () => {
    let spy: ReturnType<typeof spyOn> | undefined;
    afterEach(() => spy?.mockRestore());

    async function replace(opts: { semanticsPrimed?: boolean }) {
      await engine.putPage('sem/origin', { type: 'note', title: 'o', compiled_truth: 'o', timeline: '' });
      await engine.putPage('sem/target', { type: 'note', title: 't', compiled_truth: 't', timeline: '' });
      const snap = await engine.readPageSnapshot('sem/origin', { sourceId: 'default' });
      const origin = { slug: 'sem/origin', sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      spy = spyOn(semanticsPack, 'primeRelationSemantics');
      await engine.replaceDerivedLinks(origin, [{ from_slug: 'sem/origin', to_slug: 'sem/target', link_type: 'cites', link_source: 'markdown' }], opts);
      return spy.mock.calls.length;
    }

    test('primes them when the caller did not', async () => {
      expect(await replace({})).toBe(1);
    });

    test('does not prime them when the caller says it did', async () => {
      expect(await replace({ semanticsPrimed: true })).toBe(0);
    });
  });
});
