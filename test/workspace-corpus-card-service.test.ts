import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getWorkspaceCorpusCard } from '../src/core/services/workspace-corpus-card-service.ts';

test('workspace corpus card service compresses the orientation bundle into a compact card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-corpus-card-'));
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

    const result = await getWorkspaceCorpusCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.card?.card_kind).toBe('workspace_corpus');
    expect(result.card?.anchor_slugs).toEqual(['projects/apollo', 'systems/mbrain']);
    expect(result.card?.recommended_reads.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace corpus card service returns deterministic no-bundle fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-corpus-card-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getWorkspaceCorpusCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.card).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
