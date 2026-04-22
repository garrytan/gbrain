import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getWorkspaceProjectCard } from '../src/core/services/workspace-project-card-service.ts';

test('workspace project-card service renders canonical project metadata from the current map report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-project-card-'));
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
      '---',
      '# Overview',
      'Supports [[projects/apollo]].',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceProjectCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.card?.card_kind).toBe('workspace_project');
    expect(result.card?.project_slug).toBe('projects/apollo');
    expect(result.card?.path).toBe('projects/apollo.md');
    expect(result.card?.repo).toBe('meghendra6/apollo');
    expect(result.card?.status).toBe('active');
    expect(result.card?.related_systems).toEqual(['systems/mbrain']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace project-card service returns deterministic no-project fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-project-card-empty-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'No project page is present.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceProjectCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_project_read');
    expect(result.card).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace project-card service finds projects beyond the top report-read limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-project-card-wide-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (let index = 0; index < 6; index += 1) {
      await importFromContent(engine, `concepts/filler-${index}`, [
        '---',
        'type: concept',
        `title: Filler ${index}`,
        '---',
        '# Overview',
        `Filler page ${index}.`,
      ].join('\n'), { path: `concepts/filler-${index}.md` });
    }

    await importFromContent(engine, 'projects/apollo', [
      '---',
      'type: project',
      'title: Apollo',
      'repo: meghendra6/apollo',
      'status: active',
      '---',
      '# Overview',
      'Project page beyond the first five reads.',
    ].join('\n'), { path: 'projects/apollo.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceProjectCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.card?.project_slug).toBe('projects/apollo');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
