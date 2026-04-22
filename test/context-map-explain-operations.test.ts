import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('context-map explain operation is registered with CLI hints', () => {
  const explain = operations.find((operation) => operation.name === 'get_context_map_explanation');
  expect(explain?.cliHints?.name).toBe('map-explain');
});

test('context-map explain operation returns no-match disclosure and direct explanations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-explain-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const explain = operations.find((operation) => operation.name === 'get_context_map_explanation');

  if (!explain) {
    throw new Error('get_context_map_explanation operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await explain.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      node_id: 'page:systems/mbrain',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).explanation).toBeNull();

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

    const direct = await explain.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      map_id: built.id,
      node_id: 'page:systems/mbrain',
    });

    expect((direct as any).selection_reason).toBe('direct_map_id');
    expect((direct as any).explanation?.map_id).toBe(built.id);
    expect((direct as any).explanation?.node_id).toBe('page:systems/mbrain');
    expect((direct as any).explanation?.summary_lines.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
