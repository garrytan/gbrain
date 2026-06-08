import { describe, test, expect } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copySourceRowsForMigration } from '../src/commands/migrate-engine.ts';

describe('migrate-engine source row copy', () => {
  test('copies non-default sources before page import so FK-backed page writes succeed', async () => {
    const source = new PGLiteEngine();
    const target = new PGLiteEngine();

    try {
      await source.connect({});
      await source.initSchema();
      await target.connect({});
      await target.initSchema();

      await source.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
           VALUES ('wiki', 'Wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
      );
      await source.putPage(
        'people/alice',
        { type: 'person', title: 'Alice', compiled_truth: 'Alice source page', timeline: '' },
        { sourceId: 'wiki' },
      );

      await expect(
        target.putPage(
          'people/alice',
          { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
          { sourceId: 'wiki' },
        ),
      ).rejects.toThrow();

      const copied = await copySourceRowsForMigration(source, target);
      expect(copied).toBe(2);

      const sourceRows = await target.executeRaw<{ id: string; name: string; local_path: string | null }>(
        `SELECT id, name, local_path FROM sources ORDER BY id`,
      );
      expect(sourceRows.map((r) => r.id).sort()).toEqual(['default', 'wiki']);

      const wiki = sourceRows.find((r) => r.id === 'wiki');
      expect(wiki?.name).toBe('Wiki');
      expect(wiki?.local_path).toBe('/tmp/wiki');

      const page = await target.putPage(
        'people/alice',
        { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
        { sourceId: 'wiki' },
      );
      expect(page.source_id).toBe('wiki');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  }, 60_000);
});
