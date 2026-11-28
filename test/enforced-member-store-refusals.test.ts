/**
 * What the enforced member CLI's Rust members refuse before they read, and what the placement notice does with an error.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: (a) readHiddenPageSlugs and readMemberPageReadable refuse a record whose policy the store does not model
 *     (lineage, an audience, an owner record, a labelled-only grant) with engine_capability_missing even when asked of no
 *     slugs (readMemberPageReadable and readHiddenPageSlugs serve a labelled-only grant without lineage: the store judges it), which is what lets a write ask the output guard first and refuse before it writes; an ordinary member record
 *     answers an empty ask with no read. (b) withImplicitPlacement lets an engine's capability refusal out and keeps the
 *     put's result for any other error.
 *  2. Fails when: an unsupported record answers an empty ask (the write would then run before the guard refuses), or an
 *     ordinary record is refused, or the placement notice swallows a capability refusal or fails a put on another error.
 *  3. Existing coverage: test/token-member-cli-parity.serial.test.ts runs the lineage case end to end on a Rust brain
 *     and needs the addon; this one needs none.
 *  4. Seams: none; the store brain is a stub that fails if it is called.
 */
import { describe, expect, test } from 'bun:test';
import { readHiddenPageSlugs, readMemberPageReadable } from '../src/core/rust-engine/store-members/page-mutation-reads.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { withImplicitPlacement } from '../src/core/access/implicit-placement.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const brain = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the store was called: ${String(name)}`); } }) as never;
const MEMBER = { identity: ['member:tess-example'], satisfiedRuleIds: [] as string[], hidePrivate: true, restricted: true, owner: false, privateReadableSources: [] as string[], folderCoverage: [] };
const code = async (run: () => Promise<unknown>) => run().then(() => 'answered', (e: { code?: string }) => e.code ?? String(e));

describe('the enforced member reads of a Rust brain refuse a record the store does not model before they read', () => {
  test('an ordinary member record answers an empty ask with no read', async () => {
    expect(await withCallerAccess(MEMBER, () => readHiddenPageSlugs(brain, [], []))).toEqual([]);
  });

  for (const [name, record] of [['lineage', { lineage: true }], ['an owner record', { owner: true }], ['a labelled-only grant with lineage', { labelledOnly: true, lineage: true }],
    ['a labelled-only grant with an audience', { labelledOnly: true, audienceIdentities: [['member:tess-example'], ['member:bob-example']] }],
    ['an audience', { audienceIdentities: [['member:tess-example'], ['member:bob-example']] }]] as const) {
    test(`${name} refuses an empty ask`, async () => {
      expect(await code(() => withCallerAccess({ ...MEMBER, ...record }, () => readHiddenPageSlugs(brain, [], [])))).toBe('engine_capability_missing');
    });
  }

  // The output guard serves a labelled-only member without lineage: the grant is in the record, so the text carries the conjunct, and
  // the store is sent its terms. An empty ask answers with no read; a named one reaches the store.
  test('a labelled-only record answers an empty ask with no read and reaches the store for a named slug', async () => {
    const record = { ...MEMBER, labelledOnly: true };
    expect(await withCallerAccess(record, () => readHiddenPageSlugs(brain, [], []))).toEqual([]);
    expect(await code(() => withCallerAccess(record, () => readHiddenPageSlugs(brain, ['notes/a'], [])))).toContain('the store was called');
  });

  test('an identity emptied by an invalid entry beside valid satisfied rules refuses; either set emptied alone answers', async () => {
    const asked = (identity: string[], satisfiedRuleIds: string[]) => code(() => withCallerAccess({ ...MEMBER, identity, satisfiedRuleIds }, () => readMemberPageReadable(brain, 'default', 'notes/a', identity, satisfiedRuleIds, false)));
    expect(await asked(['member:tess-example', 'not a principal'], ['default:team-a'])).toBe('engine_capability_missing');
    // The stub store throws when called; reaching it is the answer here, so these two passed the policy.
    expect(await asked(['member:tess-example', 'not a principal'], [])).toContain('the store was called');
    expect(await asked(['member:tess-example'], ['default:team-a', 'invalid'])).toContain('the store was called');
  });

  // The labelled-only conjunct goes to the store as data (the sets labelledOnlySql embeds), so the read reaches the store.
  test('a labelled-only read of a page reaches the store, which judges the conjunct', async () => {
    expect(await code(() => withCallerAccess({ ...MEMBER, labelledOnly: true }, () => readMemberPageReadable(brain, 'default', 'notes/a', MEMBER.identity, [], true)))).toContain('the store was called');
  });
});

describe('the placement notice after a put', () => {
  const failing = (error: Error) => new Proxy({}, { get: () => () => { throw error; } }) as unknown as BrainEngine;
  const written = { status: 'created_or_updated', slug: 'notes/a' };
  const place = (engine: BrainEngine) => withImplicitPlacement({ engine, remote: false, localSourceImplicit: true }, 'default', { slug: 'notes/a' }, written);

  test('lets an engine capability refusal out', async () => {
    expect(await code(() => place(failing(Object.assign(new Error('refused'), { code: 'engine_capability_missing' }))))).toBe('engine_capability_missing');
  });

  test('keeps the put result for any other error', async () => {
    expect(await place(failing(new Error('a read failed')))).toBe(written);
  });
});
