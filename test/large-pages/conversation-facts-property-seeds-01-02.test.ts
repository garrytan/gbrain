/**
 * Seeded property test of the conversation facts deletion invariant, PGLite arm, seeds 1 to 2 (PR 4 lane 4b round 5).
 * Cases and seed ranges: test/helpers/conversation-facts-property-cases.ts. Postgres arm:
 * test/e2e/conversation-facts-property-seeds-01-02-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsPropertyCases } from '../helpers/conversation-facts-property-cases.ts';

let brain: AppendBrain;
let fresh: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); fresh = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);

describe('conversation facts deletion invariant, seeds 1 to 2 [pglite]', () => {
  defineConversationFactsPropertyCases({ getBrain: () => brain, getFresh: () => fresh, first: 1 });
});
