import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const sqliteRoot = mkdtempSync(join(tmpdir(), 'mbrain-page-projection-sqlite-'));
let sqlite: SQLiteEngine;
let pglite: PGLiteEngine;

beforeAll(async () => {
  sqlite = new SQLiteEngine();
  await sqlite.connect({ engine: 'sqlite', database_path: join(sqliteRoot, 'brain.db') });
  await sqlite.initSchema();

  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
});

afterAll(async () => {
  await sqlite.disconnect();
  await pglite.disconnect();
  rmSync(sqliteRoot, { recursive: true, force: true });
});

async function seedProjectionPage(engine: BrainEngine, slug: string) {
  return engine.putPage(slug, {
    type: 'concept',
    title: 'Projection Page',
    compiled_truth: 'A😀BCe\u0301FGHI',
    timeline: 'T😀UVWX',
    frontmatter: { source: 'projection-test' },
    content_hash: `hash-${slug}`,
  });
}

async function expectProjectionContract(engine: BrainEngine, slug: string): Promise<void> {
  const full = await seedProjectionPage(engine, slug);
  const projection = await engine.getPageProjection(slug, {
    windows: {
      compiled_truth: { char_start: 1, char_limit: 4 },
      timeline: { char_start: 0, char_limit: 3 },
    },
  });

  expect(projection).not.toBeNull();
  expect(projection!.slug).toBe(slug);
  expect(projection!.title).toBe('Projection Page');
  expect(projection!.frontmatter).toEqual({ source: 'projection-test' });
  expect(projection!.content_hash).toBe(full.content_hash);
  expect(projection).not.toHaveProperty('compiled_truth');
  expect(projection).not.toHaveProperty('timeline');

  expect(projection!.content_windows.compiled_truth).toEqual({
    text: '😀BCe',
    char_start: 1,
    total_chars: 10,
    returned_chars: 4,
    next_char_start: 5,
    has_more: true,
  });
  expect(projection!.content_windows.timeline).toEqual({
    text: 'T😀U',
    char_start: 0,
    total_chars: 6,
    returned_chars: 3,
    next_char_start: 3,
    has_more: true,
  });

  const continuation = await engine.getPageProjection(slug, {
    windows: {
      compiled_truth: { char_start: 5, char_limit: 99 },
    },
  });
  expect(continuation!.content_windows.compiled_truth).toEqual({
    text: '\u0301FGHI',
    char_start: 5,
    total_chars: 10,
    returned_chars: 5,
    next_char_start: null,
    has_more: false,
  });
  expect(
    `${projection!.content_windows.compiled_truth!.text}${continuation!.content_windows.compiled_truth!.text}`,
  ).toBe('😀BCe\u0301FGHI');

  const emptyWindow = await engine.getPageProjection(slug, {
    windows: {
      timeline: { char_start: 99, char_limit: 10 },
    },
  });
  expect(emptyWindow!.content_windows.timeline).toEqual({
    text: '',
    char_start: 6,
    total_chars: 6,
    returned_chars: 0,
    next_char_start: null,
    has_more: false,
  });

  const metadataOnly = await engine.getPageProjection(slug);
  expect(metadataOnly!.content_windows).toEqual({});

  const fetched = await engine.getPage(slug);
  expect(fetched!.compiled_truth).toBe(full.compiled_truth);
  expect(fetched!.timeline).toBe(full.timeline);
}

describe('page projection engine API', () => {
  test('SQLite returns metadata and Unicode-scalar text windows without full page bodies', async () => {
    await expectProjectionContract(sqlite, 'concepts/projection-sqlite');
  });

  test('PGLite returns metadata and Unicode-scalar text windows without full page bodies', async () => {
    await expectProjectionContract(pglite, 'concepts/projection-pglite');
  });

  test('rejects invalid projection window bounds', async () => {
    await seedProjectionPage(sqlite, 'concepts/projection-invalid-bounds');

    await expect(sqlite.getPageProjection('concepts/projection-invalid-bounds', {
      windows: { compiled_truth: { char_start: -1, char_limit: 1 } },
    })).rejects.toThrow('char_start must be a non-negative finite number');

    await expect(sqlite.getPageProjection('concepts/projection-invalid-bounds', {
      windows: { compiled_truth: { char_start: 0, char_limit: 0 } },
    })).rejects.toThrow('char_limit must be a positive finite number');

    await expect(sqlite.getPageProjection('concepts/projection-invalid-bounds', {
      windows: { compiled_truth: { char_start: 0.5, char_limit: 1 } },
    })).rejects.toThrow('char_start must be an integer');

    await expect(sqlite.getPageProjection('concepts/projection-invalid-bounds', {
      windows: { compiled_truth: { char_start: 0, char_limit: 0.5 } },
    })).rejects.toThrow('char_limit must be an integer');
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    test.skip('postgres page projection skipped: DATABASE_URL is not configured', () => {});
    return;
  }

  test('Postgres returns metadata and Unicode-scalar text windows without full page bodies', async () => {
    const schemaName = `page_projection_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const admin = postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 1,
      max: 1,
      types: { bigint: postgres.BigInt },
    });
    const engine = new PostgresEngine();

    try {
      await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
      const url = new URL(databaseUrl);
      url.searchParams.set('search_path', schemaName);
      await engine.connect({
        engine: 'postgres',
        database_url: url.toString(),
        poolSize: 1,
      });
      await engine.initSchema();
      await expectProjectionContract(engine, 'concepts/projection-postgres');
    } finally {
      await engine.disconnect().catch(() => undefined);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      await admin.end({ timeout: 0 });
    }
  });
});
