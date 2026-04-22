import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  reopen: () => Promise<BrainEngine>;
  cleanup: () => Promise<void>;
}

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    reopen: async () => {
      const reopened = new SQLiteEngine();
      await reopened.connect({ engine: 'sqlite', database_path: databasePath });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    reopen: async () => {
      const reopened = new PGLiteEngine();
      await reopened.connect({ engine: 'pglite', database_path: dir });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedManifest(engine: BrainEngine, slug: string, path: string) {
  const content = [
    '---',
    'type: concept',
    'title: Note Manifest Engine',
    'tags: [phase2, engine]',
    'aliases:',
    '  - Engine Index',
    '---',
    '',
    '# Manifest Heading',
    'Reference [[systems/mbrain]] and https://example.com/engine.',
    '[Source: User, direct message, 2026-04-20 03:00 PM KST]',
  ].join('\n');

  const result = await importFromContent(engine, slug, content, { path });
  expect(result.status).toBe('imported');
}

async function expectManifest(engine: BrainEngine, slug: string, path: string) {
  const entry = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
  const entries = await engine.listNoteManifestEntries({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug,
  });

  expect(entry).not.toBeNull();
  expect(entry?.path).toBe(path);
  expect(entry?.aliases).toEqual(['Engine Index']);
  expect(entry?.tags).toEqual(['engine', 'phase2']);
  expect(entry?.outgoing_wikilinks).toEqual(['systems/mbrain']);
  expect(entry?.outgoing_urls).toEqual(['https://example.com/engine']);
  expect(entry?.source_refs).toEqual(['User, direct message, 2026-04-20 03:00 PM KST']);
  expect(entry?.heading_index).toEqual([
    { slug: 'manifest-heading', text: 'Manifest Heading', depth: 1, line_start: 1 },
  ]);
  expect(entries).toHaveLength(1);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists note manifest entries and cascades on delete`, async () => {
    const harness = await createHarness();
    const slug = `concepts/note-manifest-${harness.label}`;
    const path = `concepts/note-manifest-${harness.label}.md`;
    let reopened: BrainEngine | null = null;

    try {
      await seedManifest(harness.engine, slug, path);
      await expectManifest(harness.engine, slug, path);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectManifest(reopened, slug, path);

      await reopened.deletePage(slug);
      expect(await reopened.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

test('note manifest engines honor limit and offset filters', async () => {
  const harness = await createSqliteHarness();

  try {
    await seedManifest(harness.engine, 'concepts/note-manifest-a', 'concepts/note-manifest-a.md');
    await seedManifest(harness.engine, 'concepts/note-manifest-b', 'concepts/note-manifest-b.md');

    const first = await harness.engine.listNoteManifestEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      limit: 1,
      offset: 0,
    });
    const second = await harness.engine.listNoteManifestEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      limit: 1,
      offset: 1,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.slug).not.toBe(second[0]?.slug);
  } finally {
    await harness.cleanup();
  }
});

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists note manifest entries', async () => {
    const slug = `concepts/note-manifest-postgres-${Date.now()}`;
    const path = `${slug}.md`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedManifest(engine, slug, path);
      await expectManifest(engine, slug, path);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectManifest(reopened, slug, path);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deletePage(slug).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres note manifest persistence skipped: DATABASE_URL is not configured', () => {});
}
