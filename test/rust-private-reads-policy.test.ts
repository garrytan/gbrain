/**
 * Which caller records the Rust engine's page and fact policy translator serves under `excludePrivate`
 * (src/core/rust-engine/store-members/private-provenance.ts storePageTextPolicy and storePrivacyPolicy).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a read with no caller record, an empty record, a remote caller with no member, with a member identity or a
 *    private-readable grant, an unrestricted remote caller, a member with an audience (whose policy text is the member's),
 *    and the local and remote owner are served; a record whose text the store cannot apply (a labelled-only grant, a
 *    lineage read) is served by the page policy and, since row 32e-b-4, by the fact policy too; a record whose text the store cannot
 *    apply (a labelled-only audience of several identities) still refuses with engine_capability_missing. The owner records are
 *    the only ones the owner match added.
 *  - Regression: an owner record refused for every page and fact read on a Rust brain; a looser match would serve a
 *    record the store cannot apply and widen what that caller reads.
 *  - Why existing coverage misses it: the engine parity files read each served record end to end but never pin the
 *    records that must keep refusing.
 *  - Seam: none. The translator runs in process under withCallerAccess; no engine is opened.
 */
import { describe, expect, test } from 'bun:test';
import { storePageTextPolicy, storePrivacyPolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { privateFactFilterForReader, privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy, remoteReadFloorSql, withCallerAccess } from '../src/core/search/private-visibility.ts';

const REMOTE = { hidePrivate: true, restricted: true, applyRemoteReadPolicy: true };
const MEMBER = { ...REMOTE, identity: ['member:alice-example'] };

/** What each translator serves for a record: the page policy and the fact policy. */
type Served = boolean | { page: boolean; fact: boolean };
const RECORDS: Array<[name: string, record: Record<string, unknown> | null, served: Served]> = [
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
  // A labelled-only grant and a member's lineage read are served as the same record with the grant or the lineage rule.
  ['labelled-only member', { ...MEMBER, labelledOnly: true }, true],
  ['labelled-only member with a lineage read', { ...MEMBER, labelledOnly: true, lineage: true }, true],
  ['member with a lineage read', { ...MEMBER, lineage: true }, true],
  // Not modelled: a labelled-only audience of several identities (the rest of its policy is one test per identity).
  ['labelled-only member with an audience of two', { ...MEMBER, labelledOnly: true, audience: ['member:alice-example', 'member:bob-example'], audienceIdentities: [['member:alice-example'], ['member:bob-example']] }, false],
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
  test('serves the no-record, reader, owner, labelled-only and lineage records, and refuses an audience of a labelled-only member', () => {
    const page = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePageTextPolicy('getPage', () => privatePagesFilterForCaller('p'), { callerReaders: true }), record)]));
    const fact = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePrivacyPolicy('listFactsByEntity', true, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true }), record)]));
    const expect_ = (which: 'page' | 'fact'): Record<string, 'served' | 'refused'> => Object.fromEntries(RECORDS.map(([name, , served]): [string, 'served' | 'refused'] =>
      [name, (typeof served === 'boolean' ? served : served[which]) ? 'served' : 'refused']));
    expect({ page, fact }).toEqual({ page: expect_('page'), fact: expect_('fact') });
  });

  test('a family that does not opt in with callerReaders serves only the no-record policy, owners included', () => {
    const page = Object.fromEntries(RECORDS.map(([name, record]) =>
      [name, outcome(() => storePageTextPolicy('getPage', () => privatePagesFilterForCaller('p')), record)]));
    expect(page['no record']).toBe('served');
    expect(page['local owner']).toBe('refused');
    expect(page['remote owner']).toBe('refused');
  });

  test('the remote read floor sends the pending prefixes its text was rendered with, for a labelled-only and an ordinary caller', () => {
    const coverage = [{ source_id: 'default', prefix: 'derived/' }];
    const floor = (record: Record<string, unknown>) => withCallerAccess(record as never, () => storePageTextPolicy('readReflexPages', () => remoteReadFloorSql('p'), { callerReaders: true }));
    const labelled = floor({ ...MEMBER, labelledOnly: true, lineage: true, folderCoverage: coverage, satisfiedRuleIds: ['default:r1'] });
    expect({ coverage: labelled.folderCoverage, record: labelled.callerRecord, terms: labelled.labelledOnly })
      .toEqual({ coverage, record: true, terms: { identity: ['member:alice-example'], satisfiedRuleIds: ['default:r1'], lineage: true, member: 'alice-example' } });
    expect(floor({ ...MEMBER, folderCoverage: coverage }).folderCoverage).toEqual(coverage);
    // No prefix in the record: the plain floor form, which sends none (and never the live pending prefixes of the store).
    expect(floor({ ...MEMBER, labelledOnly: true }).folderCoverage).toBeUndefined();
  });
  test('a lineage read sends the fact policy the lineage flags and the record it was rendered with, in each form (row 32e-b-4)', () => {
    const coverage = [{ source_id: 'default', prefix: 'pend/' }];
    const folders = { satisfiedRuleIds: ['default:r1'], folderCoverage: coverage };
    const first = (record: Record<string, unknown>) => withCallerAccess(record as never, () => storePrivacyPolicy('listFactsByEntity', true, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true }));
    const second = (record: Record<string, unknown>) => withCallerAccess(record as never, () => storePrivacyPolicy('getOntology', true, () => privateFactFilterForReader('facts'), { callerReaders: true }));
    for (const [name, record] of [['ordinary', { ...MEMBER, lineage: true, ...folders }], ['labelled-only', { ...MEMBER, labelledOnly: true, lineage: true, ...folders }]] as const) {
      // The first form's text holds the lineage case; the second form's provenance part is the plain one.
      const one = first(record);
      const two = second(record);
      expect({ name, lineageProvenance: one?.lineageProvenance, ownerRead: one?.ownerRead, callerRecord: one?.callerRecord }).toEqual({ name, lineageProvenance: true, ownerRead: true, callerRecord: true });
      expect({ name, lineageProvenance: two?.lineageProvenance, ownerRead: two?.ownerRead, callerRecord: two?.callerRecord }).toEqual({ name, lineageProvenance: false, ownerRead: true, callerRecord: true });
      // The pending prefixes and satisfied rules of the record are sent, so the store hides what the text hides (a missing field was a leak in row 32e-b-2).
      for (const policy of [one, two]) expect({ name, folders: { satisfiedRuleIds: policy?.satisfiedRuleIds, folderCoverage: policy?.folderCoverage } }).toEqual({ name, folders });
      expect({ name, terms: one?.labelledOnly }).toEqual({ name, terms: record.labelledOnly ? { identity: ['member:alice-example'], satisfiedRuleIds: ['default:r1'], lineage: true, member: 'alice-example' } : undefined });
    }
    // Without lineage the policy carries none of it: the earlier rule stays.
    for (const read of [first, second]) {
      const plain = read({ ...MEMBER, ...folders });
      expect({ lineageProvenance: plain?.lineageProvenance, ownerRead: plain?.ownerRead, callerRecord: plain?.callerRecord }).toEqual({ lineageProvenance: undefined, ownerRead: undefined, callerRecord: undefined });
    }
  });
});
