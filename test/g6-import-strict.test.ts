/**
 * G6 (git-canonical memory): `gbrain import` on a strict (canonical: git) managed source is door-only.
 *
 * GBRA-176 found that a classic import rewrites the files it imports (it normalizes frontmatter order) and leaves the
 * rewrite uncommitted. On a strict source the managed import (import-mutations.ts importManagedFiles, prepared by
 * import-prepare.ts prepareManagedImportMutation) publishes through publishMutation / publishGroup, so the door must
 * commit exactly the bytes it writes: a file whose frontmatter the import normalizes and a file it leaves byte for byte
 * untouched, both already committed and both new to Git. After the batch every page is at HEAD with the bytes on disk,
 * the tree is clean, the git-gap census reports no gap, and the batch makes at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-import-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runImport } from '../src/commands/import.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

/** Frontmatter in an order the import rewrites: title before type, an extra key between them. */
const reordered = (title: string) => `---\ntitle: ${title}\nsummary: ${title} summary\ntype: note\n---\n\n${title} body.\n`;
/** The exact bytes the import renders for such a page, so it leaves the file untouched. */
const canonical = (title: string) => serializeMarkdown({}, `${title} body.`, '', { type: 'note', title, tags: [] });

const files: Record<string, string> = {
  'notes/alice-example-tracked-reordered.md': reordered('Alice example tracked'),
  'notes/acme-example-tracked-canonical.md': canonical('Acme example tracked'),
  'notes/alice-example-new-reordered.md': reordered('Alice example new'),
  'notes/acme-example-new-canonical.md': canonical('Acme example new'),
};
const slugs = Object.keys(files).map(path => path.replace(/\.md$/, ''));

for (const backend of testBackends()) describe(`[${backend}] G6: gbrain import on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('normalized and untouched files, committed and new: every page at HEAD, clean tree, no census gap, one commit per group', () => managedBrain(async ({ engine, root }) => {
    mkdirSync(join(root, 'notes'));
    for (const [path, bytes] of Object.entries(files)) writeFileSync(join(root, path), bytes);
    git(root, 'add', ...Object.keys(files).filter(path => path.includes('-tracked-')));
    git(root, 'commit', '-qm', 'user-authored notes');
    await strictSource(engine);
    const base = head(root);
    const result = await runImport(engine, [root, '--no-embed'], { sourceId: 'default' });
    expect(result).toMatchObject({ imported: slugs.length, errors: 0, failures: [] });
    const m = await measureBatch(engine, 'default', root, base, slugs);
    console.log(describeMeasure(`import/${backend}`, m));
    for (const [path, bytes] of Object.entries(files)) {
      const disk = readFileSync(join(root, path), 'utf8');
      console.log(`[G6 import/${backend}] ${path} rewritten=${disk !== bytes}`);
    }
    expect(readFileSync(join(root, 'notes/acme-example-new-canonical.md'), 'utf8')).toBe(files['notes/acme-example-new-canonical.md']);
    expect(readFileSync(join(root, 'notes/alice-example-new-reordered.md'), 'utf8')).not.toBe(files['notes/alice-example-new-reordered.md']);
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);
});
