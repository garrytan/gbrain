/**
 * The Rust engine's readLinkTargetPages member (src/core/rust-engine/store-members/remote-links.ts): which writer read
 * policies it serves and what it sends the store, with a stand-in store that records the policy it is given.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a writer's read policy is served only when its rendered text is a form the store models; a labelled-only writer's
 *    text must be that form ANDed with the labelled-only conjunct, which goes to the store as the two sets `labelledOnlySql` embeds;
 *    a writer with one identity under folder rules it satisfies goes as a caller record; any other writer (several identities)
 *    refuses with engine_capability_missing before the store is called.
 *  - Regression: the member refused every labelled-only writer and every writer that satisfied a folder rule, so a labelled-only
 *    member's rewrite of an open page ended on engine_capability_missing instead of page_not_found (row 32e-b-1).
 *  - Why existing coverage misses it: the end-to-end answers are in test/engine-parity/labelled-only-policy.test.ts, which does not
 *    show which policy the store received or that a text outside the two parts is refused.
 *  - Seam: the store handle is a recorder (the store's own judgement is pinned in rust/crates/gbrain-store/tests/page_visibility.rs).
 */
import { describe, expect, test } from 'bun:test';
import { readLinkTargetPages } from '../src/core/rust-engine/store-members/remote-links.ts';
import type { WriterReadPolicy } from '../src/core/engine-sql/remote-links.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';

type Call = { sourceId: string; slugs: string[]; policy: Record<string, unknown> | null };

function recorder(): { brain: StoreBrain; calls: Call[] } {
  const calls: Call[] = [];
  const brain = { readLinkTargetPages: async (sourceId: string, slugs: string[], policy: Record<string, unknown> | null) => { calls.push({ sourceId, slugs, policy }); return []; } };
  return { brain: brain as unknown as StoreBrain, calls };
}

const writer = (over: Partial<WriterReadPolicy>): WriterReadPolicy => ({ identities: [['group:team', 'member:carol-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false, ...over });
const asked = async (policy: WriterReadPolicy) => {
  const { brain, calls } = recorder();
  const outcome = await readLinkTargetPages(brain, 'work', ['notes/open'], policy).then(() => 'served', (e: { code?: string }) => e.code);
  return { outcome, policy: calls[0]?.policy ?? null, calls: calls.length };
};

describe('readLinkTargetPages writer policy (Rust engine member)', () => {
  test('a labelled-only writer is served: the member-access policy for its identity, and the conjunct as the two sets the SQL embeds', async () => {
    const plain = await asked(writer({}));
    const labelled = await asked(writer({ labelledOnly: true }));
    expect(plain.outcome).toBe('served');
    expect(labelled.outcome).toBe('served');
    expect(plain.policy).not.toHaveProperty('labelledOnly');
    expect(labelled.policy).toEqual({ ...plain.policy, labelledOnly: { identity: ['group:team', 'member:carol-example'], satisfiedRuleIds: [] } });
  });

  test('a writer under folder rules it satisfies goes as a caller record, and the labelled-only conjunct holds the same rules', async () => {
    const satisfiedRuleIds = ['work:team'];
    const plain = await asked(writer({ satisfiedRuleIds }));
    const labelled = await asked(writer({ satisfiedRuleIds, labelledOnly: true }));
    expect(plain.outcome).toBe('served');
    expect(plain.policy).toMatchObject({ identity: ['group:team', 'member:carol-example'], satisfiedRuleIds, callerRecord: true });
    expect(labelled.policy).toEqual({ ...plain.policy, labelledOnly: { identity: ['group:team', 'member:carol-example'], satisfiedRuleIds } });
  });

  test('a rule id that is not a valid qualified id empties the set the SQL embeds, so the store gets none', async () => {
    const labelled = await asked(writer({ satisfiedRuleIds: ['not a rule'], labelledOnly: true }));
    expect(labelled.policy).toMatchObject({ labelledOnly: { satisfiedRuleIds: [] } });
  });

  test('a writer with several identities refuses with engine_capability_missing before the store is called, labelled-only or not', async () => {
    const identities = [['member:carol-example'], ['member:bob-example']];
    for (const labelledOnly of [false, true]) {
      expect(await asked(writer({ identities, labelledOnly }))).toEqual({ outcome: 'engine_capability_missing', policy: null, calls: 0 });
    }
  });

  test('one identity holding an invalid entry goes as the empty identity the SQL applies, never the raw entries', async () => {
    const mixed = [['member:carol-example', 'Bad Id']];
    const plain = await asked(writer({ identities: mixed }));
    expect(plain.outcome).toBe('served');
    expect(plain.policy).toMatchObject({ identity: [], callerRecord: true });
    expect(JSON.stringify(plain.policy)).not.toContain('carol-example');
    const labelled = await asked(writer({ identities: mixed, labelledOnly: true }));
    expect(labelled.policy).toEqual({ ...plain.policy, labelledOnly: { identity: [], satisfiedRuleIds: [] } });
  });

  test('an identity emptied by an invalid entry beside valid satisfied rules refuses before the store is called; an invalid rule id alone is served', async () => {
    const mixed = [['member:carol-example', 'Bad Id']];
    expect(await asked(writer({ identities: mixed, satisfiedRuleIds: ['work:team'] }))).toEqual({ outcome: 'engine_capability_missing', policy: null, calls: 0 });
    expect(await asked(writer({ identities: mixed, satisfiedRuleIds: ['work:team'], labelledOnly: true }))).toEqual({ outcome: 'engine_capability_missing', policy: null, calls: 0 });
    const rulesEmptied = await asked(writer({ identities: [['member:carol-example']], satisfiedRuleIds: ['work:team', 'not a rule'] }));
    expect(rulesEmptied.outcome).toBe('served');
    expect(rulesEmptied.policy).toMatchObject({ identity: ['member:carol-example'] });
    expect(rulesEmptied.policy).not.toHaveProperty('satisfiedRuleIds');
  });

  test('a mixed identity beside the owner flag refuses before the store is called', async () => {
    const mixed = [['member:carol-example', 'Bad Id']];
    expect(await asked(writer({ identities: mixed, owner: true }))).toEqual({ outcome: 'engine_capability_missing', policy: null, calls: 0 });
    expect(await asked(writer({ identities: mixed, owner: true, labelledOnly: true }))).toEqual({ outcome: 'engine_capability_missing', policy: null, calls: 0 });
  });

  test('the empty-identity fallback keeps the record\'s folder coverage', async () => {
    const folderCoverage = [{ source_id: 'work', prefix: 'team/' }];
    const served = await asked(writer({ identities: [['member:carol-example', 'Bad Id']], folderCoverage }));
    expect(served.outcome).toBe('served');
    expect(served.policy).toMatchObject({ identity: [], callerRecord: true, folderCoverage });
    expect(served.policy).not.toHaveProperty('satisfiedRuleIds');
  });

  test('an invalid identity with invalid satisfied rules (both sets emptied) is served as the no-identity form', async () => {
    const both = await asked(writer({ identities: [['member:carol-example', 'Bad Id']], satisfiedRuleIds: ['not a rule'] }));
    const none = await asked(writer({ identities: [] }));
    expect(both.outcome).toBe('served');
    expect(both.policy).toMatchObject({ identity: [], callerRecord: true });
    expect(both.policy).not.toHaveProperty('satisfiedRuleIds');
    expect(JSON.stringify(both.policy)).not.toContain('carol-example');
    expect(both.policy).toEqual(none.policy);
  });
});
