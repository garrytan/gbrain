import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../src/core/services/context-map-service.ts';
import { getBroadSynthesisRoute } from '../src/core/services/broad-synthesis-route-service.ts';

test('broad-synthesis route service composes report, query, and top-hit explain into one route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-broad-synthesis-route-'));
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
      '[Source: User, direct message, 2026-04-22 10:40 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-22 10:41 AM KST]',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getBroadSynthesisRoute(engine, {
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.route_kind).toBe('broad_synthesis');
    expect(result.route?.map_id).toBe(workspaceContextMapId('workspace:default'));
    expect(result.route?.query).toBe('mbrain');
    expect(result.route?.status).toBe('ready');
    expect(result.route?.retrieval_route).toEqual([
      'curated_notes',
      'context_map_report',
      'context_map_query',
      'context_map_explain',
      'canonical_follow_through',
    ]);
    expect(result.route?.focal_node_id).toBe('page:systems/mbrain');
    expect(result.route?.matched_nodes[0]?.node_id).toBe('page:systems/mbrain');
    expect(result.route?.summary_lines).toContain('Context map status is ready.');
    expect(result.route?.summary_lines).toContain('Matched structural nodes available: 3.');
    expect(result.route?.recommended_reads.map((read) => read.page_slug)).toEqual([
      'systems/mbrain',
      'concepts/note-manifest',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broad-synthesis route service discloses no_match when no persisted map exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-broad-synthesis-route-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getBroadSynthesisRoute(engine, {
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broad-synthesis route service falls back to report-driven orientation when the query has no structural hits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-broad-synthesis-route-fallback-'));
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

    const result = await getBroadSynthesisRoute(engine, {
      query: 'unmatched-query',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.route?.focal_node_id).toBeNull();
    expect(result.route?.matched_nodes).toEqual([]);
    expect(result.route?.summary_lines).toContain('No structural node matched the route query; fall back to report-driven orientation.');
    expect(result.route?.recommended_reads.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broad-synthesis route service keeps stale maps routable with explicit warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-broad-synthesis-route-stale-'));
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

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and changes freshness.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const result = await getBroadSynthesisRoute(engine, {
      query: 'mbrain',
    });

    expect(result.selection_reason).toBe('selected_stale_match');
    expect(result.route?.status).toBe('stale');
    expect(result.route?.summary_lines).toContain('Context map status is stale.');
    expect(result.route?.summary_lines).toContain('Rebuild the context map before trusting this broad-synthesis route.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
