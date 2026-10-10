/**
 * Chunk boundaries pinned across a mixed CJK / Latin / emoji fuzz corpus.
 * The golden holds a hash of every case's chunks as produced by the
 * pre-linear word counter (master v0.60.130.0, before greedyMerge carried
 * running counts), so any boundary drift from the counting rewrite fails here.
 *
 * Regenerate (only for an intentional boundary change, which also needs a
 * MARKDOWN_CHUNKER_VERSION bump):
 *   GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/chunkers/recursive-word-count-golden.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chunkText } from '../../src/core/chunkers/recursive.ts';
import { fuzzCases } from './word-count-fuzz-corpus.ts';

const FILE = join(import.meta.dir, '..', 'fixtures', 'goldens', 'chunker', 'word-count-fuzz.json');
const UPDATE = process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1';
const SEED = 7301;
const COUNT = 1500;

describe('chunkText boundaries on the mixed-script fuzz corpus', () => {
  test('every case matches the golden captured before the linear word counter', () => {
    const hashes = fuzzCases(SEED, COUNT).map(c => {
      const chunks = chunkText(c.text, { chunkSize: c.chunkSize, chunkOverlap: c.chunkOverlap });
      return createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 16);
    });
    if (UPDATE) {
      mkdirSync(join(FILE, '..'), { recursive: true });
      writeFileSync(FILE, JSON.stringify({ seed: SEED, count: COUNT, hashes }, null, 0) + '\n');
    }
    const golden = JSON.parse(readFileSync(FILE, 'utf8')) as { seed: number; count: number; hashes: string[] };
    expect(golden.seed).toBe(SEED);
    const mismatched = hashes.flatMap((h, i) => (h === golden.hashes[i] ? [] : [i]));
    expect(mismatched).toEqual([]);
    expect(hashes.length).toBe(golden.count);
  }, 120_000);
});
