/**
 * Incremental conversation facts on a segmented page, PGLite arm: append, retirement, cap, spend and unpriced-model
 * cases (wave-b spec 8.2, PR 4 lane 4b). Cases: test/helpers/conversation-facts-incremental-cases.ts,
 * test/helpers/derivation-spend-cases.ts, test/helpers/derivation-unpriced-cases.ts. Postgres arm:
 * test/e2e/conversation-facts-incremental-core-postgres.test.ts. One of eight files per engine, split by topic so each
 * fits the e2e per-file budget (scripts/run-e2e.sh); each opens its own brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsIncrementalCases, defineSegmentReceiptDoctorCases, defineSegmentedBackstopCases } from '../helpers/conversation-facts-incremental-cases.ts';
import { defineDerivationSpendCases } from '../helpers/derivation-spend-cases.ts';
import { defineDerivationUnpricedCases } from '../helpers/derivation-unpriced-cases.ts';

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);

describe('conversation facts incremental, core [pglite]', () => {
  defineConversationFactsIncrementalCases({ getBrain: () => brain });
  defineSegmentedBackstopCases({ getBrain: () => brain });
  defineSegmentReceiptDoctorCases({ getBrain: () => brain });
  defineDerivationSpendCases({ getBrain: () => brain });
  defineDerivationUnpricedCases({ getBrain: () => brain });
});
