/**
 * Seeded property test of the conversation facts deletion invariant, PGLite arm, seeds 9 to 10 (PR 4 lane 4b round 5).
 * Cases and seed ranges: test/helpers/conversation-facts-property-cases.ts. Postgres arm:
 * test/e2e/conversation-facts-property-seeds-09-10-postgres.test.ts.
 */
import { afterAll, beforeAll } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsPropertyCases, describePropertyRange } from '../helpers/conversation-facts-property-cases.ts';

describePropertyRange(9, 'pglite', () => {
  let brain: AppendBrain;
  let fresh: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('pglite'); fresh = await openAppendBrain('pglite'); }, 120_000);
  afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);
  defineConversationFactsPropertyCases({ getBrain: () => brain, getFresh: () => fresh, first: 9 });
});
