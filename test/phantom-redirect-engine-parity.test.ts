/**
 * v0.35.5 — engine parity for `refreshPageBody` + `migrateFactsToCanonical`.
 *
 * These two new BrainEngine methods land in BOTH PGLite + Postgres. The
 * production cycle calls them transparently via the engine interface, so
 * the redirect pass MUST behave byte-equivalently across engines.
 *
 * PGLite-half always runs (hermetic). Postgres-half runs only when
 * `DATABASE_URL` is set — same gate as the other E2E tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL });
    await pg.initSchema();
  }
});

afterAll(async () => {
  await pglite.disconnect();
  if (pg) await pg.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(pglite);
  if (pg) {
    // Postgres reset: TRUNCATE the tables this test uses (pages + facts).
    // Avoid TRUNCATE on sources — other concurrent E2E tests might rely on it.
    await pg.executeRaw('TRUNCATE TABLE facts RESTART IDENTITY CASCADE');
    await pg.executeRaw('DELETE FROM pages');
  }
});

async function seed(engine: BrainEngine, slug: string, body: string, type = 'person'): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type: type as any,
    compiled_truth: body,
    frontmatter: {},
    timeline: '',
  });
}

// ─── refreshPageBody parity ─────────────────────────────────────────

describe('refreshPageBody (parity)', () => {
  test('updates compiled_truth + timeline + content_hash; skips soft-deleted', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await seed(engine, 'people/alice', '# alice\n\nOriginal body.');

      await engine.refreshPageBody(
        'people/alice',
        'default',
        '# alice\n\nNew compiled body.',
        '## History\n\nNew timeline.',
        'newhash123',
      );

      const fetched = await engine.getPage('people/alice', { sourceId: 'default' });
      expect(fetched?.compiled_truth).toBe('# alice\n\nNew compiled body.');
      expect(fetched?.timeline).toBe('## History\n\nNew timeline.');
      expect(fetched?.content_hash).toBe('newhash123');
    }
  });

  test('no-op when slug is soft-deleted', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await seed(engine, 'people/alice', '# alice\n\nOriginal.');
      await engine.softDeletePage('people/alice', { sourceId: 'default' });

      await engine.refreshPageBody('people/alice', 'default', 'new body', 'new tl', 'newhash');

      // Re-read directly (getPage filters soft-deleted)
      const rows = await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(
        `SELECT compiled_truth, content_hash FROM pages WHERE slug='people/alice' AND source_id='default'`,
      );
      expect(rows[0]?.compiled_truth).toBe('# alice\n\nOriginal.');
      expect(rows[0]?.content_hash).not.toBe('newhash');
    }
  });

  test('source-scoped — does not touch other sources', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('other', 'parity-other') ON CONFLICT (id) DO NOTHING`,
      );
      await seed(engine, 'people/alice', '# default-alice\n');
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, content_hash, frontmatter)
         VALUES ('people/alice', 'other', 'person', 'alice', '# other-alice', '', 'oh', '{}'::jsonb)`,
      );

      await engine.refreshPageBody('people/alice', 'default', 'updated', '', 'newhash');

      const otherRow = await engine.executeRaw<{ compiled_truth: string }>(
        `SELECT compiled_truth FROM pages WHERE slug='people/alice' AND source_id='other'`,
      );
      expect(otherRow[0].compiled_truth).toBe('# other-alice'); // unchanged

      // Cleanup the cross-source row before next engine
      await engine.executeRaw(`DELETE FROM pages WHERE source_id='other'`);
      await engine.executeRaw(`DELETE FROM sources WHERE id='other'`);
    }
  });
});

// ─── migrateFactsToCanonical parity ─────────────────────────────────

describe('migrateFactsToCanonical (parity)', () => {
  test('moves active facts from phantom → canonical, preserving every column', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await seed(engine, 'alice', '# alice\n');
      await seed(engine, 'people/alice-example', '# alice-example\n');

      await engine.executeRaw(
        `INSERT INTO facts (
           source_id, entity_slug, fact, kind, visibility, notability, valid_from,
           source, source_session, confidence, source_markdown_slug, row_num, context
         ) VALUES (
           'default', 'alice', 'Founded Acme', 'fact', 'private', 'high', '2017-01-01'::date,
           'linkedin', 'sess-1', 0.95, 'alice', 1, 'important context'
         )`,
      );

      const r = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      expect(r.migrated).toBe(1);

      const moved = await engine.executeRaw<{
        entity_slug: string; source_markdown_slug: string; fact: string;
        visibility: string; notability: string; confidence: number;
        source: string; source_session: string; context: string;
      }>(
        `SELECT entity_slug, source_markdown_slug, fact, visibility, notability, confidence,
                source, source_session, context
         FROM facts WHERE source_id='default'`,
      );
      expect(moved.length).toBe(1);
      expect(moved[0].entity_slug).toBe('people/alice-example');
      expect(moved[0].source_markdown_slug).toBe('people/alice-example');
      expect(moved[0].fact).toBe('Founded Acme');
      expect(moved[0].visibility).toBe('private');
      expect(moved[0].notability).toBe('high');
      expect(moved[0].confidence).toBe(0.95);
      expect(moved[0].source).toBe('linkedin');
      expect(moved[0].source_session).toBe('sess-1');
      expect(moved[0].context).toBe('important context');
    }
  });

  test('idempotent: re-run returns {migrated: 0}', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await seed(engine, 'alice', '# alice\n');
      await seed(engine, 'people/alice-example', '# alice-example\n');
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, valid_from, source, source_markdown_slug, row_num)
         VALUES ('default', 'alice', 'A', 'fact', '2020-01-01'::date, 'manual', 'alice', 1)`,
      );

      const r1 = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      expect(r1.migrated).toBe(1);

      const r2 = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      expect(r2.migrated).toBe(0);
    }
  });

  test('skips expired rows (audit trail preserved)', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      await seed(engine, 'alice', '# alice\n');
      await seed(engine, 'people/alice-example', '# alice-example\n');
      // One active + one expired
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, valid_from, source, source_markdown_slug, row_num)
         VALUES ('default', 'alice', 'Active', 'fact', '2020-01-01'::date, 'm', 'alice', 1)`,
      );
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, valid_from, source, source_markdown_slug, row_num, expired_at)
         VALUES ('default', 'alice', 'Expired', 'fact', '2020-01-01'::date, 'm', 'alice', 2, now())`,
      );

      const r = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      expect(r.migrated).toBe(1); // only the active row moved

      const rows = await engine.executeRaw<{ fact: string; entity_slug: string }>(
        `SELECT fact, entity_slug FROM facts WHERE source_id='default' ORDER BY fact`,
      );
      const facts = rows.reduce<Record<string, string>>((acc, r) => {
        acc[r.fact] = r.entity_slug;
        return acc;
      }, {});
      expect(facts['Active']).toBe('people/alice-example');
      expect(facts['Expired']).toBe('alice'); // audit trail intact
    }
  });
});
