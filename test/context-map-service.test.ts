import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  buildStructuralContextMapEntry,
  computeContextMapSourceSetHash,
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
  markContextMapEntriesStaleForSourceSetChange,
  WORKSPACE_CONTEXT_MAP_KIND,
  workspaceContextMapId,
} from '../src/core/services/context-map-service.ts';

test('context-map service builds a persisted structural workspace map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-service-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const entry = await buildStructuralContextMapEntry(engine);

    expect(entry.id).toBe(workspaceContextMapId('workspace:default'));
    expect(entry.kind).toBe(WORKSPACE_CONTEXT_MAP_KIND);
    expect(entry.build_mode).toBe('structural');
    expect(entry.node_count).toBeGreaterThan(0);
    expect(entry.edge_count).toBeGreaterThan(0);
    expect((entry.graph_json as any).nodes.length).toBeGreaterThan(0);
    expect(await engine.getContextMapEntry(entry.id)).not.toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map service marks persisted maps stale until explicit rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-stale-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const id = workspaceContextMapId('workspace:default');
    const built = await buildStructuralContextMapEntry(engine);
    expect(built.status).toBe('ready');
    expect(built.stale_reason).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 10));

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and explains refresh.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const rawStaleEntry = await engine.getContextMapEntry(id);
    expect(rawStaleEntry).not.toBeNull();
    expect(rawStaleEntry?.status).toBe('stale');
    expect(rawStaleEntry?.stale_reason).toBe('source_set_changed');
    expect(rawStaleEntry?.generated_at.toISOString()).toBe(built.generated_at.toISOString());

    const staleEntry = await getStructuralContextMapEntry(engine, id);
    expect(staleEntry).not.toBeNull();
    expect(staleEntry?.status).toBe('stale');
    expect(staleEntry?.stale_reason).toBe('source_set_changed');

    const listed = await listStructuralContextMapEntries(engine, { scope_id: 'workspace:default' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('stale');
    expect(listed[0]?.stale_reason).toBe('source_set_changed');

    const rebuilt = await buildStructuralContextMapEntry(engine);
    expect(rebuilt.status).toBe('ready');
    expect(rebuilt.stale_reason).toBeNull();

    const refreshed = await getStructuralContextMapEntry(engine, id);
    expect(refreshed?.status).toBe('ready');
    expect(refreshed?.stale_reason).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map stale marking skips already stale entries without source-set scans', async () => {
  const generatedAt = new Date('2026-06-14T00:00:00.000Z');
  const calls: string[] = [];
  const engine = {
    listContextMapEntries: async () => {
      calls.push('listContextMapEntries');
      return [{
        id: workspaceContextMapId('workspace:default'),
        scope_id: 'workspace:default',
        kind: WORKSPACE_CONTEXT_MAP_KIND,
        title: 'Workspace Structural Map',
        build_mode: 'structural',
        status: 'stale',
        source_set_hash: 'old-hash',
        extractor_version: 'phase2-context-map-v1',
        node_count: 1,
        edge_count: 0,
        community_count: 0,
        graph_json: { nodes: [], edges: [] },
        generated_at: generatedAt,
        stale_reason: 'source_set_changed',
      }];
    },
    listNoteManifestEntries: async () => {
      calls.push('listNoteManifestEntries');
      throw new Error('stale entries should not scan manifests');
    },
    listNoteSectionEntries: async () => {
      calls.push('listNoteSectionEntries');
      throw new Error('stale entries should not scan sections');
    },
    upsertContextMapEntry: async () => {
      calls.push('upsertContextMapEntry');
      throw new Error('stale entries should not be rewritten');
    },
  } as any;

  await markContextMapEntriesStaleForSourceSetChange(engine);

  expect(calls).toEqual(['listContextMapEntries']);
});

test('context-map service preserves non-stale failure states on freshness reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-failed-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const built = await buildStructuralContextMapEntry(engine);
    await engine.upsertContextMapEntry({
      ...built,
      status: 'failed',
      stale_reason: 'build_failed',
    });

    const read = await getStructuralContextMapEntry(engine, built.id);

    expect(read?.status).toBe('failed');
    expect(read?.stale_reason).toBe('build_failed');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map service hashes paginate beyond 10_000 manifest entries', async () => {
  const manifests = Array.from({ length: 10_001 }, (_, index) => ({
    scope_id: 'workspace:default',
    page_id: index + 1,
    slug: `concepts/manifest-${index}`,
    path: `concepts/manifest-${index}.md`,
    page_type: 'concept',
    title: `Manifest ${index}`,
    frontmatter: {},
    aliases: [],
    tags: [],
    outgoing_wikilinks: [],
    outgoing_urls: [],
    source_refs: [],
    heading_index: [],
    content_hash: `hash-${index}`,
    extractor_version: 'phase2-structural-v1',
    last_indexed_at: new Date(0),
  }));

  const fakeEngine = {
    listNoteManifestEntries: async (filters?: any) => {
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit ?? manifests.length;
      return manifests.slice(offset, offset + limit);
    },
    listNoteSectionEntries: async () => [],
  } as any;

  const hash = await computeContextMapSourceSetHash(fakeEngine, 'workspace:default');

  expect(hash).toBeTruthy();
});
