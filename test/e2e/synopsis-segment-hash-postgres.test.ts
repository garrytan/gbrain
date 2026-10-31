/**
 * Contextual synopsis per segment, Postgres arm (wave-b spec 8.6, PR 4 lane 4c). Cases:
 * test/helpers/synopsis-segment-hash-cases.ts. PGLite arm: test/large-pages/synopsis-segment-hash.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineSynopsisSegmentHashCases } from '../helpers/synopsis-segment-hash-cases.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('synopsis segment hash [postgres]', () => {
  let brain: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); }, 120_000);
  defineSynopsisSegmentHashCases({ getBrain: () => brain });
});
