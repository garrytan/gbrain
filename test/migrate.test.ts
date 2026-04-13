import { describe, test, expect } from 'bun:test';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('migrate', () => {
  test('LATEST_VERSION is a number >= 1', () => {
    expect(typeof LATEST_VERSION).toBe('number');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('runMigrations is exported and callable', () => {
    expect(typeof runMigrations).toBe('function');
  });

  test('migration v5 drops old two-column link uniqueness regardless of constraint name', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await (engine as any).db.exec(`
        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO config (key, value) VALUES ('version', '4');
        CREATE TABLE pages (
          id SERIAL PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE
        );
        CREATE TABLE links (
          id SERIAL PRIMARY KEY,
          from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          to_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          link_type TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '',
          CONSTRAINT custom_old_pair_unique UNIQUE(from_page_id, to_page_id)
        );
        INSERT INTO pages (slug) VALUES ('people/alice'), ('companies/acme');
      `);

      await runMigrations(engine);

      await (engine as any).db.exec(`
        INSERT INTO links (from_page_id, to_page_id, link_type, context)
        VALUES (1, 2, 'employment', 'works at');
        INSERT INTO links (from_page_id, to_page_id, link_type, context)
        VALUES (1, 2, 'obsidian_link', '[[ACME]]');
      `);

      const { rows } = await (engine as any).db.query('SELECT count(*)::int AS count FROM links');
      expect((rows[0] as { count: number }).count).toBe(2);
    } finally {
      await engine.disconnect();
    }
  });
});
