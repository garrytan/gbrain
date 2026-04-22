import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

test('context-atlas operations are registered with CLI hints', () => {
  const build = operations.find((operation) => operation.name === 'build_context_atlas');
  const get = operations.find((operation) => operation.name === 'get_context_atlas_entry');
  const list = operations.find((operation) => operation.name === 'list_context_atlas_entries');
  const select = operations.find((operation) => operation.name === 'select_context_atlas_entry');

  expect(build?.cliHints?.name).toBe('atlas-build');
  expect(get?.cliHints?.name).toBe('atlas-get');
  expect(list?.cliHints?.name).toBe('atlas-list');
  expect(select?.cliHints?.name).toBe('atlas-select');
});

test('context-atlas operations expose freshness-aware reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const build = operations.find((operation) => operation.name === 'build_context_atlas');
  const get = operations.find((operation) => operation.name === 'get_context_atlas_entry');
  const list = operations.find((operation) => operation.name === 'list_context_atlas_entries');

  if (!build || !get || !list) {
    throw new Error('context-atlas operations are missing');
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

    const built = await build.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {});

    expect((built as any).freshness).toBe('fresh');

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]] and makes atlas stale.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    const atlasId = 'context-atlas:workspace:workspace:default';
    const entry = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, { id: atlasId });

    const entries = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {});

    expect((entry as any).freshness).toBe('stale');
    expect((entries as any[])[0]?.freshness).toBe('stale');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-atlas operations expose deterministic atlas selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-select-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const select = operations.find((operation) => operation.name === 'select_context_atlas_entry');

  if (!select) {
    throw new Error('select_context_atlas_entry operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertContextMapEntry({
      id: 'context-map:workspace:workspace:default:project:only-stale',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Only Stale Project Map',
      build_mode: 'structural',
      status: 'stale',
      source_set_hash: 'only-stale',
      extractor_version: 'phase2-context-map-v1',
      node_count: 1,
      edge_count: 0,
      community_count: 0,
      graph_json: { nodes: [], edges: [] },
    });
    await engine.upsertContextAtlasEntry({
      id: 'context-atlas:project:workspace:default:only-stale',
      map_id: 'context-map:workspace:workspace:default:project:only-stale',
      scope_id: 'workspace:default',
      kind: 'project',
      title: 'Only Stale Project Atlas',
      freshness: 'stale',
      entrypoints: ['page:systems/mbrain'],
      budget_hint: 2,
    });

    const blocked = await select.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      kind: 'project',
    });

    const allowed = await select.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      kind: 'project',
      allow_stale: true,
    });

    expect((blocked as any).reason).toBe('no_fresh_match');
    expect((blocked as any).entry).toBeNull();
    expect((allowed as any).reason).toBe('selected_stale_match');
    expect((allowed as any).entry?.id).toBe('context-atlas:project:workspace:default:only-stale');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
