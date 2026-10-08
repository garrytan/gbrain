import type { Migration } from './types.ts';
import { PINNED_QUESTIONS_SCHEMA_SQL } from '../questions/schema.ts';
import { migrateAutoThinkToPins } from '../questions/auto-think-migration.ts';

// Pinned questions (C4): the pinned_questions and question_evidence tables
// (DDL in src/core/questions/schema.ts), then the dream.auto_think config
// keys become pins. The handler reads config only: no provider call, no page
// write, and a second run changes nothing.
export const v220: Migration = {
  version: 220,
  name: 'pinned_questions',
  idempotent: true,
  sql: PINNED_QUESTIONS_SCHEMA_SQL,
  handler: async (engine) => { await migrateAutoThinkToPins(engine); },
};
