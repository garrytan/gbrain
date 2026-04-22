import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';

test('atlas-orientation-bundle operation is registered with CLI hints', () => {
  const bundle = operations.find((operation) => operation.name === 'get_atlas_orientation_bundle');
  expect(bundle?.cliHints?.name).toBe('atlas-orientation-bundle');
});

test('atlas-orientation-bundle operation returns deterministic bundle payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-bundle-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const bundle = operations.find((operation) => operation.name === 'get_atlas_orientation_bundle');

  if (!bundle) {
    throw new Error('get_atlas_orientation_bundle operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await bundle.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).bundle).toBeNull();

    await importFromContent(engine, 'projects/apollo', [
      '---',
      'type: project',
      'title: Apollo',
      'status: active',
      '---',
      '# Overview',
      'Uses [[systems/mbrain]].',
    ].join('\n'), { path: 'projects/apollo.md' });

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Supports [[projects/apollo]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await buildStructuralContextMapEntry(engine);
    const atlas = await buildStructuralContextAtlasEntry(engine);

    const result = await bundle.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      atlas_id: atlas.id,
    });

    expect((result as any).selection_reason).toBe('direct_atlas_id');
    expect((result as any).bundle?.atlas_entry_id).toBe(atlas.id);
    expect((result as any).bundle?.report.entry_id).toBe(atlas.id);
    expect((result as any).bundle?.card.atlas_entry_id).toBe(atlas.id);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
