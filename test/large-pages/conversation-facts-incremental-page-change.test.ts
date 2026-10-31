/**
 * Incremental conversation facts on a segmented page, PGLite arm: pages that change shape (wave-b spec 8.2, PR 4 lane
 * 4b). Cases: test/helpers/conversation-facts-recovery-cases.ts. Postgres arm:
 * test/e2e/conversation-facts-incremental-page-change-postgres.test.ts. One of eight files per engine, split by topic
 * so each fits the e2e per-file budget (scripts/run-e2e.sh); each opens its own brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsPageChangeCases } from '../helpers/conversation-facts-recovery-cases.ts';

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);

describe('conversation facts incremental, page-change [pglite]', () => {
  defineConversationFactsPageChangeCases({ getBrain: () => brain });
});
