import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('context-map path operation is registered with CLI hints', () => {
  const path = operations.find((operation) => operation.name === 'find_context_map_path');
  expect(path?.cliHints?.name).toBe('map-path');
});

test('context-map path operation returns no-match disclosure, no_path disclosure, and direct path results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-path-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const path = operations.find((operation) => operation.name === 'find_context_map_path');

  if (!path) {
    throw new Error('find_context_map_path operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await path.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/note-manifest',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).path).toBeNull();

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

    const direct = await path.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      map_id: built.id,
      from_node_id: 'page:systems/mbrain',
      to_node_id: 'page:concepts/note-manifest',
    });

    expect((direct as any).selection_reason).toBe('direct_map_id');
    expect((direct as any).path?.map_id).toBe(built.id);
    expect((direct as any).path?.hop_count).toBe(2);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
