/**
 * transcriptRoot (src/core/cycle/extract-atoms-generation.ts) says which
 * corpus root a transcript lies under, and that label becomes part of the
 * transcript's generation key. A transcript in a `..drafts` folder under the
 * meetings root must be labelled `meetings`.
 *
 * Authoring gate:
 * 1. Protects: a transcript at `<meetings>/..drafts/t.md` keeps the key
 *    `meetings/..drafts/t.md`; a transcript outside the meetings root (a plain
 *    folder, a `..` path that leaves it, or a sibling folder that shares the
 *    meetings root's name prefix) is still labelled `corpus`.
 * 2. Regression that fails it: the "inside the meetings root" test matching
 *    any relative path that starts with the two characters `..` instead of only
 *    a `..` path component. The transcript is then keyed `corpus/meetings/...`,
 *    so a run before and after the change would see it as a new, moved page.
 * 3. Why existing coverage misses it: no test calls transcriptRoot; the
 *    extract-atoms suites use transcripts directly under the roots. Corpus
 *    discovery prunes dot-folders, so production reaches this only through a
 *    transcript named explicitly (synthesize --input).
 * 4. Production seam: none. transcriptRoot and resolveTranscriptKeys are
 *    already exported; resolveTranscriptKeys gets a stub engine that holds no
 *    live generations.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { resolveTranscriptKeys, transcriptRoot } from '../src/core/cycle/extract-atoms-generation.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const CORPUS = '/work/corpus';
const MEETINGS = join(CORPUS, 'meetings');

describe('transcriptRoot with a transcript in a folder whose name starts with two dots', () => {
  test('a transcript under meetings/..drafts is labelled meetings', () => {
    expect(transcriptRoot(join(MEETINGS, '..drafts', 't.md'), CORPUS, MEETINGS)).toEqual({ path: MEETINGS, label: 'meetings' });
  });

  test('a transcript in a ..drafts folder directly under the corpus root is labelled corpus', () => {
    expect(transcriptRoot(join(CORPUS, '..drafts', 't.md'), CORPUS, MEETINGS)).toEqual({ path: CORPUS, label: 'corpus' });
  });

  test('the generation key of a meetings/..drafts transcript keeps the meetings label and its folder', async () => {
    const file = join(MEETINGS, '..drafts', 't.md');
    const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
    const keys = await resolveTranscriptKeys(engine, 'default',
      [{ filePath: file, contentHash: 'h1', root: transcriptRoot(file, CORPUS, MEETINGS) }], true);
    expect(keys.get(file)).toBe('meetings/..drafts/t.md');
  });
});

describe('transcriptRoot still labels a transcript outside the meetings root as corpus', () => {
  test('a transcript directly under the meetings root is labelled meetings', () => {
    expect(transcriptRoot(join(MEETINGS, 't.md'), CORPUS, MEETINGS).label).toBe('meetings');
  });

  test('a transcript in a plain folder beside the meetings root is labelled corpus', () => {
    expect(transcriptRoot(join(CORPUS, 'notes', 't.md'), CORPUS, MEETINGS).label).toBe('corpus');
  });

  test('a transcript in a sibling folder that shares the meetings root name prefix is labelled corpus', () => {
    expect(transcriptRoot(join(CORPUS, 'meetings2', 't.md'), CORPUS, MEETINGS).label).toBe('corpus');
  });

  test('a path that climbs out of the meetings root with .. is labelled corpus', () => {
    expect(transcriptRoot(join(MEETINGS, '..', 't.md'), CORPUS, MEETINGS).label).toBe('corpus');
  });

  test('with no meetings root every transcript is labelled corpus', () => {
    expect(transcriptRoot(join(CORPUS, '..drafts', 't.md'), CORPUS, undefined).label).toBe('corpus');
  });
});
