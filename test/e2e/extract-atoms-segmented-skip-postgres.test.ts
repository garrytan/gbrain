/**
 * extract_atoms skips segmented pages, Postgres arm. Cases: test/helpers/extract-atoms-segmented-skip-cases.ts. PGLite
 * arm: test/large-pages/extract-atoms-segmented-skip.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineExtractAtomsSegmentedSkipCases } from '../helpers/extract-atoms-segmented-skip-cases.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('extract_atoms skips segmented pages [postgres]', () => {
  let brain: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); }, 120_000);
  defineExtractAtomsSegmentedSkipCases({ getBrain: () => brain });
});
