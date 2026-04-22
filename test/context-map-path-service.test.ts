import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../src/core/services/context-map-service.ts';
import { findStructuralContextMapPath } from '../src/core/services/context-map-path-service.ts';

test('context-map path service renders deterministic shortest paths for a direct map read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-path-'));
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
      '[Source: User, direct message, 2026-04-22 10:10 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-22 10:11 AM KST]',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const built = await buildStructuralContextMapEntry(engine);

    const result = await findStructuralContextMapPath(engine, {
      map_id: built.id,
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/note-manifest',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.candidate_count).toBe(1);
    expect(result.path?.path_kind).toBe('structural');
    expect(result.path?.map_id).toBe(workspaceContextMapId('workspace:default'));
    expect(result.path?.status).toBe('ready');
    expect(result.path?.hop_count).toBe(2);
    expect(result.path?.node_ids).toEqual([
      'page:systems/mbrain',
      'section:systems/mbrain#overview',
      'page:concepts/note-manifest',
    ]);
    expect(result.path?.summary_lines).toContain('Context map status is ready.');
    expect(result.path?.summary_lines).toContain('Resolved path hop count is 2.');
    expect(result.path?.recommended_reads.map((read) => read.page_slug)).toEqual([
      'systems/mbrain',
      'concepts/note-manifest',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map path service discloses no-match when no persisted map exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-path-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await findStructuralContextMapPath(engine, {
      scope_id: 'workspace:default',
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/note-manifest',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.path).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map path service discloses no_path when nodes do not connect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-path-none-'));
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
      'No outbound links here.',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/isolated', [
      '---',
      'type: concept',
      'title: Isolated',
      '---',
      '# Purpose',
      'No inbound links here either.',
    ].join('\n'), { path: 'concepts/isolated.md' });

    const built = await buildStructuralContextMapEntry(engine);

    const result = await findStructuralContextMapPath(engine, {
      map_id: built.id,
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/isolated',
    });

    expect(result.selection_reason).toBe('no_path');
    expect(result.path).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map path service keeps stale maps path-readable with explicit warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-path-stale-'));
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

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and changes freshness.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const result = await findStructuralContextMapPath(engine, {
      map_id: built.id,
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/note-manifest',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.path?.status).toBe('stale');
    expect(result.path?.summary_lines).toContain('Context map status is stale.');
    expect(result.path?.summary_lines).toContain('Rebuild the context map before trusting this path for broad routing.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
