import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

const putPage = operations.find(op => op.name === 'put_page');

const content = [
  '---',
  'title: Test Page',
  'type: concept',
  '---',
  '',
  '# Test Page',
  '',
  'Reusable knowledge.',
].join('\n');

describe('put_page slug quality', () => {
  test('rejects vague and underspecified durable slugs before writing', async () => {
    expect(putPage).toBeDefined();

    for (const slug of [
      'readme',
      'docs/reference/90',
      'docs/archive/sync-pipeline',
      'projects/mbrain/docs/123',
      'docs/_pro___',
    ]) {
      await expect(putPage!.handler({ dryRun: true } as any, { slug, content }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    }
  });

  test('allows project-scoped descriptive documentation slugs', async () => {
    expect(putPage).toBeDefined();

    await expect(putPage!.handler(
      { dryRun: true } as any,
      { slug: 'projects/mbrain/docs/manual/06-sync-pipeline', content, expected_content_hash: null },
    )).resolves.toEqual({
      dry_run: true,
      action: 'put_page',
      slug: 'projects/mbrain/docs/manual/06-sync-pipeline',
    });
  });
});
