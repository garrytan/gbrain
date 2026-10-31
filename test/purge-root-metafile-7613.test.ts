import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedBrain } from './helpers/managed-brain.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';

test('retention purge preserves root scaffolding and refuses drift in a nested page', async () => {
  await managedBrain(async ({ engine, root }) => {
    const bytes = '# Checkout guide\n\nUnrelated current content.\n';
    mkdirSync(join(root, 'notes'));
    for (const path of ['README.md', 'notes/README.md']) writeFileSync(join(root, path), bytes);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      for (const [slug, path] of [['readme', 'README.md'], ['notes/readme', 'notes/README.md']]) {
        await engine.putPage(slug!, { type: 'note', title: 'Old page', compiled_truth: 'Old imported content.', frontmatter: {}, source_path: path! }, { sourceId: 'default' });
      }
      await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id='default'");
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
    const result = await purgeDeletedPagesCoordinated(engine, 72);
    expect(result.slugs).toEqual(['readme']);
    expect(result.blocked).toEqual([expect.objectContaining({ slug: 'notes/readme', code: 'source_changed' })]);
    const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default'");
    expect(rows.map(row => row.slug)).toEqual(['notes/readme']);
    for (const path of ['README.md', 'notes/README.md']) expect(readFileSync(join(root, path), 'utf8')).toBe(bytes);
  });
}, 120_000);
