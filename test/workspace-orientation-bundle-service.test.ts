import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getWorkspaceOrientationBundle } from '../src/core/services/workspace-orientation-bundle-service.ts';

test('workspace orientation bundle service composes map report and available cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-orientation-bundle-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'projects/apollo', [
      '---',
      'type: project',
      'title: Apollo',
      'repo: meghendra6/apollo',
      'status: active',
      '---',
      '# Overview',
      'Uses [[systems/mbrain]].',
    ].join('\n'), { path: 'projects/apollo.md' });

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      'repo: meghendra6/mbrain',
      'build_command: bun run build',
      'test_command: bun test',
      '---',
      '# Overview',
      'Supports [[projects/apollo]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceOrientationBundle(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.bundle?.bundle_kind).toBe('workspace_orientation');
    expect(result.bundle?.system_card?.system_slug).toBe('systems/mbrain');
    expect(result.bundle?.project_card?.project_slug).toBe('projects/apollo');
    expect(result.bundle?.recommended_reads.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace orientation bundle service returns deterministic no-map fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-orientation-bundle-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getWorkspaceOrientationBundle(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.bundle).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
