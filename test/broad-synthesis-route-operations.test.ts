import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('broad-synthesis route operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_broad_synthesis_route');
  expect(route?.cliHints?.name).toBe('broad-synthesis-route');
});

test('broad-synthesis route operation returns no-match disclosure and direct route payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-broad-synthesis-route-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_broad_synthesis_route');

  if (!route) {
    throw new Error('get_broad_synthesis_route operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      query: 'mbrain',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).route).toBeNull();

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

    const direct = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      query: 'mbrain',
    });

    expect((direct as any).selection_reason).toBe('selected_fresh_match');
    expect((direct as any).route?.route_kind).toBe('broad_synthesis');
    expect((direct as any).route?.focal_node_id).toBe('page:systems/mbrain');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
