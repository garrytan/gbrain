/**
 * The Rust engine's readPageAccessAllowed and readPageFolderRulesAllowed members (src/core/rust-engine/store-members/list-reads.ts):
 * which identity and satisfied-rule sets they send the store, with a stand-in store that records its arguments.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the SQL text empties a WHOLE identity or satisfied set when any entry is invalid (readersAllowedSql, folderRulesAllowedSql),
 *    so the members send the store the sets the SQL applies (`sqlAppliedSets`); a valid set goes as given.
 *  - Regression: both members forwarded the raw set, so the store matched the valid entries one by one and admitted a page the SQL denies.
 *  - Why existing coverage misses it: list-reads-sql-pin.test.ts asks with valid sets only; the end-to-end answer is in
 *    test/engine-parity/mixed-set-forwarding.test.ts, which needs the addon and does not show what the store received.
 *  - Seam: the store handle is a recorder (the store's own judgement is pinned by the parity case above).
 */
import { describe, expect, test } from 'bun:test';
import { readPageAccessAllowed, readPageFolderRulesAllowed } from '../src/core/rust-engine/store-members/list-reads.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';

type Call = { member: string; set: string[]; policy: Record<string, unknown> };
function recorder(): { brain: StoreBrain; calls: Call[] } {
  const calls: Call[] = [];
  const record = (member: string) => async (_s: string, _p: string, set: string[], policy: Record<string, unknown>) => { calls.push({ member, set, policy }); return true; };
  return { brain: { readPageAccessAllowed: record('readPageAccessAllowed'), readPageFolderRulesAllowed: record('readPageFolderRulesAllowed') } as unknown as StoreBrain, calls };
}
const RECORD = { identity: ['member:alice-example'], satisfiedRuleIds: ['work:team-rule'], folderCoverage: [], restricted: true, owner: false };
const sent = async (member: 'readPageAccessAllowed' | 'readPageFolderRulesAllowed', set: string[]) => {
  const { brain, calls } = recorder();
  await withCallerAccess(RECORD, () => member === 'readPageAccessAllowed' ? readPageAccessAllowed(brain, 'work', 'a', set) : readPageFolderRulesAllowed(brain, 'work', 'a', set));
  return calls[0]!;
};

describe('readPageAccessAllowed / readPageFolderRulesAllowed (Rust engine members): the sets the SQL applies go to the store', () => {
  test('a valid identity goes as given', async () => {
    const call = await sent('readPageAccessAllowed', ['member:alice-example']);
    expect(call.set).toEqual(['member:alice-example']);
    expect(call.policy).toMatchObject({ identity: ['member:alice-example'], satisfiedRuleIds: ['work:team-rule'] });
  });

  test('an identity that mixes a valid and an invalid entry goes as the empty set, in the argument and in the policy', async () => {
    const call = await sent('readPageAccessAllowed', ['member:alice-example', 'Bad Id']);
    expect(call.set).toEqual([]);
    expect(call.policy).toMatchObject({ identity: [] });
    expect(JSON.stringify(call)).not.toContain('alice-example');
  });

  test('a valid satisfied set goes as given', async () => {
    const call = await sent('readPageFolderRulesAllowed', ['work:team-rule']);
    expect(call.set).toEqual(['work:team-rule']);
    expect(call.policy).toMatchObject({ satisfiedRuleIds: ['work:team-rule'] });
  });

  test('a satisfied set that mixes a valid and an invalid rule id goes as the empty set, in the argument and in the policy', async () => {
    const call = await sent('readPageFolderRulesAllowed', ['work:team-rule', 'Bad Id']);
    expect(call.set).toEqual([]);
    expect(call.policy).toMatchObject({ satisfiedRuleIds: [] });
    expect(JSON.stringify(call)).not.toContain('team-rule');
  });
});
