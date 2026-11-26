/**
 * What the enforced member CLI's Rust members refuse before they read, and what the placement notice does with an error.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: (a) readHiddenPageSlugs and readMemberPageReadable refuse a record whose policy the store does not model
 *     (lineage, an audience, an owner record, a labelled-only grant) with engine_capability_missing even when asked of no
 *     slugs, which is what lets a write ask the output guard first and refuse before it writes; an ordinary member record
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

  for (const [name, record] of [['lineage', { lineage: true }], ['an owner record', { owner: true }], ['a labelled-only grant', { labelledOnly: true }],
    ['an audience', { audienceIdentities: [['member:tess-example'], ['member:bob-example']] }]] as const) {
    test(`${name} refuses an empty ask`, async () => {
      expect(await code(() => withCallerAccess({ ...MEMBER, ...record }, () => readHiddenPageSlugs(brain, [], [])))).toBe('engine_capability_missing');
    });
  }

  test('a labelled-only read of a page refuses before any read', async () => {
    expect(await code(() => withCallerAccess({ ...MEMBER, labelledOnly: true }, () => readMemberPageReadable(brain, 'default', 'notes/a', MEMBER.identity, [], true)))).toBe('engine_capability_missing');
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
