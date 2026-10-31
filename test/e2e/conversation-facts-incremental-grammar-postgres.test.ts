/**
 * Incremental conversation facts on a segmented page, Postgres arm: which grammar a run reads (F3, G1, p7, R3) (wave-b
 * spec 8.2, PR 4 lane 4b), including the facts.source_window double-encoding check (jsonb_typeof = 'object') PGLite
 * can't catch. Cases: test/helpers/conversation-facts-invariant-cases.ts. PGLite arm:
 * test/large-pages/conversation-facts-incremental-grammar.test.ts. One of eight files per engine, split by topic so
 * each fits the e2e per-file budget (scripts/run-e2e.sh); each opens its own brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsGrammarCases } from '../helpers/conversation-facts-invariant-cases.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('conversation facts incremental, grammar [postgres]', () => {
  let brain: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); }, 120_000);
  defineConversationFactsGrammarCases({ getBrain: () => brain });
});
