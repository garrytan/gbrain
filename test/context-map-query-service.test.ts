import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../src/core/services/context-map-service.ts';
import { queryStructuralContextMap } from '../src/core/services/context-map-query-service.ts';

test('context-map query service ranks deterministic node matches for a direct map read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-query-'));
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
      '',
      '## Runtime',
      'Coordinates structural extraction.',
      '[Source: User, direct message, 2026-04-21 8:00 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-21 8:01 PM KST]',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const built = await buildStructuralContextMapEntry(engine);

    const result = await queryStructuralContextMap(engine, {
      map_id: built.id,
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.candidate_count).toBe(1);
    expect(result.result?.query_kind).toBe('structural');
    expect(result.result?.map_id).toBe(workspaceContextMapId('workspace:default'));
    expect(result.result?.query).toBe('mbrain');
    expect(result.result?.status).toBe('ready');
    expect(result.result?.summary_lines).toContain('Context map status is ready.');
    expect(result.result?.summary_lines).toContain('Matched nodes available: 3.');
    expect(result.result?.matched_nodes[0]).toEqual({
      node_id: 'page:systems/mbrain',
      node_kind: 'page',
      label: 'MBrain',
      page_slug: 'systems/mbrain',
      score: 3,
    });
    expect(result.result?.recommended_reads.map((read) => read.page_slug)).toEqual(['systems/mbrain']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map query service discloses no-match when no persisted map exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-query-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await queryStructuralContextMap(engine, {
      scope_id: 'workspace:default',
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.result).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map query service keeps stale maps queryable with explicit warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-query-stale-'));
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

    const result = await queryStructuralContextMap(engine, {
      map_id: built.id,
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.result?.status).toBe('stale');
    expect(result.result?.summary_lines).toContain('Context map status is stale.');
    expect(result.result?.summary_lines).toContain('Rebuild the context map before trusting this query result for broad routing.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
