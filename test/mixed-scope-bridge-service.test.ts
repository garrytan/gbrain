import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getMixedScopeBridge } from '../src/core/services/mixed-scope-bridge-service.ts';

test('mixed-scope bridge service composes one work route and one personal route under explicit mixed scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-direct-'));
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
      '',
      '## Runtime',
      'Coordinates structural extraction.',
      '[Source: User, direct message, 2026-04-22 10:40 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
      '[Source: User, direct message, 2026-04-22 10:41 AM KST]',
    ].join('\n'), { path: 'concepts/note-manifest.md' });

    await buildStructuralContextMapEntry(engine);

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });

    const result = await getMixedScopeBridge(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect(result.selection_reason).toBe('direct_mixed_scope_bridge');
    expect(result.candidate_count).toBe(2);
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.route?.route_kind).toBe('mixed_scope_bridge');
    expect(result.route?.personal_route_kind).toBe('profile');
    expect(result.route?.retrieval_route).toEqual([
      'mixed_scope_gate',
      'work_broad_synthesis',
      'personal_profile_lookup',
      'bounded_cross_scope_bridge',
    ]);
    expect(result.route?.bridge_reason).toBe('explicit_mixed_scope');
    expect(result.route?.work_route.route_kind).toBe('broad_synthesis');
    expect(result.route?.personal_route.route_kind).toBe('personal_profile_lookup');
    expect(result.route?.summary_lines).toContain('Mixed bridge pairs one work route with one personal route.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope bridge service degrades explicitly when the personal route is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-personal-missing-'));
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

    const result = await getMixedScopeBridge(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect(result.selection_reason).toBe('personal_route_no_match');
    expect(result.candidate_count).toBe(1);
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope bridge service degrades explicitly when the work route is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-work-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });

    const result = await getMixedScopeBridge(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect(result.selection_reason).toBe('work_route_no_match');
    expect(result.candidate_count).toBe(1);
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope bridge service composes a work route with an exact personal episode route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-episode-direct-'));
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

    const result = await getMixedScopeBridge(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'episode',
      query: 'mbrain',
      episode_title: 'Morning reset',
    });

    expect(result.selection_reason).toBe('direct_mixed_scope_bridge');
    expect(result.route?.personal_route_kind).toBe('episode');
    expect(result.route?.personal_route.route_kind).toBe('personal_episode_lookup');
    expect(result.route?.retrieval_route).toEqual([
      'mixed_scope_gate',
      'work_broad_synthesis',
      'personal_episode_lookup',
      'bounded_cross_scope_bridge',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed-scope bridge service degrades explicitly when the episode route is ambiguous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-episode-ambiguous-'));
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
    await engine.createPersonalEpisodeEntry({
      id: 'episode-2',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T07:30:00.000Z'),
      end_time: new Date('2026-04-22T08:00:00.000Z'),
      source_kind: 'note',
      summary: 'Documented the same routine after breakfast.',
      source_refs: ['User, direct message, 2026-04-22 9:08 AM KST'],
      candidate_ids: [],
    });

    const result = await getMixedScopeBridge(engine, {
      requested_scope: 'mixed',
      personal_route_kind: 'episode',
      query: 'mbrain',
      episode_title: 'Morning reset',
    });

    expect(result.selection_reason).toBe('personal_route_ambiguous');
    expect(result.candidate_count).toBe(1);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
