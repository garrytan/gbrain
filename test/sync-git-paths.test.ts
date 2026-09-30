import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { gitRelativePath } from '../src/core/sync-git.ts';
import { planReconcileDeletes } from '../src/core/sync-reconcile.ts';
import { buildSyncManifest } from '../src/core/sync.ts';

describe('Git-relative sync scope paths (#5108)', () => {
  for (const [name, paths, root] of [
    ['Windows drive', win32, 'C:\\repo'],
    ['Windows UNC', win32, '\\\\server\\share\\repo'],
    ['POSIX', posix, '/repo'],
  ] as const) {
    test(`${name}: nested scopes match Git paths without admitting siblings`, () => {
      const scope = gitRelativePath(root, paths.join(root, 'docs', 'brain'), paths);
      expect(scope).toBe('docs/brain');
      const manifest = buildSyncManifest([
        'A\tdocs/brain/added.md',
        'M\tdocs/brain/nested/changed.md',
        'D\tdocs/brain/deleted.md',
        'R100\tdocs/brain/old.md\tdocs/brain/new.md',
        'A\tdocs/brain-other/outside.md',
        'M\tdocs/other/outside.md',
        'D\toutside.md',
      ].join('\n'));
      const inScope = (p: string) => p === scope || p.startsWith(scope + '/');
      expect(manifest.added.filter(inScope)).toEqual(['docs/brain/added.md']);
      expect(manifest.modified.filter(inScope)).toEqual(['docs/brain/nested/changed.md']);
      expect(manifest.deleted.filter(inScope)).toEqual(['docs/brain/deleted.md']);
      expect(manifest.renamed.filter(r => inScope(r.to))).toEqual([
        { from: 'docs/brain/old.md', to: 'docs/brain/new.md' },
      ]);
      expect(manifest.modified[0]!.slice(scope.length + 1)).toBe('nested/changed.md');
    });

    test(`${name}: root scopes stay empty, including trailing separators`, () => {
      expect(gitRelativePath(root, root, paths)).toBe('');
      expect(gitRelativePath(root + paths.sep, root, paths)).toBe('');
    });

    test(`${name}: full reconcile normalizes scope and stored paths before filtering`, () => {
      const scopePrefix = gitRelativePath(root, paths.join(root, 'docs', 'brain'), paths) + '/';
      const plan = planReconcileDeletes([
        { slug: 'present', source_path: 'docs/brain/present.md' },
        { slug: 'gone-posix', source_path: 'docs/brain/gone-posix.md' },
        { slug: 'gone-windows', source_path: 'docs\\brain\\gone-windows.md' },
        { slug: 'other-source', source_path: 'docs/brain-other/outside.md' },
        { slug: 'other-strategy', source_path: 'docs/brain/code.ts' },
      ], [paths.join('docs', 'brain', 'present.md')],
      p => p.startsWith(scopePrefix) && p.endsWith('.md'));
      expect(plan.staleSlugs).toEqual(['gone-posix', 'gone-windows']);
      expect(plan.reconcilableCount).toBe(3);
      expect(plan.massDelete).toBe(false);
    });
  }
});
