import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry, workspaceContextAtlasId } from '../src/core/services/context-atlas-service.ts';
import { getStructuralContextAtlasOverview } from '../src/core/services/context-atlas-overview-service.ts';

test('context-atlas overview service returns a compact overview from atlas selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-overview-'));
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
    await buildStructuralContextAtlasEntry(engine);

    const overview = await getStructuralContextAtlasOverview(engine, {
      scope_id: 'workspace:default',
    });

    expect(overview.selection_reason).toBe('selected_fresh_match');
    expect(overview.candidate_count).toBe(1);
    expect(overview.overview?.overview_kind).toBe('structural');
    expect(overview.overview?.entry.id).toBe(workspaceContextAtlasId('workspace:default'));
    expect(overview.overview?.recommended_reads[0]).toMatchObject({
      node_id: 'page:concepts/note-manifest',
      node_kind: 'page',
      label: 'Note Manifest',
      page_slug: 'concepts/note-manifest',
      path: 'concepts/note-manifest.md',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-atlas overview service resolves section entrypoints and preserves stale direct reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-overview-stale-'));
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
    const built = await buildStructuralContextAtlasEntry(engine);
    await engine.upsertContextAtlasEntry({
      id: built.id,
      map_id: built.map_id,
      scope_id: built.scope_id,
      kind: built.kind,
      title: built.title,
      freshness: built.freshness,
      entrypoints: [
        'section:systems/mbrain#overview/runtime',
        'page:concepts/note-manifest',
      ],
      budget_hint: built.budget_hint,
    });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and changes freshness.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const overview = await getStructuralContextAtlasOverview(engine, {
      atlas_id: built.id,
    });

    expect(overview.selection_reason).toBe('direct_atlas_id');
    expect(overview.candidate_count).toBe(1);
    expect(overview.overview?.entry.freshness).toBe('stale');
    expect(overview.overview?.recommended_reads[0]).toMatchObject({
      node_id: 'section:systems/mbrain#overview/runtime',
      node_kind: 'section',
      label: 'Runtime',
      page_slug: 'systems/mbrain',
      path: 'systems/mbrain.md',
      section_id: 'systems/mbrain#overview/runtime',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
