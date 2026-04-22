import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getWorkspaceSystemCard } from '../src/core/services/workspace-system-card-service.ts';

test('workspace system-card service renders canonical system metadata from the current map report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-system-card-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      'repo: meghendra6/mbrain',
      'build_command: bun run build',
      'test_command: bun test',
      'key_entry_points:',
      '  - name: CLI',
      '    path: src/cli.ts',
      '    purpose: Entrypoint for the local command surface',
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

    const result = await getWorkspaceSystemCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('selected_fresh_match');
    expect(result.card?.card_kind).toBe('workspace_system');
    expect(result.card?.system_slug).toBe('systems/mbrain');
    expect(result.card?.repo).toBe('meghendra6/mbrain');
    expect(result.card?.build_command).toBe('bun run build');
    expect(result.card?.test_command).toBe('bun test');
    expect(result.card?.entry_points).toEqual([
      {
        name: 'CLI',
        path: 'src/cli.ts',
        purpose: 'Entrypoint for the local command surface',
      },
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace system-card service returns deterministic no-system fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-system-card-empty-'));
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
      'No system page is present.',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceSystemCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.selection_reason).toBe('no_system_read');
    expect(result.card).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace system-card service finds systems beyond the top report-read limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-workspace-system-card-wide-'));
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

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      'repo: meghendra6/mbrain',
      'build_command: bun run build',
      'test_command: bun test',
      '---',
      '# Overview',
      'System page beyond the first five reads.',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await buildStructuralContextMapEntry(engine);

    const result = await getWorkspaceSystemCard(engine, {
      scope_id: 'workspace:default',
    });

    expect(result.card?.system_slug).toBe('systems/mbrain');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
