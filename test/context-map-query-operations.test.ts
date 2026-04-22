import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('context-map query operation is registered with CLI hints', () => {
  const query = operations.find((operation) => operation.name === 'query_context_map');
  expect(query?.cliHints?.name).toBe('map-query');
});

test('context-map query operation returns no-match disclosure and direct query results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-query-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const query = operations.find((operation) => operation.name === 'query_context_map');

  if (!query) {
    throw new Error('query_context_map operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await query.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      query: 'mbrain',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).result).toBeNull();

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

    const direct = await query.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      map_id: built.id,
      query: 'mbrain',
    });

    expect((direct as any).selection_reason).toBe('direct_map_id');
    expect((direct as any).result?.map_id).toBe(built.id);
    expect((direct as any).result?.matched_nodes[0]?.node_id).toBe('page:systems/mbrain');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
