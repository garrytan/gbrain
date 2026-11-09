/**
 * Seeded property test of the conversation facts deletion invariant, Postgres arm, seeds 19 to 20 (PR 4 lane 4b round
 * 5). Cases and seed ranges: test/helpers/conversation-facts-property-cases.ts. PGLite arm:
 * test/large-pages/conversation-facts-property-seeds-19-20.test.ts.
 */
import { afterAll, beforeAll } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsPropertyCases, describePropertyRange } from '../helpers/conversation-facts-property-cases.ts';
import { hasDatabase } from './helpers.ts';

describePropertyRange(19, 'postgres', () => {
  let brain: AppendBrain;
  let fresh: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); fresh = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);
  defineConversationFactsPropertyCases({ getBrain: () => brain, getFresh: () => fresh, first: 19 });
}, hasDatabase());
