import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';
import { getStructuralContextAtlasReport } from '../src/core/services/context-atlas-report-service.ts';

test('context-atlas report service renders deterministic fresh report lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-report-'));
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

    const result = await getStructuralContextAtlasReport(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.report?.report_kind).toBe('structural');
    expect(result.report?.summary_lines).toContain('Atlas freshness is fresh.');
    expect(result.report?.summary_lines).toContain('This atlas is safe to use for orientation under the current scope.');
    expect(result.report?.recommended_reads[0]?.page_slug).toBe('concepts/note-manifest');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-atlas report service renders deterministic stale warnings for direct atlas reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-report-stale-'));
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
    const built = await buildStructuralContextAtlasEntry(engine);

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and changes freshness.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const result = await getStructuralContextAtlasReport(engine, {
      atlas_id: built.id,
    });

    expect(result.selection_reason).toBe('direct_atlas_id');
    expect(result.report?.freshness).toBe('stale');
    expect(result.report?.summary_lines).toContain('Atlas freshness is stale.');
    expect(result.report?.summary_lines).toContain('Rebuild the linked context map and atlas before trusting routing output.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
