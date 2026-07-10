import { expect, test } from 'bun:test';
import { loadAdminReadmeMarkdown } from '../src/commands/serve-http.ts';

test('admin docs uses empty placeholder when README is unavailable', async () => {
  const readme = await loadAdminReadmeMarkdown([
    new URL('file:///C:/__pmbrain_missing_readme_for_test__/README.md'),
  ]);

  expect(readme.source).toBe('missing');
  expect(readme.markdown).toBe('暂无');
});
