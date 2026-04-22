import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { workspaceContextMapId } from '../src/core/services/context-map-service.ts';

test('context-map operations are registered with CLI hints', () => {
  const build = operations.find((operation) => operation.name === 'build_context_map');
  const get = operations.find((operation) => operation.name === 'get_context_map_entry');
  const list = operations.find((operation) => operation.name === 'list_context_map_entries');

  expect(build?.cliHints?.name).toBe('map-build');
  expect(get?.cliHints?.name).toBe('map-get');
  expect(list?.cliHints?.name).toBe('map-list');
});

test('context-map operations disclose stale status on read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const build = operations.find((operation) => operation.name === 'build_context_map');
  const get = operations.find((operation) => operation.name === 'get_context_map_entry');
  const list = operations.find((operation) => operation.name === 'list_context_map_entries');

  if (!build || !get || !list) {
    throw new Error('context-map operations are missing');
  }

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
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    await build.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {});

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and refreshes context maps.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const id = workspaceContextMapId('workspace:default');
    const entry = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, { id });

    const entries = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {});

    expect((entry as any).status).toBe('stale');
    expect((entry as any).stale_reason).toBe('source_set_changed');
    expect((entries as any[])[0]?.status).toBe('stale');
    expect((entries as any[])[0]?.stale_reason).toBe('source_set_changed');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
