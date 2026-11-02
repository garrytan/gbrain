/**
 * A2 folder rules: withFolderRestricted reads only what the privacy judgment needs.
 *
 * 1. Protects: a segmented page snapshot, whose compiled_truth getter throws, can be judged without reading its body.
 * 2. Fails when: withFolderRestricted spreads the whole page object again.
 */
import { expect, test } from 'bun:test';
import { withFolderRestricted } from '../src/core/search/private-visibility.ts';

test('withFolderRestricted never reads the page body', async () => {
  const page = { source_id: 'source-a', slug: 'notes/segmented', type: 'note', frontmatter: { visibility: 'world' } };
  Object.defineProperty(page, 'compiled_truth', { enumerable: true, get() { throw new Error('segmented body read'); } });
  const engine = { executeRaw: async () => [] } as never;
  const out = await withFolderRestricted(engine, page);
  expect(out).toEqual({ type: 'note', frontmatter: { visibility: 'world' }, folder_restricted: false });
});
