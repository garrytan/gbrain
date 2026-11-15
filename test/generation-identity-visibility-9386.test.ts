import { describe, expect, test } from 'bun:test';
import { pageIdentityHash } from '../src/core/generations/adapters/page.ts';

const base = { type: 'atom', title: 'T', compiled_truth: 'body', timeline: '', tags: [] as string[] };

describe('generation identity and repair-visibility stamps (#9386)', () => {
  test('an explicit visibility stamp does not change the page identity', () => {
    const extractor = pageIdentityHash({ ...base, frontmatter: { extracted_by: 'extract_atoms-v0.41.2.1' } });
    const repaired = pageIdentityHash({ ...base, frontmatter: { extracted_by: 'extract_atoms-v0.41.2.1', visibility: 'private' } });
    expect(repaired).toBe(extractor);
  });
  test('a content edit still changes the identity', () => {
    const a = pageIdentityHash({ ...base, frontmatter: { visibility: 'private' } });
    const b = pageIdentityHash({ ...base, compiled_truth: 'edited', frontmatter: { visibility: 'private' } });
    expect(b).not.toBe(a);
  });
});
