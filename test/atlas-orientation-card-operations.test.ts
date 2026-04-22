import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';

test('atlas-orientation-card operation is registered with CLI hints', () => {
  const card = operations.find((operation) => operation.name === 'get_atlas_orientation_card');
  expect(card?.cliHints?.name).toBe('atlas-orientation-card');
});

test('atlas-orientation-card operation returns deterministic card payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-atlas-orientation-card-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const card = operations.find((operation) => operation.name === 'get_atlas_orientation_card');

  if (!card) {
    throw new Error('get_atlas_orientation_card operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await card.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).card).toBeNull();

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

    const result = await card.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      atlas_id: atlas.id,
    });

    expect((result as any).selection_reason).toBe('direct_atlas_id');
    expect((result as any).card?.card_kind).toBe('atlas_orientation');
    expect((result as any).card?.anchor_slugs).toEqual(['projects/apollo', 'systems/mbrain']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
