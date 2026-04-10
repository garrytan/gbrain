import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import postgres from 'postgres';
import { getPGliteDataDir, resolveImportWorkerCount, startPGliteBridge } from '../src/core/pglite.ts';

const cleanupPaths = new Set<string>();

function makeTempPath(name: string): string {
  const path = join(tmpdir(), `gbrain-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanupPaths.add(path);
  return path;
}

afterEach(() => {
  for (const path of cleanupPaths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('pglite path handling', () => {
  test('maps configured file path to an internal pglite data dir', () => {
    expect(getPGliteDataDir('/tmp/brain.db')).toBe('/tmp/brain.db.pglite');
  });

  test('expands tilde-prefixed file paths into the user home directory', () => {
    expect(getPGliteDataDir('~/.gbrain/brain.db')).toContain('/.gbrain/brain.db.pglite');
    expect(getPGliteDataDir('~/.gbrain/brain.db')).not.toContain('/~/.gbrain/brain.db.pglite');
  });
});

describe('embedded import worker policy', () => {
  test('forces single-worker import in pglite mode', () => {
    expect(resolveImportWorkerCount(4, { engine: 'pglite', database_path: '/tmp/brain.db' })).toBe(1);
  });

  test('keeps requested worker count for postgres mode', () => {
    expect(resolveImportWorkerCount(4, { engine: 'postgres', database_url: 'postgresql://example' })).toBe(4);
  });
});

describe('pglite socket bridge', () => {
  test('supports postgres client queries plus vector/trgm/trigger features', async () => {
    const databasePath = makeTempPath('brain.db');
    const bridge = await startPGliteBridge(databasePath);
    const sql = postgres(bridge.connectionString, { max: 1, idle_timeout: 1, connect_timeout: 5 });

    try {
      const one = await sql`SELECT 1 as n`;
      expect(one[0].n).toBe(1);

      await sql.unsafe(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          embedding vector(3),
          search_vector tsvector,
          touched_at TIMESTAMPTZ
        );

        CREATE INDEX idx_items_title_trgm ON items USING GIN(title gin_trgm_ops);
        CREATE INDEX idx_items_embedding ON items USING hnsw (embedding vector_cosine_ops);

        CREATE OR REPLACE FUNCTION touch_items() RETURNS trigger AS $$
        BEGIN
          NEW.touched_at := now();
          NEW.search_vector := to_tsvector('english', NEW.title);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER trg_touch_items
          BEFORE INSERT OR UPDATE ON items
          FOR EACH ROW
          EXECUTE FUNCTION touch_items();
      `);

      await sql.unsafe(`INSERT INTO items (title, embedding) VALUES ('hello world', '[1,2,3]'::vector)`);
      const rows = await sql.unsafe(`SELECT title, touched_at IS NOT NULL AS touched, search_vector::text AS sv FROM items`);
      expect(rows[0].title).toBe('hello world');
      expect(rows[0].touched).toBe(true);
      expect(String(rows[0].sv)).toContain('hello');
    } finally {
      await sql.end();
      await bridge.stop();
    }
  }, 30000);
});
