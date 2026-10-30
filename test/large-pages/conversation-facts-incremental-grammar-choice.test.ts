/**
 * Incremental conversation facts on a segmented page, PGLite arm: how long a --grammar choice lasts (wave-b spec 8.2,
 * PR 4 lane 4b). Cases: test/helpers/conversation-facts-invariant-cases.ts. Postgres arm:
 * test/e2e/conversation-facts-incremental-grammar-choice-postgres.test.ts. One of eight files per engine, split by
 * topic so each fits the e2e per-file budget (scripts/run-e2e.sh); each opens its own brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsGrammarChoiceCases } from '../helpers/conversation-facts-invariant-cases.ts';

let brain: AppendBrain;
let fresh: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); fresh = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);

describe('conversation facts incremental, grammar-choice [pglite]', () => {
  defineConversationFactsGrammarChoiceCases({ getBrain: () => brain, getFresh: () => fresh });
});
