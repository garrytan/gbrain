/**
 * Which caller records the Rust engine's page and fact policy translator serves under `excludePrivate`
 * (src/core/rust-engine/store-members/private-provenance.ts storePageTextPolicy and storePrivacyPolicy).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a read with no caller record, an empty record, a remote caller with no member, with a member identity or a
 *    private-readable grant, an unrestricted remote caller, a member with an audience (whose policy text is the member's),
 *    the local and remote owner, and the remote owner's lineage read (the opt-in off, no audience) are served; a record
 *    whose text the store cannot apply (a labelled-only grant, a member's lineage read, an owner lineage read under the
 *    opt-in or for an audience) still refuses with engine_capability_missing. The owner records are the only ones the owner match added.
 *  - Regression: an owner record refused for every page and fact read on a Rust brain; a looser match would serve a
 *    record the store cannot apply and widen what that caller reads.
 *  - Why existing coverage misses it: the engine parity files read each served record end to end but never pin the
 *    records that must keep refusing.
 *  - Seam: none. The translator runs in process under withCallerAccess; no engine is opened.
 */
import { describe, expect, test } from 'bun:test';
import { storePageTextPolicy, storePrivacyPolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy, withCallerAccess } from '../src/core/search/private-visibility.ts';

const REMOTE = { hidePrivate: true, restricted: true, applyRemoteReadPolicy: true };
const MEMBER = { ...REMOTE, identity: ['member:alice-example'] };

const RECORDS: Array<[name: string, record: Record<string, unknown> | null, served: boolean]> = [
  ['no record', null, true],
  ['empty record', {}, true],
  ['remote, no member', { ...REMOTE }, true],
  ['remote member', MEMBER, true],
  ['remote member with a private grant', { ...MEMBER, privateReadableSources: ['default'] }, true],
  ['unrestricted remote member', { ...MEMBER, restricted: false }, true],
  ['local owner', { owner: true, hidePrivate: false, restricted: false }, true],
  ['remote owner', { ...REMOTE, identity: ['member:owner-example'], owner: true, ownerReads: true }, true],
  // An audience does not change the page or fact policy text (it narrows other reads), so its text is the member's.
  ['member with an audience', { ...MEMBER, audience: ['member:bob-example'], audienceIdentities: [['member:bob-example']] }, true],
  ['labelled-only member', { ...MEMBER, labelledOnly: true }, false],
  ['member with a lineage read', { ...MEMBER, lineage: true }, false],
  // The remote owner's lineage read (GST-2490): served as the owner read rule with the opt-in off and no audience.
  ['remote owner lineage read', { ...REMOTE, identity: ['member:owner-example'], owner: true, ownerReads: true, lineage: true }, true],
  ['remote owner lineage read under the opt-in', { ...REMOTE, identity: ['member:owner-example'], owner: true, ownerReads: true, lineage: true, ownerReadsRestricted: true }, false],
  ['remote owner lineage read for an audience', { ...REMOTE, identity: ['member:owner-example'], owner: true, ownerReads: true, lineage: true, audienceKindMembers: ['bob-example'] }, false],
];

function outcome(run: () => unknown, record: Record<string, unknown> | null): 'served' | 'refused' {
  try {
    record ? withCallerAccess(record as never, run) : run();
    return 'served';
  } catch (error) {
    if ((error as { code?: string }).code === 'engine_capability_missing') return 'refused';
    throw error;
  }
}

describe('the Rust page and fact policy translator under excludePrivate', () => {
  test('serves the no-record, reader and owner records and still refuses every other record, for page and fact reads', () => {
    const page = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePageTextPolicy('getPage', () => privatePagesFilterForCaller('p'), { callerReaders: true }), record)]));
    const fact = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePrivacyPolicy('listFactsByEntity', true, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true }), record)]));
    const expected: Record<string, 'served' | 'refused'> = Object.fromEntries(RECORDS.map(([name, , served]): [string, 'served' | 'refused'] => [name, served ? 'served' : 'refused']));
    expect({ page, fact }).toEqual({ page: expected, fact: expected });
  });

  test('a family that does not opt in with callerReaders serves only the no-record policy, owners included', () => {
    const page = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePageTextPolicy('getPage', () => privatePagesFilterForCaller('p')), record)]));
    expect(page['no record']).toBe('served');
    expect(page['local owner']).toBe('refused');
    expect(page['remote owner']).toBe('refused');
  });
});
