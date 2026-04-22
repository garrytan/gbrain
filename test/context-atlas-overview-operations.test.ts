import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { buildStructuralContextAtlasEntry } from '../src/core/services/context-atlas-service.ts';

test('context-atlas overview operation is registered with CLI hints', () => {
  const overview = operations.find((operation) => operation.name === 'get_context_atlas_overview');
  expect(overview?.cliHints?.name).toBe('atlas-overview');
});

test('context-atlas overview operation returns no-match disclosure and direct overviews', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-overview-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const overview = operations.find((operation) => operation.name === 'get_context_atlas_overview');

  if (!overview) {
    throw new Error('get_context_atlas_overview operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await overview.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).overview).toBeNull();

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

    const direct = await overview.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      atlas_id: built.id,
    });

    expect((direct as any).selection_reason).toBe('direct_atlas_id');
    expect((direct as any).overview?.entry.id).toBe(built.id);
    expect((direct as any).overview?.recommended_reads.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

