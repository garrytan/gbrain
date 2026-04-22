import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';
import { getAtlasOrientationBundle } from '../src/core/services/atlas-orientation-bundle-service.ts';

test('atlas orientation bundle service composes atlas report and atlas orientation card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-bundle-'));
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

    const result = await getAtlasOrientationBundle(engine, {
      atlas_id: atlas.id,
    });

    expect(result.selection_reason).toBe('direct_atlas_id');
    expect(result.bundle?.bundle_kind).toBe('atlas_orientation');
    expect(result.bundle?.atlas_entry_id).toBe(atlas.id);
    expect(result.bundle?.report.entry_id).toBe(atlas.id);
    expect(result.bundle?.card.atlas_entry_id).toBe(atlas.id);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atlas orientation bundle service returns deterministic no-match fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-bundle-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getAtlasOrientationBundle(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.bundle).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
