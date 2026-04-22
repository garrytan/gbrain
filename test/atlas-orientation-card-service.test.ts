import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';
import { getAtlasOrientationCard } from '../src/core/services/atlas-orientation-card-service.ts';

test('atlas orientation card service composes atlas selection with the workspace corpus card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-card-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'projects/apollo', [
      '---',
      'type: project',
      'title: Apollo',
      'repo: meghendra6/apollo',
      'status: active',
      '---',
      '# Overview',
      'Uses [[systems/mbrain]].',
    ].join('\n'), { path: 'projects/apollo.md' });

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      'repo: meghendra6/mbrain',
      'build_command: bun run build',
      'test_command: bun test',
      '---',
      '# Overview',
      'Supports [[projects/apollo]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await buildStructuralContextMapEntry(engine);
    const atlas = await buildStructuralContextAtlasEntry(engine);

    const result = await getAtlasOrientationCard(engine, {
      atlas_id: atlas.id,
    });

    expect(result.selection_reason).toBe('direct_atlas_id');
    expect(result.card?.card_kind).toBe('atlas_orientation');
    expect(result.card?.atlas_entry_id).toBe(atlas.id);
    expect(result.card?.anchor_slugs).toEqual(['projects/apollo', 'systems/mbrain']);
    expect(result.card?.recommended_reads.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atlas orientation card service returns deterministic no-match fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-card-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getAtlasOrientationCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.card).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
