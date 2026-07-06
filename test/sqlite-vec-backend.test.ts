import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { tryLoadSqliteVec } from '../src/core/sqlite-vec-loader.ts';

const probe = new Database(':memory:');
const SQLITE_VEC_AVAILABLE = (await tryLoadSqliteVec(probe)) === 'sqlite-vec';
probe.close();

async function withEngine(prefix: string, fn: (engine: SQLiteEngine) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-sqlite-vec-${prefix}-`));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedEmbeddedPage(engine: SQLiteEngine, slug: string, title: string, vector: number[]) {
  await importFromContent(engine, slug, [
    '---',
    'type: concept',
    `title: ${title}`,
    '---',
    '# Compiled Truth',
    `${title} vector fixture content.`,
  ].join('\n'), { path: `${slug}.md` });
  const embedding = new Float32Array(vector);
  const blob = new Uint8Array(embedding.buffer.slice(0));
  const db = (engine as unknown as { database: Database }).database;
  db.run(
    `UPDATE content_chunks SET embedding = ?, embedded_at = datetime('now')
     WHERE page_id = (SELECT id FROM pages WHERE slug = ?)`,
    [blob, slug],
  );
  await engine.updatePageEmbedding(slug, embedding);
}

function forceBackend(engine: SQLiteEngine, backend: 'sqlite-vec' | 'js-fallback') {
  (engine as unknown as { vectorBackend: string }).vectorBackend = backend;
}

describe('sqlite-vec vector backend', () => {
  test('health reports the active vector backend honestly', async () => {
    await withEngine('health', async (engine) => {
      const health = await engine.getHealth();
      expect(health.vector_backend).toBe(SQLITE_VEC_AVAILABLE ? 'sqlite-vec' : 'js-fallback');
    });
  });

  test('js fallback ranks by cosine similarity and skips dimension mismatches', async () => {
    await withEngine('fallback', async (engine) => {
      forceBackend(engine, 'js-fallback');
      await seedEmbeddedPage(engine, 'concepts/vec-near', 'Vec Near', [1, 0, 0, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-mid', 'Vec Mid', [0.7, 0.7, 0, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-far', 'Vec Far', [0, 0, 1, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-broken', 'Vec Broken', [1, 0]);

      const results = await engine.searchVector(new Float32Array([1, 0, 0, 0]), { limit: 3 });
      expect(results.map((result) => result.slug)).toEqual([
        'concepts/vec-near',
        'concepts/vec-mid',
        'concepts/vec-far',
      ]);
      expect(results[0]!.score).toBeCloseTo(1, 5);
      expect(results.some((result) => result.slug === 'concepts/vec-broken')).toBe(false);
    });
  });

  test.skipIf(!SQLITE_VEC_AVAILABLE)('sqlite-vec fast path matches the js fallback ordering and scores', async () => {
    await withEngine('parity', async (engine) => {
      await seedEmbeddedPage(engine, 'concepts/vec-near', 'Vec Near', [1, 0, 0, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-mid', 'Vec Mid', [0.7, 0.7, 0, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-far', 'Vec Far', [0, 0, 1, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-broken', 'Vec Broken', [1, 0]);
      const query = new Float32Array([1, 0, 0, 0]);

      forceBackend(engine, 'sqlite-vec');
      const fast = await engine.searchVector(query, { limit: 3 });
      forceBackend(engine, 'js-fallback');
      const fallback = await engine.searchVector(query, { limit: 3 });

      expect(fast.map((result) => result.slug)).toEqual(fallback.map((result) => result.slug));
      for (const [index, result] of fast.entries()) {
        expect(result.score).toBeCloseTo(fallback[index]!.score, 4);
      }
      expect(fast.some((result) => result.slug === 'concepts/vec-broken')).toBe(false);
    });
  });

  test.skipIf(!SQLITE_VEC_AVAILABLE)('sqlite-vec fast path honors type and exclusion filters', async () => {
    await withEngine('filters', async (engine) => {
      await seedEmbeddedPage(engine, 'concepts/vec-near', 'Vec Near', [1, 0, 0, 0]);
      await seedEmbeddedPage(engine, 'concepts/vec-excluded', 'Vec Excluded', [1, 0, 0, 0]);
      forceBackend(engine, 'sqlite-vec');

      const results = await engine.searchVector(new Float32Array([1, 0, 0, 0]), {
        limit: 5,
        exclude_slugs: ['concepts/vec-excluded'],
      });
      expect(results.map((result) => result.slug)).toContain('concepts/vec-near');
      expect(results.map((result) => result.slug)).not.toContain('concepts/vec-excluded');

      const typed = await engine.searchVector(new Float32Array([1, 0, 0, 0]), {
        limit: 5,
        type: 'person',
      });
      expect(typed).toEqual([]);
    });
  });
});
