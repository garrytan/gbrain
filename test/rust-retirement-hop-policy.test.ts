/**
 * The page policy a retirement hop serves on the Rust engine for member access alone
 * (src/core/rust-engine/store-members/private-provenance.ts retirementHopPolicy).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a caller whose member-access SQL equals the no-caller text is served with no member identity; every other
 *    caller is served only when its SQL equals the canonical text for its identity, with that identity and its private
 *    readable sources, and otherwise refuses with engine_capability_missing. A remote member caller with an identity
 *    never reads as the no-caller text, so it is never served as an anonymous reader.
 *  - Regression: serving a remote member as the no-caller form would hide the pages that name the member, or, with the
 *    identity dropped, widen what a labelled-only, lineage or audience caller reads.
 *  - Why existing coverage misses it: the engine parity cases read under the owner or an unrestricted caller; a remote
 *    member caller reaches the policy only through the doctor reader-page checks.
 *  - Seam: none. The translator runs in process under withCallerAccess; no engine is opened.
 */
import { describe, expect, test } from 'bun:test';
import { retirementHopPolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';

const ALICE = ['member:alice-example'];

function judged(record: Record<string, unknown> | null) {
  const run = () => retirementHopPolicy('member_access');
  try {
    return record ? withCallerAccess(record as never, run) : run();
  } catch (error) {
    if ((error as { code?: string }).code === 'engine_capability_missing') return 'refused' as const;
    throw error;
  }
}

describe('retirementHopPolicy for member access alone', () => {
  test('a caller outside any record is served as the no-caller form, with no member identity', () => {
    const policy = judged(null);
    expect(policy).toMatchObject({ honorAliases: false, entityPrivacy: false });
    expect((policy as { identity?: unknown }).identity).toBeUndefined();
  });

  test('a remote member caller is served with its own identity, never as the no-caller form', () => {
    const policy = judged({ identity: ALICE, hidePrivate: true, privateReadableSources: ['work'] }) as { identity?: string[]; privateReadableSources?: string[] };
    expect(policy).not.toBe('refused');
    expect(policy.identity).toEqual(ALICE);
    expect(policy.privateReadableSources).toEqual(['work']);
    const relaxed = judged({ identity: ALICE, hidePrivate: false }) as { identity?: string[] };
    expect(relaxed.identity).toEqual(ALICE);
  });

  test('a remote member caller that satisfies a folder rule refuses rather than reading as the no-caller form', () => {
    expect(judged({ identity: ALICE, hidePrivate: true, satisfiedRuleIds: ['work:diary'] })).toBe('refused');
  });

  test('a caller whose labelled-only grant, lineage or several audiences widen the policy refuses', () => {
    expect(judged({ identity: ALICE, hidePrivate: true, labelledOnly: true })).toBe('refused');
    expect(judged({ identity: ALICE, hidePrivate: true, owner: true, lineage: true })).toBe('refused');
    expect(judged({ audienceIdentities: [ALICE, ['member:bob-example']], hidePrivate: true })).toBe('refused');
  });
});
