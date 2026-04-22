import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../src/core/services/context-map-service.ts';
import { getStructuralContextMapReport } from '../src/core/services/context-map-report-service.ts';

test('context-map report service renders deterministic fresh report lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-report-'));
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

    const result = await getStructuralContextMapReport(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.report?.report_kind).toBe('structural');
    expect(result.report?.map_id).toBe(workspaceContextMapId('workspace:default'));
    expect(result.report?.summary_lines).toContain('Context map status is ready.');
    expect(result.report?.summary_lines).toContain('This map is safe to use for orientation under the current scope.');
    expect(result.report?.recommended_reads[0]?.page_slug).toBe('concepts/note-manifest');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-map report service renders deterministic stale warnings for direct map reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-report-stale-'));
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

    const result = await getStructuralContextMapReport(engine, {
      map_id: built.id,
    });

    expect(result.selection_reason).toBe('direct_map_id');
    expect(result.report?.status).toBe('stale');
    expect(result.report?.summary_lines).toContain('Context map status is stale.');
    expect(result.report?.summary_lines).toContain('Rebuild the context map before trusting broad-synthesis orientation output.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
