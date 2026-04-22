import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../src/core/services/context-map-service.ts';
import { getStructuralContextMapExplanation } from '../src/core/services/context-map-explain-service.ts';

test('context-map explain service renders deterministic local explanation for a section node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-explain-'));
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
      'Coordinates structural extraction with [[concepts/note-manifest]].',
      '[Source: User, direct message, 2026-04-21 7:10 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-21 7:11 PM KST]',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const built = await buildStructuralContextMapEntry(engine);

    const result = await getStructuralContextMapExplanation(engine, {
      map_id: built.id,
      node_id: 'section:systems/mbrain#overview/runtime',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.candidate_count).toBe(1);
    expect(result.explanation?.explanation_kind).toBe('structural');
    expect(result.explanation?.map_id).toBe(workspaceContextMapId('workspace:default'));
    expect(result.explanation?.node_id).toBe('section:systems/mbrain#overview/runtime');
    expect(result.explanation?.node_kind).toBe('section');
    expect(result.explanation?.label).toBe('Runtime');
    expect(result.explanation?.status).toBe('ready');
    expect(result.explanation?.summary_lines).toContain('Context map status is ready.');
    expect(result.explanation?.summary_lines).toContain('Explained node is section Runtime from systems/mbrain.');
    expect(result.explanation?.neighbor_edges.map((edge) => edge.edge_kind).sort()).toEqual([
      'page_contains_section',
      'section_links_page',
      'section_parent',
    ]);
    expect(result.explanation?.recommended_reads.map((read) => read.page_slug)).toEqual([
      'systems/mbrain',
      'concepts/note-manifest',
    ]);
    expect(result.explanation?.recommended_reads[0]?.section_id).toBe('systems/mbrain#overview/runtime');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map explain service discloses no-match when no persisted map exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-explain-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getStructuralContextMapExplanation(engine, {
      scope_id: 'workspace:default',
      node_id: 'page:systems/mbrain',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.explanation).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map explain service keeps stale maps readable with explicit warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-explain-stale-'));
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

    const result = await getStructuralContextMapExplanation(engine, {
      map_id: built.id,
      node_id: 'page:systems/mbrain',
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.explanation?.status).toBe('stale');
    expect(result.explanation?.summary_lines).toContain('Context map status is stale.');
    expect(result.explanation?.summary_lines).toContain('Rebuild the context map before trusting this local explanation for broad routing.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
