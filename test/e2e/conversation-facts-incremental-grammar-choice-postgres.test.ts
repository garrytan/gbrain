/**
 * Incremental conversation facts on a segmented page, Postgres arm: how long a --grammar choice lasts (wave-b spec 8.2,
 * PR 4 lane 4b), including the facts.source_window double-encoding check (jsonb_typeof = 'object') PGLite can't catch.
 * Cases: test/helpers/conversation-facts-invariant-cases.ts. PGLite arm:
 * test/large-pages/conversation-facts-incremental-grammar-choice.test.ts. One of eight files per engine, split by topic
 * so each fits the e2e per-file budget (scripts/run-e2e.sh); each opens its own brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsGrammarChoiceCases } from '../helpers/conversation-facts-invariant-cases.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('conversation facts incremental, grammar-choice [postgres]', () => {
  let brain: AppendBrain;
  let fresh: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); fresh = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);
  defineConversationFactsGrammarChoiceCases({ getBrain: () => brain, getFresh: () => fresh });
});
