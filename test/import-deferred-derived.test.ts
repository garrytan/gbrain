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
    expect((await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: 'concepts/deferred-derived-storage',
      status: 'pending',
    })).map((job: any) => job.artifact_kind).sort()).toEqual([
      'note_manifest',
      'note_sections',
      'page_chunks',
    ]);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      'concepts/deferred-derived-storage',
      'note_sections',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: result.content_hash,
      indexed_content_hash: null,
    });

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
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: 'concepts/deferred-derived-storage',
      status: 'pending',
    })).toHaveLength(0);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      'concepts/deferred-derived-storage',
      'note_sections',
    )).toMatchObject({
      status: 'ready',
      target_content_hash: result.content_hash,
      indexed_content_hash: result.content_hash,
    });
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

test('deferred unchanged import with a new manifest path enqueues durable derived refresh', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/manifest-path-change';
    await importFromContent(engine, slug, content, {
      path: 'concepts/old-path.md',
    });
    expect(await engine.getNoteManifestEntry(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
    )).toMatchObject({ path: 'concepts/old-path.md' });

    const result = await importFromContent(engine, slug, content, {
      path: 'concepts/new-path.md',
      deferDerived: true,
    });

    expect(result).toMatchObject({
      slug,
      status: 'skipped',
      chunks: 0,
      deferred_derived: true,
    });
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();

    const jobs = await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      status: 'pending',
    });
    expect(jobs.map((job: any) => job.artifact_kind).sort()).toEqual([
      'note_manifest',
      'note_sections',
      'page_chunks',
    ]);
    expect(jobs.every((job: any) => job.manifest_path === 'concepts/new-path.md')).toBe(true);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: result.content_hash,
      indexed_content_hash: null,
    });
  });
});

test('deferred unchanged import with stale derived metadata enqueues durable refresh', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/derived-metadata-change';
    await importFromContent(engine, slug, content);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_sections',
    )).toMatchObject({
      status: 'ready',
      extractor_version: 'phase2-sections-v1',
      derived_schema_version: 'page-derived-v1',
    });

    (engine as any).database.run(
      `UPDATE derived_index_state
       SET extractor_version = 'phase2-sections-v0'
       WHERE scope_id = ? AND slug = ? AND artifact_kind = 'note_sections'`,
      [DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug],
    );

    const result = await importFromContent(engine, slug, content, {
      deferDerived: true,
    });

    expect(result).toMatchObject({
      slug,
      status: 'skipped',
      chunks: 0,
      deferred_derived: true,
    });
    const jobs = await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      status: 'pending',
    });
    expect(jobs.map((job: any) => job.artifact_kind).sort()).toEqual([
      'note_manifest',
      'note_sections',
      'page_chunks',
    ]);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_sections',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: result.content_hash,
      indexed_content_hash: null,
    });
  });
});

test('manual derived refresh without an active job marks derived state ready', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/manual-derived-refresh';
    await importFromContent(engine, slug, content);
    (engine as any).database.run(
      `DELETE FROM derived_index_state
       WHERE scope_id = ? AND slug = ?`,
      [DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug],
    );

    const refreshed = await refreshDerivedStorageForPage(engine, slug);

    expect(refreshed.status).toBe('imported');
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'ready',
      target_content_hash: refreshed.content_hash,
      indexed_content_hash: refreshed.content_hash,
    });
  });
});

test('deferred refresh rolls back derived storage when ready completion is refused', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/refused-derived-refresh';
    const imported = await importFromContent(engine, slug, content, {
      deferDerived: true,
    });
    expect(await engine.getChunks(slug)).toHaveLength(0);

    const originalMarkReady = (engine as any).markDerivedIndexReady.bind(engine);
    (engine as any).markDerivedIndexReady = async (input: Record<string, unknown>) => ({
      scope_id: input.scope_id,
      slug: input.slug,
      artifact_kind: input.artifact_kind,
      target_content_hash: input.target_content_hash,
      indexed_content_hash: null,
      status: 'pending',
      extractor_version: 'recursive-chunks-v1',
      derived_schema_version: 'page-derived-v1',
      last_error: null,
      updated_at: new Date(),
    });
    try {
      const refreshed = await refreshDerivedStorageForPage(engine, slug, {
        expectedContentHash: imported.content_hash,
      });

      expect(refreshed.status).toBe('skipped');
      expect(refreshed.error).toContain('derived target changed');
      expect(await engine.getChunks(slug)).toHaveLength(0);
    } finally {
      (engine as any).markDerivedIndexReady = originalMarkReady;
    }
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

test('put_page defer_derived only enqueues durable derived jobs', async () => {
  await withEngine(async (engine) => {
    const putPage = operations.find(operation => operation.name === 'put_page');
    if (!putPage) throw new Error('put_page operation is missing');

    const result = await putPage.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
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
    expect(await engine.getChunks('concepts/put-page-deferred-derived')).toHaveLength(0);

    expect((await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: 'concepts/put-page-deferred-derived',
      status: 'pending',
    })).map((job: any) => job.artifact_kind).sort()).toEqual([
      'note_manifest',
      'note_sections',
      'page_chunks',
    ]);
  });
});

test('put_page defer_derived without a background scheduler still only enqueues durable jobs', async () => {
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
    expect(result.derived_storage).toBe('scheduled');
    expect(result.chunks).toBe(0);
    expect(await engine.getChunks('concepts/put-page-sync-derived')).toHaveLength(0);
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: 'concepts/put-page-sync-derived',
      status: 'pending',
    })).toHaveLength(3);
  });
});

test('tag operations enqueue durable note manifest refresh work', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/tag-derived-refresh';
    const addTag = operations.find(operation => operation.name === 'add_tag');
    const removeTag = operations.find(operation => operation.name === 'remove_tag');
    if (!addTag || !removeTag) throw new Error('tag operations are missing');

    const imported = await importFromContent(engine, slug, content);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'ready',
      target_content_hash: imported.content_hash,
      indexed_content_hash: imported.content_hash,
    });

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };
    await addTag.handler(ctx, { slug, tag: 'new-tag' });

    expect(await engine.getTags(slug)).toEqual(['mcp', 'new-tag', 'performance']);
    expect(await engine.getChunks(slug)).not.toHaveLength(0);
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    })).toHaveLength(1);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: imported.content_hash,
      indexed_content_hash: null,
    });

    await refreshDerivedStorageForPage(engine, slug);
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toMatchObject({
      tags: ['mcp', 'new-tag', 'performance'],
    });

    await removeTag.handler(ctx, { slug, tag: 'new-tag' });

    expect(await engine.getTags(slug)).toEqual(['mcp', 'performance']);
    expect(await engine.getChunks(slug)).not.toHaveLength(0);
    expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toBeNull();
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    })).toHaveLength(1);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'note_manifest',
    )).toMatchObject({
      status: 'pending',
      target_content_hash: imported.content_hash,
      indexed_content_hash: null,
    });
  });
});

test('tag operations supersede already-running note manifest work with stale tags', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/tag-running-derived-refresh';
    const addTag = operations.find(operation => operation.name === 'add_tag');
    if (!addTag) throw new Error('add_tag operation is missing');

    const imported = await importFromContent(engine, slug, content);
    const manifestPath = `${slug}.md`;
    const running = await (engine as any).enqueueDerivedJob({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      target_content_hash: imported.content_hash,
      manifest_path: manifestPath,
      derived_parameters: {
        manifest_path: manifestPath,
        extractor_version: 'phase2-structural-v1',
        derived_schema_version: 'page-derived-v1',
      },
    });
    (engine as any).database.run(`UPDATE derived_jobs SET status = 'running' WHERE id = ?`, [running.id]);

    await addTag.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug,
      tag: 'fresh',
    });

    const jobs = await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      limit: 10,
    });
    expect(jobs.map((job: any) => job.status).sort()).toEqual(['pending', 'superseded']);
    const pending = jobs.find((job: any) => job.status === 'pending');
    expect(pending?.derived_parameters.tags).toEqual(['fresh', 'mcp', 'performance']);

    const staleCompletion = await (engine as any).markDerivedIndexReady({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      target_content_hash: imported.content_hash,
      indexed_content_hash: imported.content_hash,
      manifest_path: manifestPath,
      derived_parameters: {
        manifest_path: manifestPath,
        extractor_version: 'phase2-structural-v1',
        derived_schema_version: 'page-derived-v1',
      },
      require_active_job: true,
    });
    expect(staleCompletion.status).toBe('pending');
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    })).toHaveLength(1);
  });
});

test('tag operations still mutate legacy pages without content hashes', async () => {
  await withEngine(async (engine) => {
    const slug = 'concepts/tag-legacy-null-hash';
    const addTag = operations.find(operation => operation.name === 'add_tag');
    const removeTag = operations.find(operation => operation.name === 'remove_tag');
    if (!addTag || !removeTag) throw new Error('tag operations are missing');

    await importFromContent(engine, slug, content);
    (engine as any).database.run('UPDATE pages SET content_hash = NULL WHERE slug = ?', [slug]);

    const ctx = {
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    };
    await addTag.handler(ctx, { slug, tag: 'legacy-tag' });
    expect(await engine.getTags(slug)).toEqual(['legacy-tag', 'mcp', 'performance']);

    await removeTag.handler(ctx, { slug, tag: 'legacy-tag' });
    expect(await engine.getTags(slug)).toEqual(['mcp', 'performance']);
    expect(await (engine as any).listDerivedJobs({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'note_manifest',
      status: 'pending',
    })).toHaveLength(0);
  });
});
