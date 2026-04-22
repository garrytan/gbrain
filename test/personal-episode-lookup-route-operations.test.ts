import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('personal episode lookup route operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_personal_episode_lookup_route');
  expect(route?.cliHints?.name).toBe('personal-episode-lookup-route');
});

test('personal episode lookup route operation returns no-match disclosure and direct route payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-route-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_personal_episode_lookup_route');

  if (!route) {
    throw new Error('get_personal_episode_lookup_route operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      title: 'Evening reset',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).route).toBeNull();

    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      candidate_ids: ['profile-1'],
    });

    const direct = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      title: 'Morning reset',
    });

    expect((direct as any).selection_reason).toBe('direct_title_match');
    expect((direct as any).route?.route_kind).toBe('personal_episode_lookup');
    expect((direct as any).route?.personal_episode_id).toBe('episode-1');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
