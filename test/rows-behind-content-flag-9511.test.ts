import { describe, expect, test } from 'bun:test';
import { compareInlineExportFile } from '../src/core/persistence/git-gap.ts';
import type { ExportSnapshot } from '../src/core/export-snapshot.ts';

describe('database-only safety markers are not drift (#9511)', () => {
  test('a row carrying content_flag compares equal to its flagless committed file', () => {
    const file = '---\ntype: note\ntitle: Flagged\n---\n\nBody.\n';
    const snapshot = {
      page: { slug: 'flagged', type: 'note', title: 'Flagged', compiled_truth: 'Body.', timeline: '',
        frontmatter: { content_flag: { kind: 'instruction_like', assessed_at: '2026-01-01T00:00:00Z' } } },
      tags: [],
    } as unknown as ExportSnapshot;
    expect(compareInlineExportFile(Buffer.from(file), 'flagged.md', snapshot)).toEqual({ state: 'equal' });
  });
});
