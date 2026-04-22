import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import {
  ATLAS_WORKSPACE_KIND,
  buildStructuralContextAtlasEntry,
  getStructuralContextAtlasEntry,
  listStructuralContextAtlasEntries,
  selectStructuralContextAtlasEntry,
  workspaceContextAtlasId,
} from '../src/core/services/context-atlas-service.ts';

test('context-atlas service builds a deterministic workspace atlas entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-service-'));
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

    await buildStructuralContextMapEntry(engine);
    const entry = await buildStructuralContextAtlasEntry(engine);

    expect(entry.id).toBe(workspaceContextAtlasId('workspace:default'));
    expect(entry.kind).toBe(ATLAS_WORKSPACE_KIND);
    expect(entry.freshness).toBe('fresh');
    expect(entry.entrypoints.length).toBeGreaterThan(0);
    expect(entry.entrypoints[0]).toBe('page:concepts/note-manifest');
    expect(entry.budget_hint).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-atlas service mirrors context-map staleness until atlas rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-stale-'));
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

    await buildStructuralContextMapEntry(engine);
    await buildStructuralContextAtlasEntry(engine);

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and changes map freshness.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const id = workspaceContextAtlasId('workspace:default');
    const staleEntry = await getStructuralContextAtlasEntry(engine, id);
    expect(staleEntry?.freshness).toBe('stale');

    const listed = await listStructuralContextAtlasEntries(engine, { scope_id: 'workspace:default' });
    expect(listed[0]?.freshness).toBe('stale');

    await buildStructuralContextMapEntry(engine);
    const rebuilt = await buildStructuralContextAtlasEntry(engine);
    expect(rebuilt.freshness).toBe('fresh');

    const refreshed = await getStructuralContextAtlasEntry(engine, id);
    expect(refreshed?.freshness).toBe('fresh');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-atlas service selects entries with deterministic freshness and budget rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-select-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const currentMap = await buildStructuralContextMapEntry(engine);
    const currentSourceSetHash = currentMap.source_set_hash;

    await engine.upsertContextMapEntry({
      id: 'context-map:workspace:workspace:default:project:fresh',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Fresh Project Map',
      build_mode: 'structural',
      status: 'ready',
      source_set_hash: currentSourceSetHash,
      extractor_version: 'phase2-context-map-v1',
      node_count: 1,
      edge_count: 0,
      community_count: 0,
      graph_json: { nodes: [], edges: [] },
    });
    await engine.upsertContextMapEntry({
      id: 'context-map:workspace:workspace:default:project:stale',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Stale Project Map',
      build_mode: 'structural',
      status: 'stale',
      source_set_hash: 'stale-project',
      extractor_version: 'phase2-context-map-v1',
      node_count: 1,
      edge_count: 0,
      community_count: 0,
      graph_json: { nodes: [], edges: [] },
    });

    await engine.upsertContextAtlasEntry({
      id: 'context-atlas:project:workspace:default:fresh',
      map_id: 'context-map:workspace:workspace:default:project:fresh',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Fresh Project Atlas',
      freshness: 'fresh',
      entrypoints: ['page:systems/mbrain'],
      budget_hint: 4,
    });
    await engine.upsertContextAtlasEntry({
      id: 'context-atlas:project:workspace:default:stale',
      map_id: 'context-map:workspace:workspace:default:project:stale',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Stale Project Atlas',
      freshness: 'stale',
      entrypoints: ['page:concepts/note-manifest'],
      budget_hint: 2,
    });

    const freshOnly = await selectStructuralContextAtlasEntry(engine, {
      scope_id: 'workspace:default',
      kind: 'project',
    });
    expect(freshOnly.reason).toBe('selected_fresh_match');
    expect(freshOnly.candidate_count).toBe(2);
    expect(freshOnly.entry?.id).toBe('context-atlas:project:workspace:default:fresh');

    const overBudget = await selectStructuralContextAtlasEntry(engine, {
      scope_id: 'workspace:default',
      kind: 'project',
      max_budget_hint: 2,
    });
    expect(overBudget.reason).toBe('no_budget_fit');
    expect(overBudget.entry).toBeNull();

    const staleAllowed = await selectStructuralContextAtlasEntry(engine, {
      scope_id: 'workspace:default',
      kind: 'project',
      max_budget_hint: 2,
      allow_stale: true,
    });
    expect(staleAllowed.reason).toBe('selected_stale_match');
    expect(staleAllowed.entry?.id).toBe('context-atlas:project:workspace:default:stale');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
