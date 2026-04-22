import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('mixed-scope bridge operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_mixed_scope_bridge');
  expect(route?.cliHints?.name).toBe('mixed-scope-bridge');
});

test('mixed-scope bridge operation returns direct and degraded disclosures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-bridge-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_mixed_scope_bridge');

  if (!route) {
    throw new Error('get_mixed_scope_bridge operation is missing');
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

    const direct = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect((direct as any).selection_reason).toBe('direct_mixed_scope_bridge');
    expect((direct as any).route?.route_kind).toBe('mixed_scope_bridge');
    expect((direct as any).route?.personal_route_kind).toBe('profile');

    const degraded = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'missing routine',
    });

    expect((degraded as any).selection_reason).toBe('personal_route_no_match');
    expect((degraded as any).route).toBeNull();

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

    const episode = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      requested_scope: 'mixed',
      personal_route_kind: 'episode',
      query: 'mbrain',
      episode_title: 'Morning reset',
    });

    expect((episode as any).selection_reason).toBe('direct_mixed_scope_bridge');
    expect((episode as any).route?.route_kind).toBe('mixed_scope_bridge');
    expect((episode as any).route?.personal_route_kind).toBe('episode');
    expect((episode as any).route?.personal_route?.route_kind).toBe('personal_episode_lookup');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
