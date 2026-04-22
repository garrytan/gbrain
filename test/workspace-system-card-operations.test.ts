import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('workspace-system-card operation is registered with CLI hints', () => {
  const card = operations.find((operation) => operation.name === 'get_workspace_system_card');
  expect(card?.cliHints?.name).toBe('workspace-system-card');
});

test('workspace-system-card operation returns deterministic card payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-system-card-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const card = operations.find((operation) => operation.name === 'get_workspace_system_card');

  if (!card) {
    throw new Error('get_workspace_system_card operation is missing');
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

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      'build_command: bun run build',
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

    const result = await card.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
    });

    expect((result as any).selection_reason).toBe('selected_fresh_match');
    expect((result as any).card?.system_slug).toBe('systems/mbrain');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
