import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  importFromContent,
  refreshDerivedStorageForPage,
} from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

async function withEngine(run: (engine: SQLiteEngine) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-import-deferred-derived-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

const content = [
  '---',
  'type: concept',
  'title: Deferred Derived Storage',
  'tags: [mcp, performance]',
  '---',
  '# Deferred Derived Storage',
  'Canonical content is available immediately. [Source: User, direct message, 2026-05-12 09:00 KST]',
  '',
  '## Indexed Later',
  'This heading should appear in section entries after the deferred refresh.',
  '',
  '---',
  '',
  '- **2026-05-12** | Timeline evidence. [Source: User, direct message, 2026-05-12 09:00 KST]',
].join('\n');

test('importFromContent can defer derived storage while committing the canonical page', async () => {
  await withEngine(async (engine) => {
    const result = await importFromContent(engine, 'concepts/deferred-derived-storage', content, {
      deferDerived: true,
    });

    expect(result.status).toBe('imported');
    expect(result.deferred_derived).toBe(true);
    expect(result.chunks).toBe(0);

    const page = await engine.getPage('concepts/deferred-derived-storage');
    expect(page?.title).toBe('Deferred Derived Storage');
    expect(await engine.getTags('concepts/deferred-derived-storage')).toEqual(['mcp', 'performance']);
    expect(await engine.getChunks('concepts/deferred-derived-storage')).toHaveLength(0);
    expect(await engine.getNoteManifestEntry(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      'concepts/deferred-derived-storage',
    )).toBeNull();

    const refreshed = await refreshDerivedStorageForPage(engine, 'concepts/deferred-derived-storage');
    expect(refreshed.status).toBe('imported');
    expect(refreshed.chunks).toBeGreaterThan(0);
    expect(refreshed.deferred_derived).toBe(false);
    expect(await engine.getChunks('concepts/deferred-derived-storage')).not.toHaveLength(0);
    expect(await engine.getNoteManifestEntry(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      'concepts/deferred-derived-storage',
    )).not.toBeNull();
    expect(await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: 'concepts/deferred-derived-storage',
    })).not.toHaveLength(0);
  });
});

test('deferred refresh skips stale work when a newer page hash has already landed', async () => {
  await withEngine(async (engine) => {
    const first = await importFromContent(engine, 'concepts/stale-deferred-derived', content, {
      deferDerived: true,
    });
    const firstHash = (await engine.getPage('concepts/stale-deferred-derived'))?.content_hash;
    expect(first.status).toBe('imported');
    expect(firstHash).toBeTruthy();

    const secondContent = content.replace(
      'Canonical content is available immediately.',
      'A newer canonical page version is available immediately.',
    );
    await importFromContent(engine, 'concepts/stale-deferred-derived', secondContent);

    const stale = await refreshDerivedStorageForPage(engine, 'concepts/stale-deferred-derived', {
      expectedContentHash: firstHash,
    });
    expect(stale.status).toBe('skipped');
    expect(stale.error).toContain('content hash changed');
  });
});

test('deferred import invalidates old derived storage instead of serving stale chunks', async () => {
  await withEngine(async (engine) => {
    await importFromContent(engine, 'concepts/invalidate-deferred-derived', content);
    expect(await engine.getChunks('concepts/invalidate-deferred-derived')).not.toHaveLength(0);

    const updated = content.replace(
      'Canonical content is available immediately.',
      'Updated canonical content is available immediately.',
    );
    const result = await importFromContent(engine, 'concepts/invalidate-deferred-derived', updated, {
      deferDerived: true,
    });

    expect(result.deferred_derived).toBe(true);
    expect(await engine.getChunks('concepts/invalidate-deferred-derived')).toHaveLength(0);
    expect(await engine.getNoteManifestEntry(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      'concepts/invalidate-deferred-derived',
    )).toBeNull();
  });
});

test('non-deferred refresh clears stale chunk embeddings before upserting new chunks', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/clear-stale-embedding';
    await importFromContent(engine, slug, content);
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'old embedded chunk',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array([1, 2, 3]),
      token_count: 3,
    }]);
    expect((await engine.getChunksWithEmbeddings(slug))[0]?.embedding).not.toBeNull();

    const updated = content.replace(
      'Canonical content is available immediately.',
      'Updated canonical content clears stale embeddings.',
    );
    await importFromContent(engine, slug, updated);

    const chunks = await engine.getChunksWithEmbeddings(slug);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.embedding).toBeNull();
  });
});

test('put_page defer_derived returns before derived storage and schedules refresh', async () => {
  await withEngine(async (engine) => {
    const putPage = operations.find(operation => operation.name === 'put_page');
    if (!putPage) throw new Error('put_page operation is missing');

    const result = await putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
      scheduleBackground: (_description, task) => {
        setTimeout(() => {
          task().catch((error) => {
            throw error;
          });
        }, 0);
      },
    }, {
      slug: 'concepts/put-page-deferred-derived',
      content,
      defer_derived: true,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      slug: 'concepts/put-page-deferred-derived',
      status: 'created_or_updated',
      chunks: 0,
      derived_storage: 'scheduled',
    });
    expect(await engine.getPage('concepts/put-page-deferred-derived')).not.toBeNull();

    const chunks = await eventually(async () => engine.getChunks('concepts/put-page-deferred-derived'));
    expect(chunks.length).toBeGreaterThan(0);
  });
});

test('put_page defer_derived falls back to synchronous refresh without a background scheduler', async () => {
  await withEngine(async (engine) => {
    const putPage = operations.find(operation => operation.name === 'put_page');
    if (!putPage) throw new Error('put_page operation is missing');

    const result = await putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/put-page-sync-derived',
      content,
      defer_derived: true,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      slug: 'concepts/put-page-sync-derived',
      status: 'created_or_updated',
    });
    expect(result.derived_storage).toBeUndefined();
    expect(Number(result.chunks)).toBeGreaterThan(0);
    expect(await engine.getChunks('concepts/put-page-sync-derived')).not.toHaveLength(0);
  });
});

async function eventually<T>(read: () => Promise<T>, attempts = 20): Promise<T> {
  let last = await read();
  for (let index = 0; index < attempts; index += 1) {
    if (Array.isArray(last) && last.length > 0) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
    last = await read();
  }
  return last;
}
