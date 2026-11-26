/**
 * Which owner read rules the Rust engine's ownerReachesFact serves for an owner bound to a member
 * (src/core/rust-engine/store-members/private-provenance.ts storeOwnerReachPolicy).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the owner's identity and satisfied folder rules reach the store when both fragments of the SQL
 *    (ownerReadPolicyFragment, readPolicyFragment) render as a reference text: outside any caller record, inside a
 *    caller record (with its folder coverage, as an owner too), or the short member-access form (`open`); an identity
 *    or rule the fragments drop as invalid refuses with engine_capability_missing.
 *  - Regression: serving a text the store does not model would let a forget reach pages the SQL would hide; the
 *    dropped-as-invalid case is the one a text comparison alone would pass (the reference drops the same ids).
 *  - Why existing coverage misses it: the engine parity case reads one identity and no satisfied rule, in no caller
 *    record, so it never meets a refusal or a record form.
 *  - Seam: none. The translator runs in process under withCallerAccess; no engine is opened.
 */
import { describe, expect, test } from 'bun:test';
import { storeOwnerReachPolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';

const ALICE = ['member:alice-example'];

function judged(identity: string[], satisfied: string[], record: Record<string, unknown> | null) {
  const run = () => storeOwnerReachPolicy('ownerReachesFact', { identity, satisfied });
  try {
    return record ? withCallerAccess(record as never, run) : run();
  } catch (error) {
    if ((error as { code?: string }).code === 'engine_capability_missing') return 'refused' as const;
    throw error;
  }
}

describe('the Rust owner read policy translator for ownerReachesFact', () => {
  test('sends the identity and the satisfied rules of a member-bound owner outside any caller record', () => {
    expect(judged(ALICE, [], null)).toMatchObject({ identity: ALICE, honorAliases: true, entityPrivacy: true, ownerOnly: 'closed' });
    const withRules = judged([...ALICE, 'group:ops'], ['default:b-rule', 'default:a-rule'], null);
    expect(withRules).toMatchObject({ identity: [...ALICE, 'group:ops'], satisfiedRuleIds: ['default:b-rule', 'default:a-rule'] });
    expect(judged(ALICE, [], null)).not.toHaveProperty('satisfiedRuleIds');
    expect(judged(ALICE, [], null)).not.toHaveProperty('open');
  });

  test('serves a caller record, with its folder coverage and the owner form, and marks the short member-access form open', () => {
    expect(judged(ALICE, [], {})).toMatchObject({ identity: ALICE, callerRecord: true, ownerOnly: 'closed' });
    expect(judged(ALICE, [], {})).not.toHaveProperty('folderCoverage');
    expect(judged(ALICE, [], { hidePrivate: true, restricted: true, applyRemoteReadPolicy: true, identity: ['member:bob-example'] })).toMatchObject({ identity: ALICE, callerRecord: true });
    const coverage = [{ source_id: 'default', prefix: 'raw/' }];
    expect(judged(ALICE, [], { folderCoverage: coverage })).toMatchObject({ callerRecord: true, folderCoverage: coverage });
    expect(judged(ALICE, [], { owner: true, restricted: true })).toMatchObject({ callerRecord: true, ownerOnly: 'off' });
    expect(judged(ALICE, [], { owner: true, ownerReads: true, identity: ALICE, folderCoverage: coverage })).toMatchObject({ ownerOnly: 'off', folderCoverage: coverage });
    expect(judged(ALICE, ['default:a-rule'], { restricted: false })).toMatchObject({ identity: ALICE, satisfiedRuleIds: ['default:a-rule'], open: true, callerRecord: true });
  });

  test('refuses an identity or a rule the fragments drop as invalid, which the store would otherwise apply as written', () => {
    expect(judged([...ALICE, 'member:NOT VALID'], [], null)).toBe('refused');
    expect(judged(ALICE, ['not a qualified id'], null)).toBe('refused');
    expect(judged(ALICE, ['default:a-rule', 'not a qualified id'], null)).toBe('refused');
    expect(judged(ALICE, ['default:a-rule', 'not a qualified id'], { restricted: false })).toBe('refused');
  });

  test('serves a labelled-only or audience record too: neither fragment reads those fields, so the text is the record\'s', () => {
    expect(judged(ALICE, [], { labelledOnly: true })).toMatchObject({ identity: ALICE });
    expect(judged(ALICE, [], { audience: ['member:bob-example'], audienceIdentities: [['member:bob-example']] })).toMatchObject({ identity: ALICE });
  });
});
