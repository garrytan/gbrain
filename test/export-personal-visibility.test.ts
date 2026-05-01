import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runExport } from '../src/commands/export.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('export command keeps default page export separate from explicit personal export mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-export-personal-visibility-'));
  const databasePath = join(dir, 'brain.db');
  const pageExportDir = join(dir, 'pages-out');
  const personalExportDir = join(dir, 'personal-out');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.putPage('systems/export-boundary', {
      type: 'system',
      title: 'Export Boundary',
      compiled_truth: 'Default export should include this canonical page.',
      timeline: '- 2026-04-22: Added export boundary coverage.',
      frontmatter: { tags: ['export'] },
    });
    await engine.upsertProfileMemoryEntry({
      id: 'profile-exportable',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'exportable',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });
    await engine.upsertProfileMemoryEntry({
      id: 'profile-private',
      scope_id: 'personal:default',
      profile_type: 'stable_fact',
      subject: 'home address',
      content: 'Private location record.',
      source_refs: ['User, direct message, 2026-04-22 9:06 AM KST'],
      sensitivity: 'secret',
      export_status: 'private_only',
      last_confirmed_at: null,
      superseded_by: null,
    });
    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
      candidate_ids: ['profile-exportable'],
    });

    await runExport(engine, ['--dir', pageExportDir]);

    expect(existsSync(join(pageExportDir, 'systems/export-boundary.md'))).toBe(true);
    expect(existsSync(join(pageExportDir, 'personal'))).toBe(false);

    await runExport(engine, ['--dir', personalExportDir, '--personal-export']);

    expect(existsSync(join(personalExportDir, 'systems/export-boundary.md'))).toBe(false);
    expect(existsSync(join(personalExportDir, 'personal/profile-memory/profile-exportable.md'))).toBe(true);
    expect(existsSync(join(personalExportDir, 'personal/profile-memory/profile-private.md'))).toBe(false);
    expect(existsSync(join(personalExportDir, 'personal/personal-episodes'))).toBe(false);

    const exportedProfile = readFileSync(join(personalExportDir, 'personal/profile-memory/profile-exportable.md'), 'utf-8');
    expect(exportedProfile).toContain('daily routine');
    expect(exportedProfile).toContain('Wake at 7 AM, review priorities, then write.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal export rejects profile ids that would escape the export directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-export-personal-traversal-'));
  const databasePath = join(dir, 'brain.db');
  const personalExportDir = join(dir, 'personal-out');
  const escapedPath = join(dir, 'outside.md');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertProfileMemoryEntry({
      id: '../../../outside',
      scope_id: 'personal:default',
      profile_type: 'stable_fact',
      subject: 'unsafe export id',
      content: 'This should not be written outside the export directory.',
      source_refs: ['User, direct message, 2026-04-22 9:08 AM KST'],
      sensitivity: 'personal',
      export_status: 'exportable',
      last_confirmed_at: null,
      superseded_by: null,
    });

    await expect(runExport(engine, ['--dir', personalExportDir, '--personal-export']))
      .rejects.toThrow('Unsafe personal export path');
    expect(existsSync(escapedPath)).toBe(false);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
