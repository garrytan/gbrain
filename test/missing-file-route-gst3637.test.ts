// Value: protects=missingFileRoute's in_head/unknown routes keep the page by restoring the file and never offer ghost-pages as the remover; fails_when=the old "remove the page with gbrain repair ghost-pages" route text returns; why_new=no test names missingFileRoute; seam=none; no_claim=git state detection (state passed in directly; unit only)
import { describe, expect, test } from 'bun:test';
import { missingFileRoute } from '../src/core/persistence/reconcile-state.ts';

describe('missingFileRoute (gst3637)', () => {
  test('in_head: restore to keep, commit to remove, ghost-pages removes nothing', () => {
    const route = missingFileRoute('src-a', 'people/alice-example', 'people/alice-example.md', 'in_head');
    expect(route).toContain("git checkout HEAD -- 'people/alice-example.md'");
    expect(route).toContain('commit the deletion and sync');
    expect(route).toContain('removes nothing while HEAD still holds the file');
    expect(route).not.toMatch(/remove the page with gbrain repair ghost-pages/);
  });

  test('unknown: worktree-only deletion routes to restore or commit, not ghost-pages', () => {
    const route = missingFileRoute('src-a', 'people/alice-example', 'people/alice-example.md', 'unknown' as never);
    expect(route).toContain('Git could not say');
    expect(route).toContain("git checkout HEAD -- 'people/alice-example.md'");
    expect(route).not.toContain('gbrain repair ghost-pages');
  });

  test('gone: still routes to file-drift preview', () => {
    const route = missingFileRoute('src-a', 'people/alice-example', 'people/alice-example.md', 'gone');
    expect(route).toContain('gbrain repair file-drift --source src-a --slug people/alice-example --prefer database');
  });
});
