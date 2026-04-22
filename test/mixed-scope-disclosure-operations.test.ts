import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('mixed-scope disclosure operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_mixed_scope_disclosure');
  expect(route?.cliHints?.name).toBe('mixed-scope-disclosure');
});

test('mixed-scope disclosure operation returns profile and episode disclosure payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-mixed-scope-disclosure-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_mixed_scope_disclosure');
  if (!route) {
    throw new Error('get_mixed_scope_disclosure operation is missing');
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
      content: 'Starts with a written morning reset before deep work.',
      source_refs: ['User, direct message, 2026-04-22 9:03 AM KST'],
      sensitivity: 'personal',
      export_status: 'exportable',
      last_confirmed_at: new Date('2026-04-22T00:03:00.000Z'),
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
      candidate_ids: [],
    });

    const profile = await route.handler({
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

    expect((profile as any).selection_reason).toBe('direct_mixed_scope_bridge');
    expect((profile as any).disclosure?.personal_visibility).toBe('profile_content_disclosed');

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
    expect((episode as any).disclosure?.personal_visibility).toBe('episode_metadata_only');

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
    expect((degraded as any).disclosure).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
