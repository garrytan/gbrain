import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getMixedScopeDisclosure } from '../src/core/services/mixed-scope-disclosure-service.ts';

test('mixed-scope disclosure service surfaces exportable profile content under explicit mixed scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-disclosure-exportable-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

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
    await buildStructuralContextMapEntry(engine);

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Starts with a written morning reset before deep work.',
      source_refs: ['User, direct message, 2026-04-22 9:03 AM KST'],
      sensitivity: 'personal',
      export_status: 'exportable',
      last_confirmed_at: new Date('2026-04-22T00:03:00.000Z'),
      superseded_by: null,
    });

    const result = await getMixedScopeDisclosure(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect(result.selection_reason).toBe('direct_mixed_scope_bridge');
    expect(result.disclosure?.personal_route_kind).toBe('profile');
    expect(result.disclosure?.personal_visibility).toBe('profile_content_disclosed');
    expect(result.disclosure?.personal_summary_lines).toContain(
      'Personal profile content: Starts with a written morning reset before deep work.',
    );
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope disclosure service withholds private-only profile content while keeping metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-disclosure-private-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

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
    await buildStructuralContextMapEntry(engine);

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'relationship_boundary',
      subject: 'family boundary',
      content: 'Avoid discussing private family conflict during work planning.',
      source_refs: ['User, direct message, 2026-04-22 9:11 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date('2026-04-22T00:11:00.000Z'),
      superseded_by: null,
    });

    const result = await getMixedScopeDisclosure(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'family boundary',
    });

    expect(result.selection_reason).toBe('direct_mixed_scope_bridge');
    expect(result.disclosure?.personal_visibility).toBe('profile_metadata_only');
    expect(result.disclosure?.personal_summary_lines).toContain(
      'Personal profile matched: family boundary (relationship_boundary).',
    );
    expect(result.disclosure?.personal_summary_lines.some((line) => line.includes('Avoid discussing private family conflict'))).toBe(false);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope disclosure service keeps personal episode output metadata-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-disclosure-episode-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

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
    await buildStructuralContextMapEntry(engine);

    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
      candidate_ids: [],
    });

    const result = await getMixedScopeDisclosure(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'episode',
      query: 'mbrain',
      episode_title: 'Morning reset',
    });

    expect(result.selection_reason).toBe('direct_mixed_scope_bridge');
    expect(result.disclosure?.personal_route_kind).toBe('episode');
    expect(result.disclosure?.personal_visibility).toBe('episode_metadata_only');
    expect(result.disclosure?.personal_summary_lines).toContain(
      'Personal episode matched: Morning reset (chat).',
    );
    expect(result.disclosure?.personal_summary_lines.some((line) => line.includes('Re-established the daily routine'))).toBe(false);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope disclosure service returns no disclosure payload when the bridge degrades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-disclosure-degraded-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

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
    await buildStructuralContextMapEntry(engine);

    const result = await getMixedScopeDisclosure(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'missing routine',
    });

    expect(result.selection_reason).toBe('personal_route_no_match');
    expect(result.disclosure).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
