/**
 * extract_atoms skips segmented pages, PGLite arm. Cases: test/helpers/extract-atoms-segmented-skip-cases.ts. Postgres
 * arm: test/e2e/extract-atoms-segmented-skip-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineExtractAtomsSegmentedSkipCases } from '../helpers/extract-atoms-segmented-skip-cases.ts';

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);

describe('extract_atoms skips segmented pages [pglite]', () => {
  defineExtractAtomsSegmentedSkipCases({ getBrain: () => brain });
});
