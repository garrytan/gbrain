/**
 * #5575 CEO-8: the pure import screen refuses content whose content hash
 * matches a prefetched page purge tombstone (managed sync then holds the file
 * as `purged_content`, with the owner's fix); edited content and an empty
 * tombstone map pass. No database.
 */
import { describe, expect, test } from 'bun:test';
import { screenImportContent } from '../src/core/import-screen.ts';
import { screenSyncImport } from '../src/core/persistence/sync-prepare.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHash } from '../src/core/utils.ts';

const CONTENT = '---\ntitle: Leaked key\ntype: note\n---\n# Leaked key\n\nThe key is AKIA-EXAMPLE-NOT-REAL.\n';

describe('purged-page import screen', () => {
  const hash = contentHash(parseMarkdown(CONTENT, 'notes/leaked-key.md', { validate: true }));
  const tombstones = new Map([[hash, 'notes/leaked-key']]);

  test('matching content is refused under any slug; edited content and no tombstones pass', () => {
    for (const path of ['notes/leaked-key.md', 'archive/renamed.md']) {
      const screen = screenImportContent({ content: CONTENT, path, purgedPages: tombstones });
      expect(screen.status).toBe('refused');
      if (screen.status === 'refused') {
        expect(screen.refusal.code).toBe('purged_content');
        expect(screen.refusal.message).not.toContain('AKIA');
      }
    }
    expect(screenImportContent({ content: CONTENT.replace('AKIA-EXAMPLE-NOT-REAL', 'rotated'), path: 'notes/leaked-key.md', purgedPages: tombstones }).status).toBe('importable');
    expect(screenImportContent({ content: CONTENT, path: 'notes/leaked-key.md' }).status).toBe('importable');
  });

  test('the managed sync screen holds it and the hold names the owner fix', () => {
    const { screen } = screenSyncImport({ content: CONTENT, rawHash: null, lineEndingOnly: false, slug: 'notes/leaked-key', sourcePath: 'notes/leaked-key.md',
      path: 'notes/leaked-key.md', root: '/nonexistent', snapshot: null, base: null, renamed: false, purgedPages: tombstones });
    expect(screen.status === 'refused' && screen.refusal.code).toBe('purged_content');
    const fix = gitHoldFix({ source_id: 'default', path: 'notes/leaked-key.md', code: 'purged_content', meta: { recovery_version: 1 } as never });
    expect(fix.argv).toEqual(['gbrain', 'pages', 'purges', 'list', '--source', 'default']);
    expect(fix.actor).toBe('user');
  });
});
