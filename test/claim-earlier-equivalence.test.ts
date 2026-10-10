/**
 * GBRA-69: the write claim's root probe (journal.ts `claimableWriteSql`) claims
 * the same rows in the same order as the former COALESCE-keyed predicate.
 * Postgres arm, with the index-scan probe: test/e2e/claim-earlier-equivalence.test.ts.
 */
import { expect, test } from 'bun:test';
import { compareClaimOrders } from './helpers/claim-earlier-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

test('PGLite: the indexed root probe claims what the COALESCE key claimed, in the same order', async () => {
  const { engine, close } = await isolatedSharedSkillsEngine();
  try {
    const cases = await compareClaimOrders(engine);
    expect(cases.filter(c => c.former.length > 0).length).toBeGreaterThan(cases.length / 2);
    expect(cases.filter(c => c.former.length > 1).length).toBeGreaterThan(cases.length / 8);
    for (const c of cases) expect({ seed: c.seed, priority: c.priority, lanes: c.lanes, order: c.current }).toEqual({ seed: c.seed, priority: c.priority, lanes: c.lanes, order: c.former });
  } finally { await close(); }
}, 120_000);
