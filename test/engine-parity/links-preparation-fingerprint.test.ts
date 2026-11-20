/**
 * BrainEngine parity: the three reads link preparation makes (readLiveSlugAliases, probeSourceSlugFingerprint,
 * readSourceSlugFingerprint), called directly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for the same pages, every engine arm returns the same alias targets, and the same slug fingerprint (row
 *    count, the sum of Postgres `hashtextextended(slug, 0)` as a decimal string, highest id), the same slugs and the same
 *    slugs added after an id with their hash sum. The Rust arm computes the hash itself, so this is where it is held
 *    to the value a SQL engine returns.
 *  - Regression: the reads were raw SQL, which a Rust brain refused (links-preparation.test.ts shows the put that
 *    stopped on it). A hash that differs on one byte would make the cached slug index rebuild on every put, or, worse,
 *    keep a stale one.
 *  - Why existing coverage misses it: the put cases show the links, not the fingerprint, and the Rust store's unit test
 *    pins hash values, not a whole source.
 *  - Seam: typed members only (no executeRaw: D18). The slugs hold ASCII, accented and CJK text and sit at several
 *    lengths around the hash's 12-byte block; one page is soft-deleted (the fingerprint has no live filter). The
 *    slug lists have no set order on the SQL engines, so they are compared sorted.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUGS = ['people/alice-example', 'notes/caf\u00e9', 'people/\u65e5\u672c\u8a9e', 'abcdefghijklmnopqrstuvwxy', 'a', 'x\u{1F600}y', 'notes/twelve-char'];
const sorted = (slugs: string[]) => [...slugs].sort();

describe('engine parity: link preparation reads', () => {
  parityTest('readSourceSlugFingerprint and probeSourceSlugFingerprint agree on a source with a soft-deleted page', {
    methods: ['putPage', 'softDeletePage', 'readSourceSlugFingerprint', 'probeSourceSlugFingerprint'],
  }, async (engine) => {
    for (const slug of SLUGS.slice(0, 4)) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body' });
    const before = await engine.readSourceSlugFingerprint('default');
    for (const slug of SLUGS.slice(4)) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body' });
    await engine.softDeletePage('notes/caf\u00e9');
    const all = await engine.readSourceSlugFingerprint('default');
    const probe = await engine.probeSourceSlugFingerprint('default', before.m);
    const none = await engine.probeSourceSlugFingerprint('default', all.m);
    const everything = await engine.probeSourceSlugFingerprint('default', 0);
    const empty = await engine.readSourceSlugFingerprint('no-such-source');
    expect(all.n).toBe(SLUGS.length);
    expect(BigInt(probe.h)).toBe(BigInt(before.h) + BigInt(probe.added_h));
    return {
      before: { ...before, slugs: sorted(before.slugs) },
      all: { ...all, slugs: sorted(all.slugs) },
      probe: { ...probe, added: sorted(probe.added) },
      none, everything: { ...everything, added: sorted(everything.added) },
      empty,
    };
  });

  parityTest('readLiveSlugAliases returns an alias with no live page whose canonical page is live', {
    methods: ['putPage', 'updateSlug', 'softDeletePage', 'readLiveSlugAliases'],
  }, async (engine) => {
    for (const slug of ['people/bob-old', 'people/carol-old', 'people/dan-old']) await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: 'x' });
    await engine.updateSlug('people/bob-old', 'people/bob');
    await engine.updateSlug('people/carol-old', 'people/carol');
    await engine.updateSlug('people/dan-old', 'people/dan');
    await engine.putPage('people/carol-old', { type: 'person', title: 'A new page at the alias slug', compiled_truth: 'x' });
    await engine.softDeletePage('people/dan');
    const targets = ['people/bob-old', 'people/carol-old', 'people/dan-old', 'people/nobody', 'people/bob-old'];
    const rows = await engine.readLiveSlugAliases('default', targets);
    const empty = await engine.readLiveSlugAliases('default', []);
    const otherSource = await engine.readLiveSlugAliases('no-such-source', targets);
    expect(rows).toEqual([{ alias_slug: 'people/bob-old', canonical_slug: 'people/bob' }]);
    return { rows: rows.map((r) => ({ ...r })).sort((a, b) => (a.alias_slug < b.alias_slug ? -1 : 1)), empty, otherSource };
  });
});
